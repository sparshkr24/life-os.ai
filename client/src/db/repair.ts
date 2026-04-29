/**
 * Best-effort SQLite corruption recovery.
 *
 * Strategy: dump every row we can still SELECT into JS memory, delete the
 * malformed DB file, re-run schema migrations on a fresh file, then
 * re-INSERT the rescued rows. Tables and rows that can't be read are
 * skipped — we count how many survived per table and report it.
 *
 * Why not VACUUM INTO + file rename? expo-file-system isn't installed and
 * expo-sqlite has no public rename API. The dump-rebuild path needs no
 * extra deps and works on the row sizes we actually have on-device
 * (events ~2k rows, everything else ≤ a few hundred). Memory cost ~1 MB.
 *
 * IMPORTANT: caller must stop the Kotlin foreground service BEFORE calling
 * this. Otherwise Kotlin will keep writing to the file we're deleting and
 * we end up with two divergent databases. The Today screen banner handles
 * this ordering before invoking `attemptRepair`.
 */
import * as SQLite from 'expo-sqlite';
import { migrate, reopenDb } from './index';

const DB_NAME = 'lifeos.db';

export interface RepairReport {
  ok: boolean;
  error?: string;
  perTable: Record<string, { rescued: number; failed: number }>;
  totalRescued: number;
  totalFailed: number;
  durationMs: number;
}

export async function attemptRepair(): Promise<RepairReport> {
  const t0 = Date.now();
  const perTable: Record<string, { rescued: number; failed: number }> = {};
  let totalRescued = 0;
  let totalFailed = 0;

  // Open the corrupt DB read-only so a stray write doesn't make things
  // worse. We ignore PRAGMA failures here — the file may be too damaged.
  let src: SQLite.SQLiteDatabase | null = null;
  try {
    await reopenDb();
    src = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
  } catch (e) {
    return {
      ok: false,
      error: 'cannot open corrupt db: ' + (e as Error).message,
      perTable,
      totalRescued: 0,
      totalFailed: 0,
      durationMs: Date.now() - t0,
    };
  }

  // Discover tables. If sqlite_master itself is unreadable we can't proceed.
  let tables: string[];
  try {
    const rows = await src.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );
    tables = rows.map((r) => r.name);
  } catch (e) {
    try { await src.closeAsync(); } catch { /* ignore */ }
    return {
      ok: false,
      error: 'sqlite_master unreadable: ' + (e as Error).message,
      perTable,
      totalRescued: 0,
      totalFailed: 0,
      durationMs: Date.now() - t0,
    };
  }

  // Dump each table page-by-page. A LIMIT/OFFSET sweep lets us skip past
  // a single corrupt page instead of losing the whole table.
  const dump: Record<string, Record<string, unknown>[]> = {};
  const PAGE = 500;
  for (const table of tables) {
    dump[table] = [];
    perTable[table] = { rescued: 0, failed: 0 };
    let offset = 0;
    let consecutiveFailures = 0;
    while (consecutiveFailures < 4) {
      try {
        const rows = await src.getAllAsync<Record<string, unknown>>(
          `SELECT * FROM "${table}" LIMIT ${PAGE} OFFSET ${offset}`,
        );
        if (rows.length === 0) break;
        dump[table].push(...rows);
        perTable[table].rescued += rows.length;
        offset += rows.length;
        consecutiveFailures = 0;
      } catch (e) {
        perTable[table].failed += PAGE;
        consecutiveFailures += 1;
        offset += PAGE;
        console.warn(`[repair] ${table} offset=${offset - PAGE} failed: ${(e as Error).message}`);
      }
    }
    totalRescued += perTable[table].rescued;
    totalFailed += perTable[table].failed;
    console.log(`[repair] dumped ${table}: rescued=${perTable[table].rescued} failed=${perTable[table].failed}`);
  }

  try { await src.closeAsync(); } catch { /* ignore */ }

  // Wipe the file and rebuild from schema.
  try {
    await SQLite.deleteDatabaseAsync(DB_NAME);
  } catch (e) {
    return {
      ok: false,
      error: 'deleteDatabase failed: ' + (e as Error).message,
      perTable,
      totalRescued,
      totalFailed,
      durationMs: Date.now() - t0,
    };
  }

  await reopenDb();
  try {
    await migrate();
  } catch (e) {
    return {
      ok: false,
      error: 'migrate after wipe failed: ' + (e as Error).message,
      perTable,
      totalRescued,
      totalFailed,
      durationMs: Date.now() - t0,
    };
  }

  // Re-insert rescued rows. We use a fresh connection from getDb() (via
  // the migrate() side-effect). Per-row try/catch so a malformed row
  // (e.g. NOT NULL violation in the new schema) doesn't abort the whole
  // table.
  const dest = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
  try {
    for (const table of tables) {
      const rows = dump[table];
      if (rows.length === 0) continue;
      // Skip schema_meta version row — migrate() already wrote the current
      // version. Restoring an older one would mask future migrations.
      for (const row of rows) {
        if (table === 'schema_meta' && row.key === 'version') continue;
        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(',');
        const values = cols.map((c) => row[c] as SQLite.SQLiteBindValue);
        try {
          await dest.runAsync(
            `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders})`,
            values,
          );
        } catch (e) {
          perTable[table].failed += 1;
          console.warn(`[repair] reinsert ${table} row failed: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    try { await dest.closeAsync(); } catch { /* ignore */ }
  }

  await reopenDb();
  return {
    ok: true,
    perTable,
    totalRescued,
    totalFailed,
    durationMs: Date.now() - t0,
  };
}

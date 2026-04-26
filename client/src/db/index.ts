/**
 * Local SQLite lifecycle.
 *
 * The expo-sqlite NativeDatabase is a `SharedRef<NativeDatabaseBinding>`.
 * Under Fast Refresh, or when the Kotlin foreground service has the same
 * file open, the SharedRef can be finalized while our cached JS handle
 * still points to it — every subsequent `execAsync` then rejects with a
 * native NPE ("NativeDatabase.execAsync rejected: NullPointerException").
 *
 * Two defenses here:
 *  1. Open with `useNewConnection: true` to bypass expo-sqlite's native
 *     cache (the zombie source).
 *  2. Wrap every operation in `withDb`: on a NativeDatabase-NPE, drop the
 *     cached handle, reopen, retry once.
 *
 * Outside this file, callers MUST go through `withDb(...)` instead of
 * grabbing `getDb()` directly when running queries that need to survive
 * a stale-ref scenario. The few module-internal callers below use it too.
 */
import * as SQLite from 'expo-sqlite';
import { PHONE_SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { SEED_APP_CATEGORIES, SEED_RULES } from './seed';

const DB_NAME = 'lifeos.db';

let _db: SQLite.SQLiteDatabase | null = null;
let _opening: Promise<SQLite.SQLiteDatabase> | null = null;

async function openOnce(): Promise<SQLite.SQLiteDatabase> {
  // useNewConnection: true sidesteps the native cachedDatabases list, so we
  // never inherit a half-finalized SharedRef from a previous JS module load.
  const db = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
  // PRAGMAs can throw if the DB is locked; retry briefly.
  await execWithBackoff(db, 'PRAGMA journal_mode = WAL;');
  await execWithBackoff(db, 'PRAGMA foreign_keys = ON;');
  return db;
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  if (_opening) return _opening;
  _opening = (async () => {
    let lastErr: unknown = null;
    for (let i = 0; i < 4; i++) {
      try {
        const db = await openOnce();
        _db = db;
        return db;
      } catch (e) {
        lastErr = e;
        await sleep(150 * (i + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  })();
  try {
    return await _opening;
  } finally {
    _opening = null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isStaleRefError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return (
    m.includes('NullPointerException') ||
    m.includes('SharedRef') ||
    m.includes('has been rejected')
  );
}

async function execWithBackoff(db: SQLite.SQLiteDatabase, sql: string): Promise<void> {
  let lastErr: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      await db.execAsync(sql);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(120 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Run a DB operation. If a NativeDatabase NPE / stale SharedRef is observed,
 * drop the cached handle, reopen, and retry exactly once.
 *
 * This is the primary entry point used by repos. Keep it tight: don't put
 * arbitrary business logic in the callback — only DB calls.
 */
export async function withDb<T>(fn: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  let db = await getDb();
  try {
    return await fn(db);
  } catch (e) {
    if (!isStaleRefError(e)) throw e;
    console.warn('[db] stale handle detected, reopening:', (e as Error).message);
    try {
      await _db?.closeAsync().catch(() => {});
    } catch {
      /* ignore */
    }
    _db = null;
    db = await getDb();
    return fn(db);
  }
}

/**
 * Force-close the cached JS connection so the next `withDb` call opens a
 * fresh handle. Use this when you need to read writes made by the Kotlin
 * foreground service from a *separate* SQLiteDatabase connection in the
 * same process: expo-sqlite's long-lived connection can hold a stale WAL
 * read snapshot and miss those external writes until reopened.
 *
 * Cheap to call (open is ~1ms on this device). Don't use in hot loops.
 */
export async function reopenDb(): Promise<void> {
  const old = _db;
  _db = null;
  if (old) {
    try {
      await old.closeAsync();
    } catch (e) {
      console.warn('[db] reopenDb close failed (ignored):', (e as Error).message);
    }
  }
}

/**
 * Runs schema DDL (idempotent) and seeds reference rows on first launch.
 * Safe to call on every app start. Returns the schema version applied.
 *
 * NOTE: We deliberately do NOT wrap the CREATE-TABLEs in withTransactionAsync.
 * Each statement is idempotent and nesting transactions inside the
 * stale-ref-prone path triggered the original NPE.
 */
export async function migrate(): Promise<number> {
  return withDb(async (db) => {
    for (const stmt of PHONE_SCHEMA_SQL) {
      await execWithBackoff(db, stmt);
    }
    const meta = await db.getFirstAsync<{ value: string } | null>(
      `SELECT value FROM schema_meta WHERE key = 'version'`,
    );
    const currentVersion = meta ? Number(meta.value) : 0;
    if (currentVersion < SCHEMA_VERSION) {
      await seedReference(db);
    }
    // v3 additive columns. PRAGMA-guarded so safe on every boot.
    await addColumnIfMissing(db, 'daily_rollup', 'productivity_score', 'REAL');
    await addColumnIfMissing(db, 'nudges_log', 'next_day_score', 'REAL');
    await addColumnIfMissing(db, 'nudges_log', 'baseline_score', 'REAL');
    await addColumnIfMissing(db, 'nudges_log', 'score_delta', 'REAL');
    if (currentVersion < SCHEMA_VERSION) {
      await db.runAsync(
        `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(SCHEMA_VERSION)],
      );
    }
    // Sweep junk app_fg rows on every boot. Cheap (single DELETE) and keeps
    // the events table clean even before the Stage-5 aggregator lands.
    await purgeShortAppFg(db);
    return SCHEMA_VERSION;
  });
}

/**
 * Idempotent ALTER TABLE … ADD COLUMN. expo-sqlite has no IF NOT EXISTS for
 * ADD COLUMN, so we read PRAGMA table_info and skip if already present.
 */
async function addColumnIfMissing(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  decl: string,
): Promise<void> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (rows.some((r) => r.name === column)) return;
  await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
  console.log(`[db] added column ${table}.${column} ${decl}`);
}

/**
 * Deletes `app_fg` rows whose payload duration_ms is below `thresholdMs`.
 * These are sub-second RESUMED/PAUSED noise (sub-activity nav, share sheet
 * pop-ups) — useless for behavior modeling and waste storage.
 *
 * Called on every app boot AND will be called by the Stage-5 aggregator
 * before it builds rollups (so rollups never see this noise either).
 */
export async function purgeShortAppFg(
  db: SQLite.SQLiteDatabase,
  thresholdMs = 1000,
): Promise<number> {
  // SQLite's json_extract is reliable here — payload is always valid JSON.
  const r = await db.runAsync(
    `DELETE FROM events
     WHERE kind = 'app_fg'
       AND CAST(json_extract(payload, '$.duration_ms') AS INTEGER) < ?`,
    [thresholdMs],
  );
  if (r.changes > 0) {
    console.log('[db] purgeShortAppFg: deleted ' + r.changes + ' rows < ' + thresholdMs + 'ms');
  }
  return r.changes;
}

async function seedReference(db: SQLite.SQLiteDatabase): Promise<void> {
  // Sequential, no transaction wrapper — see note in migrate().
  for (const row of SEED_APP_CATEGORIES) {
    await db.runAsync(
      `INSERT INTO app_categories (pkg, category, source) VALUES (?, ?, 'seed')
       ON CONFLICT(pkg) DO NOTHING`,
      [row.pkg, row.category],
    );
  }
  for (const rule of SEED_RULES) {
    await db.runAsync(
      `INSERT INTO rules (id, name, enabled, trigger, action, cooldown_min)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        rule.id,
        rule.name,
        JSON.stringify(rule.trigger),
        JSON.stringify(rule.action),
        rule.cooldown_min,
      ],
    );
  }
}

export interface SchemaSummary {
  tables: string[];
  ruleCount: number;
  appCategoryCount: number;
  schemaVersion: number;
}

/** Used on the boot screen for verification. */
export async function describeDb(): Promise<SchemaSummary> {
  return withDb(async (db) => {
    const tables = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const ruleRow = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM rules`);
    const appRow = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM app_categories`);
    const verRow = await db.getFirstAsync<{ value: string } | null>(
      `SELECT value FROM schema_meta WHERE key = 'version'`,
    );
    return {
      tables: tables.map((t) => t.name),
      ruleCount: ruleRow?.c ?? 0,
      appCategoryCount: appRow?.c ?? 0,
      schemaVersion: verRow ? Number(verRow.value) : 0,
    };
  });
}

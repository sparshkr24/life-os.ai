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

// Set when withDb catches `database disk image is malformed` mid-session.
// Today screen polls `isDbCorrupt()` and shows a banner with a Repair button.
let _corruptDetected = false;
export function isDbCorrupt(): boolean {
  return _corruptDetected;
}
export function clearDbCorrupt(): void {
  _corruptDetected = false;
}

// Migration gate. `migrate()` flips this to a promise that resolves once
// every CREATE TABLE statement has run. `withDb` awaits it on every call so
// repos / screens that fire DB queries during the boot useEffect can't race
// ahead of the schema and hit "no such table" errors.
let _migrationGate: Promise<void> | null = null;
let _migrationDone = false;

async function openOnce(): Promise<SQLite.SQLiteDatabase> {
  // useNewConnection: true sidesteps the native cachedDatabases list, so we
  // never inherit a half-finalized SharedRef from a previous JS module load.
  const db = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
  // PRAGMAs can throw if the DB is locked; retry briefly.
  // Rollback-journal (the SQLite default) — NOT WAL. We share lifeos.db
  // with the Kotlin foreground service which uses Android's bundled SQLite
  // (different patch level). WAL's `-shm` file format is implementation-
  // specific, so two engines checkpointing the same WAL eventually corrupt
  // the file. Rollback journal has no shared memory format → safe to share.
  await execWithBackoff(db, 'PRAGMA journal_mode = DELETE;');
  // 5 s busy timeout: if Kotlin holds the write lock momentarily, wait
  // instead of throwing SQLITE_BUSY. Cheap; no effect when lock is free.
  await execWithBackoff(db, 'PRAGMA busy_timeout = 5000;');
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

/**
 * SQLITE_IOERR (`disk I/O error`) is usually transient on Android: the WAL
 * checkpoint thread or the Kotlin FG service held the page cache mid-write
 * and our read landed in the gap. A reopen + short backoff clears it.
 * If it's a *real* disk failure, the second attempt fails the same way and
 * we surface the error to the caller.
 */
function isTransientIoError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message.toLowerCase();
  return m.includes('disk i/o error') || m.includes('sqlite_ioerr') || m.includes('database is locked');
}

/**
 * SQLITE_CORRUPT — the on-disk file is physically damaged (page corruption,
 * partial write killed mid-fsync, etc). This is NOT recoverable by a reopen.
 * The only fix is to delete the file and let `migrate()` rebuild from the
 * schema. Caller (`migrate`) detects this on first boot pass and triggers
 * the reset flow.
 *
 * We DON'T auto-reset inside `withDb`: silently nuking user data on every
 * read is dangerous. Reset must happen explicitly at boot, after which the
 * app surfaces a "data was reset, raw events lost" notice.
 */
export function isDatabaseCorruptError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message.toLowerCase();
  return (
    m.includes('database disk image is malformed') ||
    m.includes('sqlite_corrupt') ||
    m.includes('not a database') ||
    m.includes('file is not a database')
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
  // Block until migration has finished. The `migrate()` call itself bypasses
  // this (it's the producer of the gate) by going through `withDbUnsafe`.
  if (_migrationGate && !_migrationDone) {
    await _migrationGate;
  }
  return withDbUnsafe(fn);
}

/**
 * Same as `withDb` but skips the migration gate. ONLY for use by `migrate()`
 * itself — calling `withDb` from inside `migrate` would deadlock since the
 * gate doesn't resolve until migrate returns.
 */
async function withDbUnsafe<T>(fn: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  let db = await getDb();
  try {
    return await fn(db);
  } catch (e) {
    if (isDatabaseCorruptError(e)) {
      // Mid-session corruption (rare with WAL off, but file-system or
      // process-kill-mid-fsync can still produce this). Set the global flag
      // so the UI can surface a "Repair database" banner. We DO NOT auto-
      // wipe — that would silently destroy days of behavior data. The
      // existing boot-time recovery path still handles "DB unusable on
      // app start"; this branch is for "DB went bad while running".
      _corruptDetected = true;
      console.error('[db] CORRUPT detected mid-session:', (e as Error).message);
      throw e;
    }
    const stale = isStaleRefError(e);
    const ioErr = isTransientIoError(e);
    if (!stale && !ioErr) throw e;
    console.warn(
      `[db] ${stale ? 'stale handle' : 'transient I/O'} detected, reopening:`,
      (e as Error).message,
    );
    try {
      await _db?.closeAsync().catch(() => {});
    } catch {
      /* ignore */
    }
    _db = null;
    if (ioErr) await sleep(120);
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
 * Last-resort recovery for SQLITE_CORRUPT. Closes our handle, deletes the
 * database file (and -wal / -shm sidecars via expo's deleteDatabaseAsync),
 * then a subsequent `getDb()` recreates an empty file that `migrate()` fills
 * from the schema. ALL user data is lost — events, rollups, profile,
 * memories, llm_calls. This is only called from `migrate()` after a corrupt
 * error during the first boot pass.
 *
 * The Kotlin FG service must be torn down BEFORE this runs, otherwise it
 * keeps writing to the file we just deleted and we end up with two divergent
 * SQLite files. App.tsx handles that ordering.
 */
export async function resetCorruptDatabase(): Promise<void> {
  console.warn('[db] CORRUPT — wiping database and rebuilding schema');
  try {
    await _db?.closeAsync().catch(() => {});
  } catch {
    /* ignore */
  }
  _db = null;
  _opening = null;
  try {
    await SQLite.deleteDatabaseAsync(DB_NAME);
  } catch (e) {
    console.warn('[db] deleteDatabaseAsync threw (continuing):', (e as Error).message);
  }
}

/**
 * Runs schema DDL (idempotent) and seeds reference rows on first launch.
 * Safe to call on every app start. Returns the schema version applied.
 *
 * Recovery: if the underlying DB file is corrupt (SQLITE_CORRUPT), wipe it
 * and retry once. The second attempt runs against a freshly created file.
 *
 * NOTE: We deliberately do NOT wrap the CREATE-TABLEs in withTransactionAsync.
 * Each statement is idempotent and nesting transactions inside the
 * stale-ref-prone path triggered the original NPE.
 */
export async function migrate(): Promise<number> {
  // Install the gate synchronously so any concurrent `withDb` call queued
  // before this awaits immediately starts blocking. Even if migrate throws,
  // we resolve the gate so the rest of the app doesn't deadlock — callers
  // will fail naturally on the missing table and surface the real error.
  let resolveGate!: () => void;
  _migrationGate = new Promise<void>((res) => {
    resolveGate = res;
  });
  _migrationDone = false;
  try {
    let v: number;
    try {
      v = await runMigrate();
    } catch (e) {
      if (!isDatabaseCorruptError(e)) throw e;
      await resetCorruptDatabase();
      v = await runMigrate();
    }
    _migrationDone = true;
    return v;
  } finally {
    resolveGate();
  }
}

async function runMigrate(): Promise<number> {
  return withDbUnsafe(async (db) => {
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
    // v2-retroactive: nudges_log gained reasoning/level/llm_call_id but the
    // table existed in v1, so CREATE TABLE IF NOT EXISTS no-ops on upgrade.
    await addColumnIfMissing(db, 'nudges_log', 'source', "TEXT NOT NULL DEFAULT 'rule'");
    await addColumnIfMissing(db, 'nudges_log', 'rule_id', 'TEXT');
    await addColumnIfMissing(db, 'nudges_log', 'llm_call_id', 'INTEGER');
    await addColumnIfMissing(db, 'nudges_log', 'reasoning', "TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing(db, 'nudges_log', 'level', 'INTEGER NOT NULL DEFAULT 1');
    await addColumnIfMissing(db, 'nudges_log', 'next_day_score', 'REAL');
    await addColumnIfMissing(db, 'nudges_log', 'baseline_score', 'REAL');
    await addColumnIfMissing(db, 'nudges_log', 'score_delta', 'REAL');
    await addColumnIfMissing(db, 'nudges_log', 'user_helpful', 'INTEGER');
    // v5 — app_categories enrichment fields (LLM nightly enrichment + auto-discovery).
    await addColumnIfMissing(db, 'app_categories', 'subcategory', 'TEXT');
    await addColumnIfMissing(
      db,
      'app_categories',
      'enriched',
      'INTEGER NOT NULL DEFAULT 0',
    );
    await addColumnIfMissing(db, 'app_categories', 'last_categorized_ts', 'INTEGER');
    await addColumnIfMissing(db, 'app_categories', 'details', 'TEXT');
    // v6 — rules columns for LLM-generated rules (Stage 14).
    await addColumnIfMissing(db, 'rules', 'source', "TEXT NOT NULL DEFAULT 'user'");
    await addColumnIfMissing(db, 'rules', 'predicted_impact_score', 'REAL');
    await addColumnIfMissing(db, 'rules', 'based_on_memory_ids', 'TEXT');
    await addColumnIfMissing(db, 'rules', 'disabled_reason', 'TEXT');
    await addColumnIfMissing(db, 'rules', 'last_refined_ts', 'INTEGER');
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

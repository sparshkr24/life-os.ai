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
      await db.runAsync(
        `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(SCHEMA_VERSION)],
      );
    }
    return SCHEMA_VERSION;
  });
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

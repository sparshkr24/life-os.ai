/**
 * Raw-event cleanup pipeline. Single source of truth for "what to do after
 * collectors have written, but before rollups read".
 *
 * Why this exists:
 *   Collectors (Kotlin foreground service + Sleep/Activity/Geofence/Notif
 *   receivers) write events as they arrive, with minimal filtering. They
 *   can't see the full history at write time and don't run any cross-row
 *   logic. Without a cleanup pass:
 *     - sub-second `app_fg` rows from RESUMED/PAUSED storms dominate counts
 *     - "android" / launcher / settings rows we forgot to denylist leak in
 *     - service restarts produce two `app_fg` rows for the same continuous
 *       session because the in-memory dedup window resets
 *
 * `cleanupRawEvents()` runs every aggregator tick (once per 15 min) BEFORE
 * `rebuildDailyRollup`. Order matters: noise → merge → purge. Each rule is
 * idempotent and bounded (deletes/updates only, no inserts).
 *
 * Add new rules here, NOT in collectors. Collectors stay dumb.
 */
import type * as SQLite from 'expo-sqlite';
import { withDb, purgeShortAppFg } from '../db';

/**
 * Packages we never want in `events`. Kotlin already filters most of these
 * at write time; this catches OEM variants discovered after the fact, and
 * scrubs rows written before a denylist update shipped.
 */
const NOISE_PKGS = new Set<string>([
  'android', // the OS itself
  // launchers
  'com.android.launcher',
  'com.android.launcher3',
  'com.google.android.apps.nexuslauncher',
  'com.miui.home',
  'com.sec.android.app.launcher',
  'com.oneplus.launcher',
  'com.oppo.launcher',
  'com.realme.launcher',
  'com.huawei.android.launcher',
  // settings / OS surfaces
  'com.android.settings',
  'com.android.systemui',
  'com.android.intentresolver',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
]);

/**
 * Pkgs that count as a real app launch but should NOT be picked as
 * "the first thing the user opened after waking" — the user didn't choose
 * them, they auto-fired. Used by aggWakeFirstApp.
 */
export const WAKE_NOISE_PKGS = new Set<string>([
  // launchers
  'com.android.launcher',
  'com.android.launcher3',
  'com.google.android.apps.nexuslauncher',
  'com.miui.home',
  'com.sec.android.app.launcher',
  'com.oneplus.launcher',
  'com.oppo.launcher',
  'com.realme.launcher',
  'com.huawei.android.launcher',
  // alarm clocks (open themselves on alarm fire)
  'com.google.android.deskclock',
  'com.android.deskclock',
  'com.sec.android.app.clockpackage',
  'com.oneplus.deskclock',
  'com.coloros.alarmclock',
  // dialer auto-opens on incoming call
  'com.android.dialer',
  'com.google.android.dialer',
  // lock screen / unlock UI
  'com.android.systemui',
]);

/** If two app_fg sessions for the same pkg are within this gap, merge them. */
const MERGE_GAP_MS = 90_000;

/** Sub-N rows are dropped as RESUMED/PAUSED noise. */
const SHORT_THRESHOLD_MS = 1000;

export interface CleanupReport {
  noiseDeleted: number;
  shortDeleted: number;
  merged: number;
  durationMs: number;
}

export async function cleanupRawEvents(): Promise<CleanupReport> {
  const t0 = Date.now();
  let noiseDeleted = 0;
  let shortDeleted = 0;
  let merged = 0;

  await withDb(async (db) => {
    noiseDeleted = await purgeNoisePkgs(db);
    merged = await mergeAdjacentAppFg(db);
    shortDeleted = await purgeShortAppFg(db, SHORT_THRESHOLD_MS);
  });

  const dt = Date.now() - t0;
  if (noiseDeleted + merged + shortDeleted > 0) {
    console.log(
      `[ingest] cleanup noise=${noiseDeleted} merged=${merged} ` +
        `short=${shortDeleted} in ${dt}ms`,
    );
  }
  return { noiseDeleted, shortDeleted, merged, durationMs: dt };
}

async function purgeNoisePkgs(db: SQLite.SQLiteDatabase): Promise<number> {
  const placeholders = [...NOISE_PKGS].map(() => '?').join(',');
  const r = await db.runAsync(
    `DELETE FROM events
     WHERE kind = 'app_fg'
       AND json_extract(payload, '$.pkg') IN (${placeholders})`,
    [...NOISE_PKGS],
  );
  return r.changes;
}

/**
 * Walks app_fg rows in chronological order; whenever two consecutive rows
 * for the same pkg sit within MERGE_GAP_MS, the later row is folded into
 * the earlier one (extending end_ts/duration_ms) and deleted. Idempotent.
 *
 * Bounded: only looks at the last 24h of rows. Older sessions are settled.
 */
async function mergeAdjacentAppFg(db: SQLite.SQLiteDatabase): Promise<number> {
  const since = Date.now() - 24 * 3600_000;
  const rows = await db.getAllAsync<{
    id: number;
    pkg: string;
    start_ts: number;
    end_ts: number;
  }>(
    `SELECT id,
            json_extract(payload, '$.pkg') AS pkg,
            CAST(json_extract(payload, '$.start_ts') AS INTEGER) AS start_ts,
            CAST(json_extract(payload, '$.end_ts')   AS INTEGER) AS end_ts
     FROM events
     WHERE kind = 'app_fg' AND ts >= ?
     ORDER BY ts ASC`,
    [since],
  );

  // Per-pkg state: last "open" row we may extend.
  const open = new Map<string, { id: number; start_ts: number; end_ts: number }>();
  let merged = 0;

  for (const r of rows) {
    if (!r.pkg) continue;
    const cur = open.get(r.pkg);
    if (!cur) {
      open.set(r.pkg, { id: r.id, start_ts: r.start_ts, end_ts: r.end_ts });
      continue;
    }
    if (r.start_ts - cur.end_ts <= MERGE_GAP_MS) {
      const newEnd = Math.max(cur.end_ts, r.end_ts);
      const dur = Math.max(0, newEnd - cur.start_ts);
      await db.runAsync(
        `UPDATE events
         SET payload = json_set(
           json_set(
             json_set(payload, '$.end_ts', ?),
             '$.duration_ms', ?
           ),
           '$.start_ts', ?
         )
         WHERE id = ?`,
        [newEnd, dur, cur.start_ts, cur.id],
      );
      await db.runAsync(`DELETE FROM events WHERE id = ?`, [r.id]);
      cur.end_ts = newEnd;
      merged += 1;
    } else {
      open.set(r.pkg, { id: r.id, start_ts: r.start_ts, end_ts: r.end_ts });
    }
  }
  return merged;
}

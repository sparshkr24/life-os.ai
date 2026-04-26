/**
 * Daily rollup builder. Pure SQL aggregation over `events` for one local day.
 * UPSERTs into `daily_rollup`. Idempotent — safe to call repeatedly per tick.
 *
 * One file by design: this is a single logical responsibility (turn raw
 * events into one `daily_rollup` row matching docs/ARCHITECTURE.md §3.5).
 * Splitting it would just hide the orchestration. Keep helpers local.
 *
 * Anything we can't compute deterministically (deviations_from_baseline)
 * is left empty; the nightly LLM populates those fields.
 */
import type * as SQLite from 'expo-sqlite';
import { localDayStartMs, localHour, prevDate, nextDate } from './time';
import type { AppCategory } from '../db/schema';

// ────────────────────────────────────────────────────────────────────────────
// Output shape
// ────────────────────────────────────────────────────────────────────────────

export interface AppAgg {
  pkg: string;
  minutes: number;
  sessions: number;
  category: AppCategory;
}

export interface SleepAgg {
  start: string | null;
  end: string | null;
  start_ts: number | null;
  end_ts: number | null;
  duration_min: number;
  confidence: number;
}

interface PlaceAgg {
  id: string;
  minutes: number;
}

interface SilenceAgg {
  start_ts: number;
  end_ts: number;
  duration_min: number;
  place_id: string | null;
  label: string;
  basis: string;
  confidence: number;
  user_confirmed: boolean;
}

export interface DailyRollupData {
  date: string;
  sleep: SleepAgg;
  wake_first_app: string | null;
  first_pickup_min_after_wake: number | null;
  screen_on_minutes: number;
  by_app: AppAgg[];
  by_category: Record<AppCategory, number>;
  by_hour: Record<string, Partial<Record<AppCategory, number>>>;
  late_night_screen_min: number;
  places: PlaceAgg[];
  transitions: string[];
  steps: number;
  active_minutes: number;
  todos: { created: number; completed: number };
  nudges: { fired: number; acted: number; dismissed: number };
  silences: SilenceAgg[];
  deviations_from_baseline: never[];
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

export async function rebuildDailyRollup(
  db: SQLite.SQLiteDatabase,
  date: string,
  tz: string,
): Promise<DailyRollupData> {
  const dayStart = localDayStartMs(date, tz);
  const dayEnd = dayStart + 24 * 3600_000;

  const apps = await aggApps(db, dayStart, dayEnd);
  const byCategory = sumByCategory(apps);
  const byHour = await aggByHour(db, dayStart, dayEnd, tz, apps);
  const lateNight = await aggLateNight(db, date, tz);
  const places = await aggPlaces(db, dayStart, dayEnd);
  const transitions = await aggTransitions(db, dayStart, dayEnd);
  const stepsTotal = await aggSteps(db, dayStart, dayEnd);
  const activeMin = await aggActiveMinutes(db, dayStart, dayEnd);
  const sleep = await aggSleep(db, dayStart, tz);
  const wake = await aggWakeFirstApp(db, sleep, dayStart, dayEnd);
  const todos = await aggTodos(db, dayStart, dayEnd);
  const nudges = await aggNudges(db, dayStart, dayEnd);
  const silences = await aggSilences(db, dayStart, dayEnd);
  const screenOnMin = apps.reduce((s, a) => s + a.minutes, 0);

  const data: DailyRollupData = {
    date,
    sleep,
    wake_first_app: wake.firstApp,
    first_pickup_min_after_wake: wake.minAfterWake,
    screen_on_minutes: screenOnMin,
    by_app: apps,
    by_category: byCategory,
    by_hour: byHour,
    late_night_screen_min: lateNight,
    places,
    transitions,
    steps: stepsTotal,
    active_minutes: activeMin,
    todos,
    nudges,
    silences,
    deviations_from_baseline: [],
  };

  await db.runAsync(
    `INSERT INTO daily_rollup (date, data, updated_ts)
     VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_ts = excluded.updated_ts`,
    [date, JSON.stringify(data), Date.now()],
  );
  return data;
}

// ────────────────────────────────────────────────────────────────────────────
// App aggregations (UsageStats → app_fg events)
// ────────────────────────────────────────────────────────────────────────────

export async function aggApps(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<AppAgg[]> {
  const rows = await db.getAllAsync<{ pkg: string; minutes: number; sessions: number }>(
    `SELECT
        json_extract(payload, '$.pkg') AS pkg,
        SUM(MAX(0, CAST(json_extract(payload, '$.duration_ms') AS INTEGER))) / 60000.0
          AS minutes,
        COUNT(*) AS sessions
     FROM events
     WHERE kind = 'app_fg'
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) >= ?
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) <  ?
     GROUP BY pkg
     ORDER BY minutes DESC`,
    [dayStart, dayEnd],
  );
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(',');
  const cats = await db.getAllAsync<{ pkg: string; category: AppCategory }>(
    `SELECT pkg, category FROM app_categories WHERE pkg IN (${placeholders})`,
    rows.map((r) => r.pkg),
  );
  const catMap = new Map(cats.map((c) => [c.pkg, c.category]));
  return rows.map((r) => ({
    pkg: r.pkg,
    minutes: Math.round(r.minutes),
    sessions: r.sessions,
    category: catMap.get(r.pkg) ?? 'neutral',
  }));
}

function sumByCategory(apps: AppAgg[]): Record<AppCategory, number> {
  const out: Record<AppCategory, number> = { productive: 0, neutral: 0, unproductive: 0 };
  for (const a of apps) out[a.category] += a.minutes;
  return out;
}

async function aggByHour(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
  tz: string,
  apps: AppAgg[],
): Promise<Record<string, Partial<Record<AppCategory, number>>>> {
  const catByPkg = new Map(apps.map((a) => [a.pkg, a.category]));
  const rows = await db.getAllAsync<{ start_ts: number; end_ts: number; pkg: string }>(
    `SELECT
        CAST(json_extract(payload, '$.start_ts') AS INTEGER) AS start_ts,
        CAST(json_extract(payload, '$.end_ts')   AS INTEGER) AS end_ts,
        json_extract(payload, '$.pkg') AS pkg
     FROM events
     WHERE kind = 'app_fg'
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) >= ?
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) <  ?`,
    [dayStart, dayEnd],
  );
  const out: Record<string, Partial<Record<AppCategory, number>>> = {};
  for (const r of rows) {
    if (r.end_ts <= r.start_ts) continue;
    const cat = catByPkg.get(r.pkg) ?? 'neutral';
    let cursor = r.start_ts;
    while (cursor < r.end_ts) {
      const hourBoundary = cursor + (60 - (cursor % 3600_000) / 60_000) * 60_000;
      const hourEnd = Math.min(r.end_ts, hourBoundary);
      const minutes = Math.round((hourEnd - cursor) / 60_000);
      if (minutes > 0) {
        const h = String(localHour(cursor, tz)).padStart(2, '0');
        const slot = (out[h] ??= {});
        slot[cat] = (slot[cat] ?? 0) + minutes;
      }
      cursor = hourEnd;
    }
  }
  return out;
}

/** Late-night (local 21:00 → 02:00 next day) total app_fg minutes. */
async function aggLateNight(
  db: SQLite.SQLiteDatabase,
  date: string,
  tz: string,
): Promise<number> {
  const start = localDayStartMs(date, tz) + 21 * 3600_000;
  const end = localDayStartMs(date, tz) + 26 * 3600_000;
  const r = await db.getFirstAsync<{ ms: number | null }>(
    `SELECT SUM(MAX(0, MIN(?, CAST(json_extract(payload, '$.end_ts') AS INTEGER))
                       - MAX(?, CAST(json_extract(payload, '$.start_ts') AS INTEGER)))) AS ms
     FROM events
     WHERE kind = 'app_fg'
       AND CAST(json_extract(payload, '$.end_ts')   AS INTEGER) > ?
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) < ?`,
    [end, start, start, end],
  );
  return Math.round(((r?.ms ?? 0) as number) / 60_000);
}

// ────────────────────────────────────────────────────────────────────────────
// Sleep + wake
// ────────────────────────────────────────────────────────────────────────────

async function aggSleep(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  tz: string,
): Promise<SleepAgg> {
  const winStart = dayStart - 12 * 3600_000;
  const winEnd = dayStart + 14 * 3600_000;
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM events
     WHERE kind = 'sleep' AND ts >= ? AND ts < ?
       AND json_extract(payload, '$.kind') = 'segment'`,
    [winStart, winEnd],
  );
  let best: { start: number; end: number; conf: number } | null = null;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { start_ts?: number; end_ts?: number };
      if (typeof p.start_ts !== 'number' || typeof p.end_ts !== 'number') continue;
      if (p.end_ts <= p.start_ts) continue;
      const dur = p.end_ts - p.start_ts;
      if (!best || dur > best.end - best.start) {
        best = { start: p.start_ts, end: p.end_ts, conf: 0.85 };
      }
    } catch {
      /* ignore malformed row */
    }
  }
  if (!best) {
    return { start: null, end: null, start_ts: null, end_ts: null, duration_min: 0, confidence: 0 };
  }
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return {
    start: fmt.format(new Date(best.start)),
    end: fmt.format(new Date(best.end)),
    start_ts: best.start,
    end_ts: best.end,
    duration_min: Math.round((best.end - best.start) / 60_000),
    confidence: best.conf,
  };
}

async function aggWakeFirstApp(
  db: SQLite.SQLiteDatabase,
  sleep: SleepAgg,
  dayStart: number,
  dayEnd: number,
): Promise<{ firstApp: string | null; minAfterWake: number | null }> {
  const wakeTs = sleep.end_ts ?? dayStart;
  const r = await db.getFirstAsync<{ pkg: string; ts: number } | null>(
    `SELECT json_extract(payload, '$.pkg') AS pkg,
            CAST(json_extract(payload, '$.start_ts') AS INTEGER) AS ts
     FROM events
     WHERE kind = 'app_fg'
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) >= ?
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) <  ?
     ORDER BY ts ASC LIMIT 1`,
    [wakeTs, dayEnd],
  );
  if (!r) return { firstApp: null, minAfterWake: null };
  const minAfter = sleep.end_ts ? Math.round((r.ts - sleep.end_ts) / 60_000) : null;
  return { firstApp: r.pkg, minAfterWake: minAfter };
}

// ────────────────────────────────────────────────────────────────────────────
// Geo / activity / steps / todos / nudges / silences
// ────────────────────────────────────────────────────────────────────────────

async function aggPlaces(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<PlaceAgg[]> {
  const rows = await db.getAllAsync<{ ts: number; kind: string; payload: string }>(
    `SELECT ts, kind, payload FROM events
     WHERE ts >= ? AND ts < ? AND kind IN ('geo_enter','geo_exit')
     ORDER BY ts ASC`,
    [dayStart, dayEnd],
  );
  const totals = new Map<string, number>();
  let openId: string | null = null;
  let openTs = dayStart;
  // Carry-over: if the last transition before dayStart was an ENTER, the
  // user is still inside that place at midnight.
  const prior = await db.getFirstAsync<{ kind: string; payload: string } | null>(
    `SELECT kind, payload FROM events
     WHERE ts < ? AND kind IN ('geo_enter','geo_exit')
     ORDER BY ts DESC LIMIT 1`,
    [dayStart],
  );
  if (prior && prior.kind === 'geo_enter') openId = parsePlaceId(prior.payload);

  for (const r of rows) {
    const placeId = parsePlaceId(r.payload);
    if (r.kind === 'geo_enter') {
      if (openId) totals.set(openId, (totals.get(openId) ?? 0) + (r.ts - openTs));
      openId = placeId;
      openTs = r.ts;
    } else {
      if (openId) totals.set(openId, (totals.get(openId) ?? 0) + (r.ts - openTs));
      openId = null;
    }
  }
  if (openId) totals.set(openId, (totals.get(openId) ?? 0) + (dayEnd - openTs));
  return [...totals.entries()]
    .map(([id, ms]) => ({ id, minutes: Math.round(ms / 60_000) }))
    .filter((p) => p.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
}

function parsePlaceId(payload: string): string | null {
  try {
    const p = JSON.parse(payload) as { place_id?: unknown };
    return typeof p.place_id === 'string' ? p.place_id : null;
  } catch {
    return null;
  }
}

async function aggTransitions(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<string[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM events
     WHERE ts >= ? AND ts < ? AND kind = 'geo_enter'
     ORDER BY ts ASC`,
    [dayStart, dayEnd],
  );
  const out: string[] = [];
  for (const r of rows) {
    const id = parsePlaceId(r.payload);
    if (id && out[out.length - 1] !== id) out.push(id);
  }
  return out;
}

async function aggSteps(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<number> {
  const r = await db.getFirstAsync<{ n: number | null }>(
    `SELECT SUM(CAST(json_extract(payload, '$.count') AS INTEGER)) AS n
     FROM events
     WHERE kind = 'steps'
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) >= ?
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) <  ?`,
    [dayStart, dayEnd],
  );
  return r?.n ?? 0;
}

async function aggActiveMinutes(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<number> {
  const rows = await db.getAllAsync<{ ts: number; payload: string }>(
    `SELECT ts, payload FROM events
     WHERE ts >= ? AND ts < ? AND kind = 'activity'
     ORDER BY ts ASC`,
    [dayStart, dayEnd],
  );
  const moving = new Set(['ON_FOOT', 'WALKING', 'RUNNING', 'ON_BICYCLE']);
  let total = 0;
  let openTs: number | null = null;
  for (const r of rows) {
    let act = '';
    let dir = '';
    try {
      const p = JSON.parse(r.payload) as { activity?: string; direction?: string };
      act = p.activity ?? '';
      dir = p.direction ?? '';
    } catch {
      continue;
    }
    if (!moving.has(act)) continue;
    if (dir === 'ENTER') {
      if (openTs == null) openTs = r.ts;
    } else if (dir === 'EXIT' && openTs != null) {
      total += r.ts - openTs;
      openTs = null;
    }
  }
  if (openTs != null) total += dayEnd - openTs;
  return Math.round(total / 60_000);
}

async function aggTodos(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<{ created: number; completed: number }> {
  const c = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM todos WHERE created_ts >= ? AND created_ts < ?`,
    [dayStart, dayEnd],
  );
  const d = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM todos
     WHERE done_ts IS NOT NULL AND done_ts >= ? AND done_ts < ?`,
    [dayStart, dayEnd],
  );
  return { created: c?.n ?? 0, completed: d?.n ?? 0 };
}

async function aggNudges(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<{ fired: number; acted: number; dismissed: number }> {
  const r = await db.getFirstAsync<{ fired: number; acted: number; dismissed: number }>(
    `SELECT
       COUNT(*) AS fired,
       SUM(CASE WHEN user_action = 'acted'     THEN 1 ELSE 0 END) AS acted,
       SUM(CASE WHEN user_action = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
     FROM nudges_log WHERE ts >= ? AND ts < ?`,
    [dayStart, dayEnd],
  );
  return { fired: r?.fired ?? 0, acted: r?.acted ?? 0, dismissed: r?.dismissed ?? 0 };
}

async function aggSilences(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
  dayEnd: number,
): Promise<SilenceAgg[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM events
     WHERE kind = 'inferred_activity' AND ts >= ? AND ts < ?
     ORDER BY ts ASC`,
    [dayStart, dayEnd],
  );
  const out: SilenceAgg[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload) as SilenceAgg);
    } catch {
      /* ignore malformed row */
    }
  }
  return out;
}

export { prevDate, nextDate };

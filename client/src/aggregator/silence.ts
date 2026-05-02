/**
 * Silence classifier — converts gaps in the active-event stream into
 * `inferred_activity` events the rest of the system can read.
 *
 * Runs from the aggregator worker (Stage 5) once per tick for `today` and
 * once for `yesterday` until yesterday is sealed. No new background job.
 *
 * Heuristic (see docs gap analysis §UC2):
 *   - night silence (>=60 min, last+next at home, hours 21–07) -> sleep_or_rest
 *   - office-hours silence (>=45 min, location=office, hours 09–18) -> focused_work
 *   - silence inside a 'gym' geofence -> workout
 *   - else >=60 min daytime gap -> unknown (rule engine prompts the user)
 *
 * Idempotent: deletes prior auto-written rows for the day before re-inserting,
 * but preserves rows the user has confirmed (`user_confirmed: true`).
 */
import type * as SQLite from 'expo-sqlite';
import { localDayStartMs, localHour } from './time';

const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 7;
const OFFICE_START_HOUR = 9;
const OFFICE_END_HOUR = 18;
const GAP_MS_MIN = 60 * 60_000;
const OFFICE_GAP_MS_MIN = 45 * 60_000;

export type SilenceLabel =
  | 'sleep_or_rest'
  | 'focused_work'
  | 'workout'
  | 'unknown';

export type SilenceBasis =
  | 'night_silence'
  | 'office_silence'
  | 'gym_silence'
  | 'daytime_unknown';

export interface Silence {
  start_ts: number;
  end_ts: number;
  duration_min: number;
  place_id: string | null;
  label: SilenceLabel;
  basis: SilenceBasis;
  confidence: number;
}

interface InferredActivityPayload extends Silence {
  user_confirmed: boolean;
}

/**
 * Classify silences for the local day `date` ('YYYY-MM-DD') in IANA tz `tz`.
 * Returns the silences it wrote.
 */
export async function classifySilences(
  db: SQLite.SQLiteDatabase,
  date: string,
  tz: string,
): Promise<Silence[]> {
  const dayStart = localDayStartMs(date, tz);
  const dayEnd = dayStart + 24 * 3600_000;

  // Wipe prior auto-classification for this day (keep user-confirmed rows).
  await db.runAsync(
    `DELETE FROM events
     WHERE kind = 'inferred_activity'
       AND ts >= ? AND ts < ?
       AND COALESCE(CAST(json_extract(payload, '$.user_confirmed') AS INTEGER), 0) = 0`,
    [dayStart, dayEnd],
  );

  // Active-event stream for the day.
  const rows = await db.getAllAsync<{ ts: number }>(
    `SELECT ts FROM events
     WHERE ts >= ? AND ts < ?
       AND kind IN ('app_fg','screen_on','activity','geo_enter','geo_exit')
     ORDER BY ts ASC`,
    [dayStart, dayEnd],
  );

  const silences: Silence[] = [];
  let cursor = dayStart;
  for (const r of rows) {
    if (r.ts - cursor >= GAP_MS_MIN) {
      const s = await classifyGap(db, cursor, r.ts, tz);
      if (s) silences.push(s);
    }
    if (r.ts > cursor) cursor = r.ts;
  }
  if (dayEnd - cursor >= GAP_MS_MIN) {
    const s = await classifyGap(db, cursor, dayEnd, tz);
    if (s) silences.push(s);
  }

  for (const s of silences) {
    const payload: InferredActivityPayload = { ...s, user_confirmed: false };
    await db.runAsync(
      `INSERT INTO events (ts, kind, payload) VALUES (?, 'inferred_activity', ?)`,
      [s.start_ts, JSON.stringify(payload)],
    );
  }
  return silences;
}

async function classifyGap(
  db: SQLite.SQLiteDatabase,
  start: number,
  end: number,
  tz: string,
): Promise<Silence | null> {
  const startHour = localHour(start, tz);
  const endHour = localHour(end, tz);
  const dur = end - start;
  const placeId = await placeAt(db, start);

  const isNight = startHour >= NIGHT_START_HOUR || endHour <= NIGHT_END_HOUR;
  if (isNight && placeId === 'home' && dur >= GAP_MS_MIN) {
    return mk(start, end, placeId, 'sleep_or_rest', 'night_silence', 0.85);
  }
  if (
    placeId === 'office' &&
    startHour >= OFFICE_START_HOUR &&
    endHour <= OFFICE_END_HOUR &&
    dur >= OFFICE_GAP_MS_MIN
  ) {
    return mk(start, end, placeId, 'focused_work', 'office_silence', 0.75);
  }
  if (placeId === 'gym' && dur >= GAP_MS_MIN) {
    return mk(start, end, placeId, 'workout', 'gym_silence', 0.8);
  }
  if (dur >= GAP_MS_MIN) {
    return mk(start, end, placeId, 'unknown', 'daytime_unknown', 0.3);
  }
  return null;
}

function mk(
  start_ts: number,
  end_ts: number,
  place_id: string | null,
  label: SilenceLabel,
  basis: SilenceBasis,
  confidence: number,
): Silence {
  return {
    start_ts,
    end_ts,
    duration_min: Math.round((end_ts - start_ts) / 60_000),
    place_id,
    label,
    basis,
    confidence,
  };
}

/**
 * Last geofence transition before `ts`. Returns the place id when the most
 * recent transition was an enter; null on exit / no data.
 */
async function placeAt(db: SQLite.SQLiteDatabase, ts: number): Promise<string | null> {
  const r = await db.getFirstAsync<{ kind: string; payload: string } | null>(
    `SELECT kind, payload FROM events
     WHERE ts <= ? AND kind IN ('geo_enter','geo_exit')
     ORDER BY ts DESC LIMIT 1`,
    [ts],
  );
  if (!r) return null;
  if (r.kind !== 'geo_enter') return null;
  try {
    const p = JSON.parse(r.payload) as { place_id?: unknown };
    return typeof p.place_id === 'string' ? p.place_id : null;
  } catch {
    return null;
  }
}

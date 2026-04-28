/**
 * Raw-event loader for the nightly memory pass.
 *
 * The memory pass is the ONE LLM call that sees primary evidence (CLAUDE.md
 * §7). This module turns yesterday's `events` rows into a compact, sorted,
 * line-per-event timeline the model can read end-to-end without us dropping
 * fidelity.
 *
 * Format per line (one event per line, time-ordered ascending):
 *
 *   HH:MM:SS [kind/source] <payload-json-as-stamped>
 *
 * The payload is left untouched on purpose — every Kotlin writer already
 * stamps the `_ctx` ambient block (place_id / batt / charging / net / audio)
 * onto it via `PhoneState.stamp`, so each line is fully self-describing.
 *
 * Volume control: hard cap at MAX_EVENTS_FOR_MEMORY. When over, drop the
 * lowest-signal `app_fg` rows (shortest durations) first — every other event
 * kind is rare and informative. We never silently truncate other kinds.
 */
import { withDb } from '../db';
import type { EventRow } from '../db/schema';
import { deviceTz, localDayStartMs, nextDate } from '../aggregator/time';

export const MAX_EVENTS_FOR_MEMORY = 2000;
const APP_FG_DROP_THRESHOLD_MS = 30_000;

export interface RawEventTimeline {
  date: string;
  totalEvents: number;
  emittedEvents: number;
  droppedAppFg: number;
  truncated: boolean;
  lines: string[];
}

/**
 * Load every event for the local day `date` (YYYY-MM-DD), apply the volume
 * cap, return one compact line per event. Sorted ascending by ts.
 */
export async function loadRawEventsForDate(date: string): Promise<RawEventTimeline> {
  const tz = deviceTz();
  const startMs = localDayStartMs(date, tz);
  const endMs = localDayStartMs(nextDate(date), tz);
  type Row = Pick<EventRow, 'ts' | 'kind' | 'payload'>;

  const rows = await withDb<Row[]>(async (db) =>
    db.getAllAsync<Row>(
      `SELECT ts, kind, payload FROM events
       WHERE ts >= ? AND ts < ?
       ORDER BY ts ASC`,
      [startMs, endMs],
    ),
  );

  const totalEvents = rows.length;
  const dropped = capByDroppingShortAppFg(rows, MAX_EVENTS_FOR_MEMORY);
  const truncated = rows.length < totalEvents;

  const lines = rows.map(formatEventLine);

  return {
    date,
    totalEvents,
    emittedEvents: rows.length,
    droppedAppFg: dropped,
    truncated,
    lines,
  };
}

interface RawRow {
  ts: number;
  kind: string;
  payload: string;
}

/** Mutates `rows` in place. Returns count of `app_fg` rows dropped. */
function capByDroppingShortAppFg(rows: RawRow[], cap: number): number {
  if (rows.length <= cap) return 0;

  const overBy = rows.length - cap;
  const candidateIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind === 'app_fg')
    .map(({ row, index }) => ({ index, durationMs: extractDurationMs(row.payload) }))
    .filter((entry) => entry.durationMs !== null && entry.durationMs < APP_FG_DROP_THRESHOLD_MS)
    .sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0))
    .slice(0, overBy)
    .map((entry) => entry.index)
    .sort((a, b) => b - a); // delete from the back

  for (const index of candidateIndexes) {
    rows.splice(index, 1);
  }

  // If we still exceed the cap (rare — heavy non-app_fg day), trim the
  // oldest events. This is a last-resort guard, not a normal path.
  while (rows.length > cap) rows.shift();
  return candidateIndexes.length;
}

function extractDurationMs(payload: string): number | null {
  try {
    const parsed = JSON.parse(payload) as { dur?: unknown; duration_ms?: unknown };
    if (typeof parsed.dur === 'number') return parsed.dur;
    if (typeof parsed.duration_ms === 'number') return parsed.duration_ms;
    return null;
  } catch {
    return null;
  }
}

function formatEventLine(row: RawRow): string {
  const time = formatLocalTime(row.ts);
  return `${time} [${row.kind}] ${row.payload}`;
}

function formatLocalTime(ts: number): string {
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Geocode worker — drains `place_visit` rows whose payload has
 * `status='pending_geocode'`. Runs once per aggregator tick (15 min).
 *
 * Per row:
 *   1. Reverse-geocode (lat, lng) via Nominatim (cached 24h).
 *   2. Update the row's payload with name / category / confidence.
 *   3. If confidence ≥ AUTO_PROMOTE_THRESHOLD: auto-create a `places`
 *      row with `kind='auto'` (so future visits trigger the cheap
 *      geofence path instead of another Nominatim call) and stamp
 *      the row's payload with the new place_id.
 *   4. If confidence < AUTO_PROMOTE_THRESHOLD: fire a `place_name`
 *      proactive question so the user can name the place. Their
 *      answer flows through `applyProactiveAnswer`, which already
 *      auto-creates a `places` row from `(suggested_lat, suggested_lng)`.
 */
import type * as SQLite from 'expo-sqlite';
import { withDb } from '../db';
import { addPlace } from '../repos/places';
import { reverseGeocode } from './geocoder';
import { fireProactiveQuestionNotification } from '../rules/proactiveNotify';

function uuid(): string {
  // Lightweight RFC4122-ish v4 \u2014 enough for primary-key uniqueness in
  // a single-user local DB.
  const r = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  return `${r()}-${r().slice(0, 4)}-4${r().slice(0, 3)}-a${r().slice(0, 3)}-${r()}${r().slice(0, 4)}`;
}

const AUTO_PROMOTE_THRESHOLD = 0.8;
const ASK_USER_THRESHOLD = 0.6;
/** Don't process more than N rows per tick — keep a single tick bounded. */
const MAX_PER_TICK = 5;

interface PendingRow {
  id: number;
  ts: number;
  payload: string;
}

interface PlaceVisitPayload {
  arrival_ts: number;
  departure_ts: number;
  duration_ms?: number;
  lat: number;
  lng: number;
  status: 'pending_geocode' | 'geocoded' | 'failed' | 'ignored';
  source: string;
  name: string | null;
  category: string | null;
  confidence: number | null;
  place_id?: string | null;
}

export interface GeocodeWorkerReport {
  processed: number;
  promoted: number;
  asked: number;
  failed: number;
  durationMs: number;
}

export async function processPendingPlaceVisits(): Promise<GeocodeWorkerReport> {
  const t0 = Date.now();
  const rows = await loadPending();
  let processed = 0;
  let promoted = 0;
  let asked = 0;
  let failed = 0;

  for (const row of rows) {
    let payload: PlaceVisitPayload;
    try {
      payload = JSON.parse(row.payload) as PlaceVisitPayload;
    } catch {
      await markFailed(row.id, 'bad_payload');
      failed++;
      continue;
    }
    try {
      const result = await reverseGeocode(payload.lat, payload.lng);
      const updated: PlaceVisitPayload = {
        ...payload,
        name: result.name,
        category: result.category,
        confidence: result.confidence,
        status: 'geocoded',
      };

      // Auto-promote high-confidence venues to a real geofenced place so
      // future visits don't re-geocode.
      if (result.confidence >= AUTO_PROMOTE_THRESHOLD && result.name) {
        try {
          const place = await addPlace({
            label: result.name,
            lat: payload.lat,
            lng: payload.lng,
            kind: 'auto',
            confidence: result.confidence,
            category: result.category ?? undefined,
          });
          updated.place_id = place.id;
          promoted++;
          console.log(
            `[geocodeWorker] auto-place id=${place.id} "${result.name}" confidence=${result.confidence}`,
          );
        } catch (e) {
          console.error(
            '[geocodeWorker] addPlace failed:',
            e instanceof Error ? e.message : String(e),
          );
        }
      } else if (result.confidence < ASK_USER_THRESHOLD) {
        // Low confidence — ask the user to name this place. The answer flow
        // (applyProactiveAnswer) will create a manual place at these coords.
        const fired = await fireLowConfidencePlaceQuestion(
          payload.lat,
          payload.lng,
          result.name,
        );
        if (fired) asked++;
      }

      await updatePayload(row.id, updated);
      processed++;
    } catch (e) {
      console.error(
        '[geocodeWorker] row failed:',
        e instanceof Error ? e.message : String(e),
      );
      await markFailed(row.id, 'exception');
      failed++;
    }
  }

  const durationMs = Date.now() - t0;
  if (processed + failed > 0) {
    console.log(
      `[geocodeWorker] processed=${processed} promoted=${promoted} asked=${asked} failed=${failed} in ${durationMs}ms`,
    );
  }
  return { processed, promoted, asked, failed, durationMs };
}

async function loadPending(): Promise<PendingRow[]> {
  return withDb((db) =>
    db.getAllAsync<PendingRow>(
      `SELECT id, ts, payload FROM events
       WHERE kind = 'place_visit'
         AND json_extract(payload, '$.status') = 'pending_geocode'
       ORDER BY ts ASC
       LIMIT ?`,
      [MAX_PER_TICK],
    ),
  );
}

async function updatePayload(id: number, payload: PlaceVisitPayload): Promise<void> {
  await withDb((db) =>
    db.runAsync(`UPDATE events SET payload = ? WHERE id = ?`, [JSON.stringify(payload), id]),
  );
}

async function markFailed(id: number, reason: string): Promise<void> {
  await withDb(async (db) => {
    const row = await db.getFirstAsync<{ payload: string }>(
      `SELECT payload FROM events WHERE id = ?`,
      [id],
    );
    let next: Partial<PlaceVisitPayload> = { status: 'failed' };
    if (row?.payload) {
      try {
        next = { ...(JSON.parse(row.payload) as PlaceVisitPayload), status: 'failed' };
      } catch {
        /* fall through with bare status */
      }
    }
    await db.runAsync(`UPDATE events SET payload = ? WHERE id = ?`, [
      JSON.stringify({ ...next, fail_reason: reason }),
      id,
    ]);
  });
}

/**
 * Fire a low-confidence "what is this place?" question. Mirrors the
 * persistence done by `maybeRunProactiveQuestion` but without the LLM
 * draft step \u2014 we know exactly what to ask.
 *
 * Reuses the existing `place_name` notification category so the answer
 * flow auto-creates a manual `places` row at (suggested_lat, suggested_lng).
 */
async function fireLowConfidencePlaceQuestion(
  lat: number,
  lng: number,
  guessedName: string | null,
): Promise<boolean> {
  // Skip if there's already a pending question. The user can only handle
  // one at a time and stacking notifications hurts trust.
  const pending = await withDb((db) =>
    db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM proactive_questions WHERE status = 'pending'`,
    ),
  );
  if ((pending?.n ?? 0) > 0) return false;

  const id = uuid();
  const now = Date.now();
  const prompt = guessedName
    ? `You stayed a while at "${guessedName}". Want to save it as a place?`
    : `You stayed a while at an unknown spot. What is this place?`;
  const options: string[] = guessedName ? [guessedName, 'Other', 'No'] : ['Other', 'No'];

  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO proactive_questions
         (id, ts, trigger_kind, trigger_payload, prompt, options, expected_kind,
          suggested_lat, suggested_lng, status, llm_call_id)
       VALUES (?, ?, 'long_dwell_unknown', ?, ?, ?, 'place_name', ?, ?, 'pending', NULL)`,
      [
        id,
        now,
        JSON.stringify({ lat, lng, source: 'geocode_low_confidence' }),
        prompt,
        JSON.stringify(options),
        lat,
        lng,
      ],
    );
    await db.runAsync(
      `INSERT INTO events (ts, kind, payload) VALUES (?, 'ai_question', ?)`,
      [
        now,
        JSON.stringify({ question_id: id, trigger_kind: 'long_dwell_unknown', prompt }),
      ],
    );
  });

  try {
    const notifId = await fireProactiveQuestionNotification({
      id,
      prompt,
      options,
      expectedKind: 'place_name',
    });
    if (notifId) {
      await withDb((db) =>
        db.runAsync(`UPDATE proactive_questions SET notification_id = ? WHERE id = ?`, [
          notifId,
          id,
        ]),
      );
    }
  } catch (e) {
    console.error(
      '[geocodeWorker] notify failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
  console.log(`[geocodeWorker] asked id=${id} prompt="${prompt}"`);
  return true;
}

/**
 * Close any open `place_visit` rows whose dwell never ended (service
 * killed mid-dwell). Used by the ingest cleanup pipeline.
 */
export async function closeOrphanedOpenPlaceVisits(
  db: SQLite.SQLiteDatabase,
  now: number,
): Promise<number> {
  // "Open" means departure_ts == arrival_ts (we never updated it). Cap at
  // 24h \u2014 anything older is junk we'll never close cleanly.
  const cutoff = now - 24 * 3600_000;
  const rows = await db.getAllAsync<{ id: number; payload: string }>(
    `SELECT id, payload FROM events
     WHERE kind = 'place_visit'
       AND ts < ?
       AND CAST(json_extract(payload, '$.arrival_ts') AS INTEGER)
         = CAST(json_extract(payload, '$.departure_ts') AS INTEGER)`,
    [cutoff],
  );
  let closed = 0;
  for (const r of rows) {
    let parsed: PlaceVisitPayload;
    try {
      parsed = JSON.parse(r.payload) as PlaceVisitPayload;
    } catch {
      continue;
    }
    parsed.departure_ts = parsed.arrival_ts + 24 * 3600_000;
    parsed.duration_ms = parsed.departure_ts - parsed.arrival_ts;
    await db.runAsync(`UPDATE events SET payload = ? WHERE id = ?`, [
      JSON.stringify({ ...parsed, truncated: true }),
      r.id,
    ]);
    closed++;
  }
  return closed;
}

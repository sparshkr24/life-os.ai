/**
 * Predictive insights for "today".
 *
 * Pure RAG over the memory store — no generation LLM call. Reads today's
 * `daily_rollup`, builds a natural-language query that summarises what the
 * user has done so far, retrieves the top-k similar past memories, and
 * stores the result inside `daily_rollup.data.predictive_insights`.
 *
 * Cost: one embed call (~$0.00001) + an in-process cosine scan. Throttled
 * to once per ~90 min per local date — see `MIN_INTERVAL_MS`.
 *
 * Read by [client/src/screens/RollupsScreen.tsx](client/src/screens/RollupsScreen.tsx)
 * straight from the rollup JSON; never re-run on render.
 */
import type * as SQLite from 'expo-sqlite';
import { retrieveContext } from '../memory/rag';

const MIN_INTERVAL_MS = 90 * 60 * 1000;
const TOP_K = 5;
const META_KEY_PREFIX = 'last_predictive_insights_ts:';

export interface PredictiveInsight {
  memory_id: string;
  type: string;
  summary: string;
  cause: string | null;
  effect: string | null;
  impact_score: number;
  confidence: number;
  similarity: number;
}

export interface PredictiveInsightsBlock {
  generated_ts: number;
  query: string;
  insights: PredictiveInsight[];
}

/**
 * Idempotent. Skips when last run for `date` was < 90 min ago, or when the
 * rollup row is missing, or when the embed call fails (cost cap / no key).
 * Never throws — failures are logged and the rollup is left untouched.
 */
export async function maybeRebuildPredictiveInsights(
  db: SQLite.SQLiteDatabase,
  date: string,
): Promise<{ ran: boolean; reason?: string; count?: number }> {
  const now = Date.now();
  const metaKey = META_KEY_PREFIX + date;

  const last = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM schema_meta WHERE key = ?`,
    [metaKey],
  );
  if (last && now - Number(last.value) < MIN_INTERVAL_MS) {
    return { ran: false, reason: 'throttled' };
  }

  const row = await db.getFirstAsync<{ data: string; productivity_score: number | null }>(
    `SELECT data, productivity_score FROM daily_rollup WHERE date = ?`,
    [date],
  );
  if (!row) return { ran: false, reason: 'no rollup' };

  let rollup: Record<string, unknown>;
  try {
    rollup = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return { ran: false, reason: 'rollup parse failed' };
  }

  const queryText = buildQueryFromRollup(rollup, row.productivity_score, now);
  if (!queryText) return { ran: false, reason: 'no signal yet' };

  const rag = await retrieveContext({
    decisionType: 'prediction_update',
    queryText,
    k: TOP_K,
  });
  if (!rag.embedded) {
    // embed cost-capped or failed; leave existing block in place
    return { ran: false, reason: 'embed unavailable' };
  }

  const block: PredictiveInsightsBlock = {
    generated_ts: now,
    query: queryText,
    insights: rag.memories.map((r) => ({
      memory_id: r.memory.id,
      type: r.memory.type,
      summary: r.memory.summary,
      cause: r.memory.cause,
      effect: r.memory.effect,
      impact_score: r.memory.impact_score,
      confidence: r.memory.confidence,
      similarity: r.similarity,
    })),
  };

  rollup.predictive_insights = block;
  await db.runAsync(
    `UPDATE daily_rollup SET data = ?, updated_ts = ? WHERE date = ?`,
    [JSON.stringify(rollup), now, date],
  );
  await db.runAsync(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [metaKey, String(now)],
  );
  return { ran: true, count: block.insights.length };
}

/**
 * Build a query string the embedding model can match against past memories.
 * Includes the things that vary day-to-day and tend to predict outcomes:
 * top apps, screen-on, late-night use, sleep, place spread, current
 * time-of-day, and the running productivity score.
 */
function buildQueryFromRollup(
  rollup: Record<string, unknown>,
  score: number | null,
  now: number,
): string {
  const parts: string[] = [];

  const hour = new Date(now).getHours();
  parts.push(`Time of day: ${describeHour(hour)} (${hour}:00).`);

  const screenMin = numField(rollup, 'screen_on_minutes');
  if (screenMin > 0) {
    parts.push(`So far ${Math.round(screenMin)} min of screen time.`);
  }

  const lateNight = numField(rollup, 'late_night_screen_min');
  if (lateNight > 0) {
    parts.push(`${Math.round(lateNight)} min of late-night phone use.`);
  }

  const sleep = (rollup.sleep ?? null) as { duration_min?: number } | null;
  if (sleep && typeof sleep.duration_min === 'number' && sleep.duration_min > 0) {
    parts.push(`Slept ${(sleep.duration_min / 60).toFixed(1)}h last night.`);
  }

  const firstPickup = numField(rollup, 'first_pickup_min_after_wake');
  if (firstPickup > 0) {
    parts.push(`First phone pickup ${firstPickup} min after waking.`);
  }

  const apps = (rollup.by_app ?? []) as { pkg: string; minutes: number; category: string }[];
  const topApps = apps.filter((a) => a.minutes >= 5).slice(0, 4);
  if (topApps.length > 0) {
    parts.push(
      'Top apps so far: ' +
        topApps.map((a) => `${a.pkg} (${Math.round(a.minutes)}m, ${a.category})`).join(', ') +
        '.',
    );
  }

  const cats = (rollup.by_category ?? {}) as Record<string, number>;
  const catLine = Object.entries(cats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${Math.round(v)}m`)
    .join(', ');
  if (catLine) parts.push(`Category split: ${catLine}.`);

  const places = (rollup.places ?? []) as { id: string; minutes: number }[];
  if (places.length > 0) {
    parts.push(
      'Places: ' +
        places
          .slice(0, 3)
          .map((p) => `${p.id} (${Math.round(p.minutes)}m)`)
          .join(', ') +
        '.',
    );
  }

  const active = numField(rollup, 'active_minutes');
  if (active > 0) parts.push(`${Math.round(active)} min active movement.`);

  if (score !== null) {
    parts.push(`Running productivity score: ${Math.round(score * 100)}%.`);
  }

  parts.push(
    'What patterns from past days resemble this, and what did they lead to later in the day, that night, the next day, or that week?',
  );

  return parts.join(' ');
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function describeHour(h: number): string {
  if (h < 5) return 'late night';
  if (h < 11) return 'morning';
  if (h < 14) return 'midday';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

/**
 * Compute next-day-impact metrics for nudges fired on `forDate`.
 *
 * Runs in the nightly job AFTER yesterday's `productivity_score` has been
 * finalised, BEFORE Sonnet is called. Pure SQL, no LLM.
 *
 *   next_day_score = daily_rollup.productivity_score for forDate+1
 *   baseline_score = median productivity_score over the 7 days preceding ts
 *                    (excluding forDate itself)
 *   score_delta    = next_day_score - baseline_score
 *
 * Idempotent: re-running overwrites the same rows.
 */
import type * as SQLite from 'expo-sqlite';

export async function computeNudgeEffectiveness(
  db: SQLite.SQLiteDatabase,
  forDate: string,
): Promise<number> {
  const next = await db.getFirstAsync<{ s: number | null } | null>(
    `SELECT productivity_score AS s
     FROM daily_rollup
     WHERE date = date(?, '+1 day')`,
    [forDate],
  );

  const baselineRows = await db.getAllAsync<{ s: number }>(
    `SELECT productivity_score AS s
     FROM daily_rollup
     WHERE date < ?
       AND date >= date(?, '-7 day')
       AND productivity_score IS NOT NULL
     ORDER BY productivity_score ASC`,
    [forDate, forDate],
  );
  const baselineMedian = median(baselineRows.map((r) => r.s));

  const nextScore = next?.s ?? null;
  const delta =
    nextScore != null && baselineMedian != null ? nextScore - baselineMedian : null;

  const r = await db.runAsync(
    `UPDATE nudges_log
     SET next_day_score = ?,
         baseline_score = ?,
         score_delta    = ?
     WHERE date(ts/1000, 'unixepoch', 'localtime') = ?
       AND user_action IS NOT NULL`,
    [nextScore, baselineMedian, delta, forDate],
  );
  return r.changes;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

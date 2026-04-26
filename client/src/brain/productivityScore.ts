/**
 * Deterministic per-day productivity score in [0,1].
 *
 * No LLM. Reads `daily_rollup.data` JSON for `date`, computes 5 components,
 * UPDATEs `daily_rollup.productivity_score` in place. Idempotent.
 *
 * Components and weights (read this; tuning is a one-line change):
 *   sleep   30%   sleep.duration_min: 360 -> 0.0, 480+ -> 1.0
 *   focus   25%   (productive - unproductive) / 480, centred on 0.5
 *   wake    15%   first_pickup_min_after_wake / 30, capped at 1.0
 *   move    15%   active_minutes / 60, capped at 1.0
 *   nudge   15%   acted/fired; 0.5 if no nudges fired
 *
 * Called by the aggregator (Stage 5) at the end of every rebuild for that day,
 * and by the nightly job for yesterday before Sonnet runs.
 */
import type * as SQLite from 'expo-sqlite';

export async function computeProductivityScore(
  db: SQLite.SQLiteDatabase,
  date: string,
): Promise<number | null> {
  await db.runAsync(
    `UPDATE daily_rollup
     SET productivity_score = (
       WITH parts AS (
         SELECT
           MIN(1.0, MAX(0.0,
             (CAST(json_extract(data, '$.sleep.duration_min') AS REAL) - 360.0) / 120.0
           )) AS s_sleep,
           MIN(1.0, MAX(0.0, 0.5 +
             (COALESCE(CAST(json_extract(data, '$.by_category.productive')   AS REAL), 0.0)
            - COALESCE(CAST(json_extract(data, '$.by_category.unproductive') AS REAL), 0.0)
             ) / 480.0
           )) AS s_focus,
           MIN(1.0, MAX(0.0,
             COALESCE(CAST(json_extract(data, '$.first_pickup_min_after_wake') AS REAL), 0.0) / 30.0
           )) AS s_wake,
           MIN(1.0, MAX(0.0,
             COALESCE(CAST(json_extract(data, '$.active_minutes') AS REAL), 0.0) / 60.0
           )) AS s_move,
           CASE
             WHEN COALESCE(CAST(json_extract(data, '$.nudges.fired') AS REAL), 0.0) = 0.0 THEN 0.5
             ELSE MIN(1.0, MAX(0.0,
               CAST(json_extract(data, '$.nudges.acted') AS REAL) /
               CAST(json_extract(data, '$.nudges.fired') AS REAL)
             ))
           END AS s_nudge
         FROM daily_rollup WHERE date = ?
       )
       SELECT ROUND(0.30*s_sleep + 0.25*s_focus + 0.15*s_wake + 0.15*s_move + 0.15*s_nudge, 3)
       FROM parts
     )
     WHERE date = ?`,
    [date, date],
  );
  const row = await db.getFirstAsync<{ s: number | null }>(
    `SELECT productivity_score AS s FROM daily_rollup WHERE date = ?`,
    [date],
  );
  return row?.s ?? null;
}

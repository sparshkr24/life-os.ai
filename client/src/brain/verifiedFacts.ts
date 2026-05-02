/**
 * Pre-computed correlations the nightly Sonnet prompt receives as
 * VERIFIED_FACTS. The LLM may quote these numbers but never invent new ones.
 *
 * Add a new fact = add a new SQL block here + a new entry in the prompt's
 * VERIFIED_FACTS slot. SQL must always be deterministic.
 */
import type * as SQLite from 'expo-sqlite';
import type { SilenceCorrelation } from './behaviorProfile.types';

/**
 * "low phone night" = days where total app_fg minutes between local 21:00
 * and 02:00 was < 30. Compares the day-after productivity_score for those
 * vs. all other days (last 90 days window).
 *
 * Requires `daily_rollup.data.late_night_screen_min` to be populated by the
 * aggregator. Returns null if there are < 5 samples on either side
 * — the profile pass then omits the correlation rather than narrating noise.
 */
export async function lowPhoneNightCorrelation(
  db: SQLite.SQLiteDatabase,
): Promise<SilenceCorrelation | null> {
  const r = await db.getFirstAsync<{
    avg_low: number | null;
    avg_other: number | null;
    n_low: number;
    n_other: number;
  } | null>(
    `WITH low_phone AS (
       SELECT date(d.date, '+1 day') AS impact_date
       FROM daily_rollup d
       WHERE d.date >= date('now','-90 day')
         AND CAST(json_extract(d.data, '$.late_night_screen_min') AS REAL) < 30
     ),
     other AS (
       SELECT date(d.date, '+1 day') AS impact_date
       FROM daily_rollup d
       WHERE d.date >= date('now','-90 day')
         AND CAST(json_extract(d.data, '$.late_night_screen_min') AS REAL) >= 30
     )
     SELECT
       (SELECT AVG(productivity_score) FROM daily_rollup
         WHERE date IN (SELECT impact_date FROM low_phone)
           AND productivity_score IS NOT NULL) AS avg_low,
       (SELECT AVG(productivity_score) FROM daily_rollup
         WHERE date IN (SELECT impact_date FROM other)
           AND productivity_score IS NOT NULL) AS avg_other,
       (SELECT COUNT(*) FROM daily_rollup
         WHERE date IN (SELECT impact_date FROM low_phone)
           AND productivity_score IS NOT NULL) AS n_low,
       (SELECT COUNT(*) FROM daily_rollup
         WHERE date IN (SELECT impact_date FROM other)
           AND productivity_score IS NOT NULL) AS n_other`,
  );
  if (!r || r.avg_low == null || r.avg_other == null) return null;
  if (r.n_low < 5 || r.n_other < 5) return null;
  if (r.avg_other === 0) return null;

  const deltaPct = ((r.avg_low - r.avg_other) / r.avg_other) * 100;
  return {
    predictor: 'low_phone_night',
    definition:
      'Days where total app_fg between 21:00 and 02:00 (local) was less than 30 minutes.',
    n_days: r.n_low + r.n_other,
    delta_next_day_score_pct: Math.round(deltaPct * 10) / 10,
    p_value_or_method: `median diff, n_low=${r.n_low} vs n_other=${r.n_other}`,
  };
}

/**
 * Build the full VERIFIED_FACTS block for tonight's Sonnet call. Add new
 * fact functions to this list; nulls are filtered out.
 */
export async function buildVerifiedFacts(
  db: SQLite.SQLiteDatabase,
): Promise<SilenceCorrelation[]> {
  const facts: (SilenceCorrelation | null)[] = [
    await lowPhoneNightCorrelation(db),
  ];
  return facts.filter((f): f is SilenceCorrelation => f != null);
}

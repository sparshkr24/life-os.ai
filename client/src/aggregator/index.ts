/**
 * Aggregator orchestrator. One entry point: `runAggregatorTick()`.
 * Called every 15 min by the background worker (worker.ts) and on demand
 * from the Today screen (debug button).
 *
 * Per tick:
 *   1. purgeShortAppFg            — drop sub-1s app_fg noise rows
 *   2. classifySilences(today)    — write/refresh inferred_activity events
 *   3. classifySilences(yesterday)— same, in case the day rolled over
 *   4. rebuildDailyRollup(today)  — incl. silence counts
 *   5. rebuildDailyRollup(yest)
 *   6. computeProductivityScore   — for both days
 *   7. once per UTC day: foldMonth(prev month) — cheap, idempotent
 */
import { withDb, purgeShortAppFg } from '../db';
import { computeProductivityScore } from '../brain/productivityScore';
import { rebuildDailyRollup } from './rollup';
import { classifySilences } from './silence';
import { foldMonth } from './monthlyFold';
import { runRulesOnceFromBackground } from '../rules/worker';
import { deviceTz, localDateStr, localMonthStr, prevDate } from './time';

const META_KEY_LAST_FOLD = 'last_monthly_fold_date';
const META_KEY_LAST_TICK = 'last_aggregator_ts';

export interface TickReport {
  ok: boolean;
  ranAt: number;
  today: string;
  yesterday: string;
  silencesToday: number;
  silencesYesterday: number;
  scoreToday: number | null;
  scoreYesterday: number | null;
  monthFolded: string | null;
  durationMs: number;
  error?: string;
}

export async function runAggregatorTick(): Promise<TickReport> {
  const t0 = Date.now();
  const tz = deviceTz();
  const today = localDateStr(t0, tz);
  const yesterday = prevDate(today);

  try {
    return await withDb(async (db) => {
      await purgeShortAppFg(db, 1000);

      const silToday = await classifySilences(db, today, tz);
      const silYest = await classifySilences(db, yesterday, tz);

      await rebuildDailyRollup(db, today, tz);
      await rebuildDailyRollup(db, yesterday, tz);

      const scoreToday = await computeProductivityScore(db, today);
      const scoreYesterday = await computeProductivityScore(db, yesterday);

      const monthFolded = await maybeFoldMonth(db, t0, tz);

      await db.runAsync(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [META_KEY_LAST_TICK, String(t0)],
      );

      // Background rule eval — fires nudges even when the app is killed.
      // The 60s foreground loop covers active sessions.
      await runRulesOnceFromBackground();

      const dt = Date.now() - t0;
      console.log(
        `[aggregator] tick ok in ${dt}ms today=${today} score=${scoreToday} ` +
          `yest=${yesterday} score=${scoreYesterday} silences=${silToday.length}/${silYest.length}` +
          (monthFolded ? ` monthly=${monthFolded}` : ''),
      );
      return {
        ok: true,
        ranAt: t0,
        today,
        yesterday,
        silencesToday: silToday.length,
        silencesYesterday: silYest.length,
        scoreToday,
        scoreYesterday,
        monthFolded,
        durationMs: dt,
      };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[aggregator] tick failed:', msg);
    return {
      ok: false,
      ranAt: t0,
      today,
      yesterday,
      silencesToday: 0,
      silencesYesterday: 0,
      scoreToday: null,
      scoreYesterday: null,
      monthFolded: null,
      durationMs: Date.now() - t0,
      error: msg,
    };
  }
}

/**
 * Folds last month exactly once per local day. Cheap; the SELECT-by-month
 * is indexed by PRIMARY KEY prefix and a typical month is ~30 rows.
 */
async function maybeFoldMonth(
  db: import('expo-sqlite').SQLiteDatabase,
  now: number,
  tz: string,
): Promise<string | null> {
  const today = localDateStr(now, tz);
  const last = await db.getFirstAsync<{ value: string } | null>(
    `SELECT value FROM schema_meta WHERE key = ?`,
    [META_KEY_LAST_FOLD],
  );
  if (last?.value === today) return null;

  // Fold the month that contains "yesterday" — covers both mid-month ticks
  // (yesterday in same month) and the day-after-month-end case.
  const yest = prevDate(today);
  const month = localMonthStr(Date.parse(`${yest}T12:00:00Z`), tz);
  await foldMonth(db, month);
  await db.runAsync(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [META_KEY_LAST_FOLD, today],
  );
  return month;
}

export { META_KEY_LAST_TICK };

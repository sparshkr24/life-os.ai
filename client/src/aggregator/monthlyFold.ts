/**
 * Monthly fold. Rolls all daily_rollup rows for `month` ('YYYY-MM') into one
 * monthly_rollup row. Idempotent — re-running overwrites.
 *
 * Stays terse: the spec (docs/ARCHITECTURE.md §3.5) calls for "top apps,
 * sleep p50/p90, place hours, habit adherence, top deviations" — we keep
 * the deterministic pieces here and leave habit/deviation analysis to the
 * nightly LLM (which sees daily_rollup directly anyway).
 */
import type * as SQLite from 'expo-sqlite';
import type { DailyRollupData } from './rollup';
import type { AppCategory } from '../db/schema';

interface AppMonth {
  pkg: string;
  total_minutes: number;
  total_sessions: number;
  category: AppCategory;
}

interface PlaceMonth {
  id: string;
  total_minutes: number;
}

export interface MonthlyRollupData {
  month: string;
  days_observed: number;
  avg_productivity_score: number | null;
  top_apps: AppMonth[];
  by_category_minutes: Record<AppCategory, number>;
  sleep: { p50_min: number | null; p90_min: number | null };
  places: PlaceMonth[];
  total_steps: number;
  total_active_minutes: number;
  totals: {
    nudges_fired: number;
    nudges_acted: number;
    todos_created: number;
    todos_completed: number;
  };
}

export async function foldMonth(
  db: SQLite.SQLiteDatabase,
  month: string,
): Promise<MonthlyRollupData> {
  const rows = await db.getAllAsync<{ data: string; productivity_score: number | null }>(
    `SELECT data, productivity_score FROM daily_rollup
     WHERE substr(date, 1, 7) = ?
     ORDER BY date ASC`,
    [month],
  );
  const days = rows
    .map((r) => {
      try {
        return JSON.parse(r.data) as DailyRollupData;
      } catch {
        return null;
      }
    })
    .filter((d): d is DailyRollupData => d != null);

  const apps = new Map<string, AppMonth>();
  const placeTotals = new Map<string, number>();
  const byCat: Record<AppCategory, number> = { productive: 0, neutral: 0, unproductive: 0 };
  const sleepMins: number[] = [];
  let steps = 0;
  let active = 0;
  let nudgesFired = 0;
  let nudgesActed = 0;
  let todosCreated = 0;
  let todosCompleted = 0;

  for (const d of days) {
    for (const a of d.by_app) {
      const prev = apps.get(a.pkg);
      apps.set(a.pkg, {
        pkg: a.pkg,
        total_minutes: (prev?.total_minutes ?? 0) + a.minutes,
        total_sessions: (prev?.total_sessions ?? 0) + a.sessions,
        category: a.category,
      });
    }
    for (const k of ['productive', 'neutral', 'unproductive'] as const) {
      byCat[k] += d.by_category[k] ?? 0;
    }
    for (const p of d.places) {
      placeTotals.set(p.id, (placeTotals.get(p.id) ?? 0) + p.minutes);
    }
    if (d.sleep.duration_min > 0) sleepMins.push(d.sleep.duration_min);
    steps += d.steps;
    active += d.active_minutes;
    nudgesFired += d.nudges.fired;
    nudgesActed += d.nudges.acted;
    todosCreated += d.todos.created;
    todosCompleted += d.todos.completed;
  }

  const scores = rows
    .map((r) => r.productivity_score)
    .filter((s): s is number => typeof s === 'number');
  const avgScore =
    scores.length > 0
      ? Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 1000) / 1000
      : null;

  const data: MonthlyRollupData = {
    month,
    days_observed: days.length,
    avg_productivity_score: avgScore,
    top_apps: [...apps.values()]
      .sort((a, b) => b.total_minutes - a.total_minutes)
      .slice(0, 20),
    by_category_minutes: byCat,
    sleep: { p50_min: percentile(sleepMins, 0.5), p90_min: percentile(sleepMins, 0.9) },
    places: [...placeTotals.entries()]
      .map(([id, total_minutes]) => ({ id, total_minutes }))
      .sort((a, b) => b.total_minutes - a.total_minutes),
    total_steps: steps,
    total_active_minutes: active,
    totals: {
      nudges_fired: nudgesFired,
      nudges_acted: nudgesActed,
      todos_created: todosCreated,
      todos_completed: todosCompleted,
    },
  };

  await db.runAsync(
    `INSERT INTO monthly_rollup (month, data, updated_ts)
     VALUES (?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET data = excluded.data, updated_ts = excluded.updated_ts`,
    [month, JSON.stringify(data), Date.now()],
  );
  return data;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * Read-only queries powering the observability tabs.
 *
 * Every call goes through `withDb` so a stale expo-sqlite SharedRef NPE
 * is auto-recovered by reopening the connection once.
 */
import { withDb } from '../db';
import type {
  EventKind,
  EventRow,
  DailyRollupRow,
  MonthlyRollupRow,
  LlmCallRow,
  NudgeRow,
  BehaviorProfileRow,
} from '../db/schema';

export interface EventListFilter {
  kind?: EventKind | 'all';
  sinceTs?: number;
  limit?: number;
}

export async function listEvents(f: EventListFilter = {}): Promise<EventRow[]> {
  return withDb(async (db) => {
    const limit = f.limit ?? 200;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.kind && f.kind !== 'all') {
      where.push('kind = ?');
      args.push(f.kind);
    }
    if (f.sinceTs) {
      where.push('ts >= ?');
      args.push(f.sinceTs);
    }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${limit}`;
    return db.getAllAsync<EventRow>(sql, args);
  });
}

export async function eventCounts(): Promise<{ total: number; lastHour: number }> {
  return withDb(async (db) => {
    const t = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM events');
    const h = await db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM events WHERE ts >= ?',
      [Date.now() - 3600_000],
    );
    return { total: t?.c ?? 0, lastHour: h?.c ?? 0 };
  });
}

export interface RollupFilter {
  text?: string;
  fromDate?: string;
  toDate?: string;
  sort: 'asc' | 'desc';
}

export async function listDailyRollups(f: RollupFilter): Promise<DailyRollupRow[]> {
  return withDb(async (db) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.fromDate) {
      where.push('date >= ?');
      args.push(f.fromDate);
    }
    if (f.toDate) {
      where.push('date <= ?');
      args.push(f.toDate);
    }
    if (f.text) {
      where.push('(date LIKE ? OR data LIKE ?)');
      args.push(`%${f.text}%`, `%${f.text}%`);
    }
    const sql = `SELECT * FROM daily_rollup ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date ${f.sort === 'asc' ? 'ASC' : 'DESC'} LIMIT 365`;
    return db.getAllAsync<DailyRollupRow>(sql, args);
  });
}

export async function listMonthlyRollups(f: RollupFilter): Promise<MonthlyRollupRow[]> {
  return withDb(async (db) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.fromDate) {
      where.push('month >= ?');
      args.push(f.fromDate.slice(0, 7));
    }
    if (f.toDate) {
      where.push('month <= ?');
      args.push(f.toDate.slice(0, 7));
    }
    if (f.text) {
      where.push('(month LIKE ? OR data LIKE ?)');
      args.push(`%${f.text}%`, `%${f.text}%`);
    }
    const sql = `SELECT * FROM monthly_rollup ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY month ${f.sort === 'asc' ? 'ASC' : 'DESC'} LIMIT 24`;
    return db.getAllAsync<MonthlyRollupRow>(sql, args);
  });
}

export type LlmPurposeFilter = 'all' | 'nightly' | 'tick' | 'chat';

export async function listLlmCalls(purpose: LlmPurposeFilter, limit = 200): Promise<LlmCallRow[]> {
  return withDb(async (db) => {
    if (purpose === 'all') {
      return db.getAllAsync<LlmCallRow>('SELECT * FROM llm_calls ORDER BY ts DESC LIMIT ?', [limit]);
    }
    return db.getAllAsync<LlmCallRow>(
      'SELECT * FROM llm_calls WHERE purpose = ? ORDER BY ts DESC LIMIT ?',
      [purpose, limit],
    );
  });
}

export async function todayLlmSpendUsd(): Promise<number> {
  return withDb(async (db) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const r = await db.getFirstAsync<{ s: number | null }>(
      'SELECT SUM(cost_usd) AS s FROM llm_calls WHERE ts >= ?',
      [startOfDay.getTime()],
    );
    return r?.s ?? 0;
  });
}

export async function listNudges(limit = 200): Promise<NudgeRow[]> {
  return withDb((db) =>
    db.getAllAsync<NudgeRow>('SELECT * FROM nudges_log ORDER BY ts DESC LIMIT ?', [limit]),
  );
}

export async function getProfile(): Promise<BehaviorProfileRow | null> {
  return withDb(async (db) => {
    const r = await db.getFirstAsync<BehaviorProfileRow>('SELECT * FROM behavior_profile WHERE id = 1');
    return r ?? null;
  });
}

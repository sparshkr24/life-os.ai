/**
 * Today's LLM spend ledger. Single source of truth for the daily cap check.
 *
 * Was previously inlined in `brain/smartNudge.ts`; lifted here so every
 * caller (router, provider clients, smart-nudge tick, embed) hits one
 * implementation. Cents-accurate is enough — we're not billing anyone.
 */
import { withDb } from '../db';
import type { LlmPurpose } from '../db/schema';

export async function sumTodayLlmCostUsd(): Promise<number> {
  return withDb(async (db) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const r = await db.getFirstAsync<{ s: number | null }>(
      `SELECT SUM(cost_usd) AS s FROM llm_calls WHERE ts >= ?`,
      [startOfDay.getTime()],
    );
    return r?.s ?? 0;
  });
}

export interface LlmLogRow {
  ts: number;
  purpose: LlmPurpose;
  model: string;
  inTokens: number | null;
  outTokens: number | null;
  costUsd: number;
  ok: boolean;
  error: string | null;
  request: string;
  response: string;
}

/** Returns the inserted row id (lastInsertRowId) or 0 on failure. */
export async function logLlmCall(row: LlmLogRow): Promise<number> {
  try {
    return await withDb(async (db) => {
      const r = await db.runAsync(
        `INSERT INTO llm_calls
          (ts, purpose, model, in_tokens, out_tokens, cost_usd, ok, error, request, response)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.ts,
          row.purpose,
          row.model,
          row.inTokens,
          row.outTokens,
          row.costUsd,
          row.ok ? 1 : 0,
          row.error,
          row.request.slice(0, 8000),
          row.response.slice(0, 4000),
        ],
      );
      return r.lastInsertRowId ?? 0;
    });
  } catch (e) {
    console.warn('[ledger] log failed:', (e as Error).message);
    return 0;
  }
}

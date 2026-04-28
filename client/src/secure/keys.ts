/**
 * Secure-store keyed access. Owns ONLY the daily cost cap now.
 *
 * LLM API keys are owned by `client/src/llm/keys.ts` (per-provider namespace
 * with auto-migration from the old `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
 * slots). This file used to manage those too — that's why callers still
 * import from here for `dailyCapUsd`.
 */
import * as SecureStore from 'expo-secure-store';

const K_CAP = 'LLM_DAILY_USD_CAP';

export const DEFAULT_DAILY_CAP_USD = 0.3;

export interface SecureSnapshot {
  dailyCapUsd: number;
}

export async function loadSnapshot(): Promise<SecureSnapshot> {
  const c = await SecureStore.getItemAsync(K_CAP);
  return { dailyCapUsd: c ? Number(c) : DEFAULT_DAILY_CAP_USD };
}

export async function setDailyCap(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd < 0) return;
  await SecureStore.setItemAsync(K_CAP, String(usd));
}

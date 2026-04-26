/**
 * Secure-store keyed access. API keys + cost cap.
 * Values stored in Android Keystore via expo-secure-store. Never logged.
 */
import * as SecureStore from 'expo-secure-store';

const K_ANTHROPIC = 'ANTHROPIC_API_KEY';
const K_OPENAI = 'OPENAI_API_KEY';
const K_CAP = 'LLM_DAILY_USD_CAP';

export const DEFAULT_DAILY_CAP_USD = 0.3;

export interface SecureSnapshot {
  anthropicSet: boolean;
  anthropicTail: string;
  openaiSet: boolean;
  openaiTail: string;
  dailyCapUsd: number;
}

const tail = (v: string | null): string => (v && v.length >= 4 ? `…${v.slice(-4)}` : '');

export async function loadSnapshot(): Promise<SecureSnapshot> {
  const [a, o, c] = await Promise.all([
    SecureStore.getItemAsync(K_ANTHROPIC),
    SecureStore.getItemAsync(K_OPENAI),
    SecureStore.getItemAsync(K_CAP),
  ]);
  return {
    anthropicSet: !!a,
    anthropicTail: tail(a),
    openaiSet: !!o,
    openaiTail: tail(o),
    dailyCapUsd: c ? Number(c) : DEFAULT_DAILY_CAP_USD,
  };
}

export async function setAnthropicKey(value: string): Promise<void> {
  if (!value.trim()) {
    await SecureStore.deleteItemAsync(K_ANTHROPIC);
    return;
  }
  await SecureStore.setItemAsync(K_ANTHROPIC, value.trim());
}

export async function setOpenAiKey(value: string): Promise<void> {
  if (!value.trim()) {
    await SecureStore.deleteItemAsync(K_OPENAI);
    return;
  }
  await SecureStore.setItemAsync(K_OPENAI, value.trim());
}

export async function setDailyCap(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd < 0) return;
  await SecureStore.setItemAsync(K_CAP, String(usd));
}

export async function getAnthropicKey(): Promise<string | null> {
  return SecureStore.getItemAsync(K_ANTHROPIC);
}

export async function getOpenAiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(K_OPENAI);
}

/**
 * Provider-agnostic API key storage in expo-secure-store.
 *
 * Key naming: `LLM_KEY_<PROVIDER>` so a future audit script can find them all.
 * Tail (last 4 chars) is shown in the UI; the key itself never leaves this
 * module except inside an Authorization header.
 */
import * as SecureStore from 'expo-secure-store';
import type { ProviderId } from './types';

const STORAGE_PREFIX = 'LLM_KEY_';

const PROVIDER_KEYS: Record<ProviderId, string> = {
  openai: `${STORAGE_PREFIX}OPENAI`,
  openrouter: `${STORAGE_PREFIX}OPENROUTER`,
};

/**
 * Legacy key name from before the multi-provider refactor. Migrated on first
 * read so existing users don't have to re-paste.
 */
const LEGACY_KEYS: Partial<Record<ProviderId, string>> = {
  openai: 'OPENAI_API_KEY',
};

export async function getProviderKey(p: ProviderId): Promise<string | null> {
  const v = await SecureStore.getItemAsync(PROVIDER_KEYS[p]);
  if (v) return v;
  // Migrate from legacy slot if present.
  const legacy = LEGACY_KEYS[p];
  if (legacy) {
    const old = await SecureStore.getItemAsync(legacy);
    if (old) {
      await SecureStore.setItemAsync(PROVIDER_KEYS[p], old);
      return old;
    }
  }
  return null;
}

export async function setProviderKey(p: ProviderId, value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    await SecureStore.deleteItemAsync(PROVIDER_KEYS[p]);
    return;
  }
  await SecureStore.setItemAsync(PROVIDER_KEYS[p], trimmed);
}

export async function deleteProviderKey(p: ProviderId): Promise<void> {
  await SecureStore.deleteItemAsync(PROVIDER_KEYS[p]);
}

export interface ProviderKeyStatus {
  provider: ProviderId;
  hasKey: boolean;
  tail: string;
}

export async function listProviderKeys(): Promise<ProviderKeyStatus[]> {
  const out: ProviderKeyStatus[] = [];
  for (const p of Object.keys(PROVIDER_KEYS) as ProviderId[]) {
    const v = await getProviderKey(p);
    out.push({
      provider: p,
      hasKey: v !== null,
      tail: v && v.length >= 4 ? `…${v.slice(-4)}` : '',
    });
  }
  return out;
}

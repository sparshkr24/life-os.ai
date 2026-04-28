/**
 * Provider registry. Single source of truth mapping ProviderId → instances.
 *
 * Adding a new provider:
 *   1. Add the id to `ProviderId` in `../types.ts`.
 *   2. Add a model entry in `../models.ts` if it ships chat models.
 *   3. Implement `ChatProvider` (and/or `EmbeddingProvider`) — usually a one-
 *      line `OpenAiCompatChatProvider` instance.
 *   4. Register the instances below.
 *   5. Add it to `PROVIDER_LABELS` / `PROVIDER_KEY_HINT` / `ALL_PROVIDERS`.
 *
 * Nothing else in the codebase should know about provider classes directly.
 */
import { openaiChat, openaiEmbed } from './openai';
import { openrouterChat } from './openrouter';
import type { ChatProvider, EmbeddingProvider } from './base';
import type { ProviderId } from '../types';

const CHAT: Record<ProviderId, ChatProvider> = {
  openai: openaiChat,
  openrouter: openrouterChat,
};

const EMBED: Partial<Record<ProviderId, EmbeddingProvider>> = {
  openai: openaiEmbed,
};

export function getChatProvider(p: ProviderId): ChatProvider {
  return CHAT[p];
}

export function getEmbedProvider(p: ProviderId): EmbeddingProvider | null {
  return EMBED[p] ?? null;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
};

export const ALL_PROVIDERS: readonly ProviderId[] = ['openai', 'openrouter'];

/** Placeholder text shown in the API-key field. */
export const PROVIDER_KEY_HINT: Record<ProviderId, string> = {
  openai: 'sk-…',
  openrouter: 'sk-or-…',
};

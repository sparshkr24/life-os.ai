/**
 * Known model catalogue. Pricing in USD per 1M tokens (April 2026).
 *
 * Two routes today:
 *  - `openai`     — direct OpenAI API. Used for embeddings (always) and chat
 *                   (current default until OpenRouter credits are loaded).
 *  - `openrouter` — single key, any model the user wants behind it. Mirrors of
 *                   the OpenAI chat models live here so flipping providers is
 *                   a one-tap operation in the AI Models screen — no code
 *                   change. To add a new OR-served model: append a row.
 *
 * Embeddings stay on OpenAI direct. OpenRouter does not proxy embeddings.
 */
import type { ModelDescriptor, ProviderId, TaskKind } from './types';

export const MODELS: readonly ModelDescriptor[] = [
  // ── OpenAI direct ─────────────────────────────────────────
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    provider: 'openai',
    pricePerMInput: 0.25,
    pricePerMOutput: 2.0,
    capabilities: { toolCalls: true, jsonMode: true, longContext: true },
  },
  {
    id: 'text-embedding-3-small',
    label: 'OpenAI Embed 3 Small (1536-d)',
    provider: 'openai',
    pricePerMInput: 0.02,
    pricePerMOutput: 0,
    capabilities: { toolCalls: false, jsonMode: false, longContext: false },
    isEmbedding: true,
    embedDim: 1536,
  },

  // ── OpenRouter mirrors (flip every assignment to switch) ──
  // OpenRouter slug format: '<vendor>/<model>'. Pricing matches upstream + ~5%.
  {
    id: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 Mini (via OpenRouter)',
    provider: 'openrouter',
    pricePerMInput: 0.26,
    pricePerMOutput: 2.1,
    capabilities: { toolCalls: true, jsonMode: true, longContext: true },
  },
  {
    id: 'anthropic/claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (via OpenRouter)',
    provider: 'openrouter',
    pricePerMInput: 3.15,
    pricePerMOutput: 15.75,
    capabilities: { toolCalls: true, jsonMode: true, longContext: true },
  },
];

export function findModel(id: string | null | undefined): ModelDescriptor | null {
  if (!id) return null;
  return MODELS.find((m) => m.id === id) ?? null;
}

export function modelsForProvider(p: ProviderId): ModelDescriptor[] {
  return MODELS.filter((m) => m.provider === p);
}

export function chatModels(): ModelDescriptor[] {
  return MODELS.filter((m) => !m.isEmbedding);
}

export function embeddingModels(): ModelDescriptor[] {
  return MODELS.filter((m) => m.isEmbedding === true);
}

/**
 * Default model ids per task. Used when the user hasn't configured the task
 * yet OR when the configured model isn't usable (key missing, model removed).
 *
 * Today everything routes to gpt-5.4-mini direct. Switch a single task to
 * OpenRouter by setting `task_assignments[task] = 'openai/gpt-5.4-mini'`.
 */
export const DEFAULT_TASK_MODELS: Record<TaskKind, string> = {
  nightly: 'gpt-5.4-mini',
  chat: 'gpt-5.4-mini',
  smart_nudge: 'gpt-5.4-mini',
  consolidation: 'gpt-5.4-mini',
  rule_generation: 'gpt-5.4-mini',
  embed: 'text-embedding-3-small',
};

/**
 * Tasks the user can re-assign in the UI. `embed` is excluded — switching
 * embedding models requires re-embedding every memory row.
 */
export const ASSIGNABLE_TASKS: readonly TaskKind[] = [
  'nightly',
  'chat',
  'smart_nudge',
  'consolidation',
  'rule_generation',
];

export const TASK_LABELS: Record<TaskKind, string> = {
  nightly: 'Nightly profile rebuild',
  chat: 'Chat (with tools)',
  smart_nudge: 'Smart nudges',
  consolidation: 'Memory consolidation',
  rule_generation: 'Rule generation',
  embed: 'Embeddings',
};

export const TASK_DESCRIPTIONS: Record<TaskKind, string> = {
  nightly: 'Once/day. Tool-calling session: extract memories, verify predictions, consolidate, enrich apps, rebuild profile.',
  chat: 'Interactive chat with tool access to your data.',
  smart_nudge: 'Every 15 min. Decides whether to fire a nudge.',
  consolidation: 'Reserved for future weekly memory merge pass.',
  rule_generation: 'Weekly. Writes deterministic nudge rules.',
  embed: 'Embeddings for the memory store.',
};

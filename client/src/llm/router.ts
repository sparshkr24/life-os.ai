/**
 * Task router. The ONLY entry point callers should use to talk to an LLM.
 *
 * Workflow:
 *   1. Resolve task → model id (user assignment, else default).
 *   2. Look up model in catalogue → provider id.
 *   3. Cost-cap check (today's spend < CAP_USD).
 *   4. Look up provider key. If missing, return 'no_key'.
 *   5. Dispatch to the provider's `chat()` or `embed()`.
 *   6. Log to `llm_calls` (purpose mapped from taskKind).
 *   7. Return ChatResponse / EmbedResponse OR a structured failure result.
 *
 * Callers MUST handle `kind: 'skipped'` (no-key, cap-exceeded, no-assignment)
 * and `kind: 'failed'` (HTTP/parse error). Never `throw` — the router
 * catches and reports.
 */
import { resolveAssignment } from './assignments';
import { getProviderKey } from './keys';
import { sumTodayLlmCostUsd, logLlmCall } from './ledger';
import { findModel, DEFAULT_TASK_MODELS } from './models';
import { getChatProvider, getEmbedProvider } from './providers/registry';
import type {
  ChatRequest,
  ChatResponse,
  ChatTaskResult,
  EmbedTaskResult,
  TaskKind,
} from './types';

/** Daily spend cap. Hard wall — same value the smart-nudge tick used. */
export const DAILY_COST_CAP_USD = 0.30;

const TASK_TO_PURPOSE: Record<TaskKind, 'nightly' | 'tick' | 'chat' | 'embed' | 'extract'> = {
  nightly: 'nightly',
  chat: 'chat',
  smart_nudge: 'tick',
  consolidation: 'nightly', // batched into nightly purpose for now
  rule_generation: 'nightly',
  embed: 'embed',
};

export async function runChatTask(
  task: TaskKind,
  request: ChatRequest,
): Promise<ChatTaskResult> {
  if (task === 'embed') {
    return { kind: 'failed', reason: 'embed routed via runEmbedTask' };
  }
  const assigned = await resolveAssignment(task);
  if (!assigned) {
    return { kind: 'skipped', reason: 'no_assignment' };
  }
  if (!assigned.hasKey) {
    return { kind: 'skipped', reason: 'no_key' };
  }
  const todaySpend = await sumTodayLlmCostUsd();
  if (todaySpend >= DAILY_COST_CAP_USD) {
    return { kind: 'skipped', reason: 'cap_exceeded' };
  }

  const apiKey = await getProviderKey(assigned.provider);
  if (!apiKey) return { kind: 'skipped', reason: 'no_key' };

  const provider = getChatProvider(assigned.provider);
  const purpose = TASK_TO_PURPOSE[task];
  const startedAt = Date.now();

  try {
    const res = await provider.chat(assigned.modelId, apiKey, request);
    await logLlmCall({
      ts: startedAt,
      purpose,
      model: res.modelId,
      inTokens: res.usage.inTokens,
      outTokens: res.usage.outTokens,
      costUsd: res.usage.costUsd,
      ok: true,
      error: null,
      request: summarizeRequest(request),
      response: res.rawForLog,
    });
    return { kind: 'ok', response: res };
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown error';
    await logLlmCall({
      ts: startedAt,
      purpose,
      model: assigned.modelId,
      inTokens: null,
      outTokens: null,
      costUsd: 0,
      ok: false,
      error: msg.slice(0, 500),
      request: summarizeRequest(request),
      response: '',
    });
    return { kind: 'failed', reason: msg };
  }
}

export async function runEmbedTask(text: string): Promise<EmbedTaskResult> {
  // Embedding always uses the default; users can't reassign it.
  const modelId = DEFAULT_TASK_MODELS.embed;
  const m = findModel(modelId);
  if (!m) return { kind: 'failed', reason: 'embed model not in catalogue' };
  const apiKey = await getProviderKey(m.provider);
  if (!apiKey) return { kind: 'skipped', reason: 'no_key' };

  const todaySpend = await sumTodayLlmCostUsd();
  if (todaySpend >= DAILY_COST_CAP_USD) {
    return { kind: 'skipped', reason: 'cap_exceeded' };
  }

  const provider = getEmbedProvider(m.provider);
  if (!provider) return { kind: 'failed', reason: 'no embedding provider' };

  const startedAt = Date.now();
  try {
    const res = await provider.embed(modelId, apiKey, { text });
    await logLlmCall({
      ts: startedAt,
      purpose: 'embed',
      model: res.modelId,
      inTokens: res.inTokens,
      outTokens: 0,
      costUsd: res.costUsd,
      ok: true,
      error: null,
      request: `embed ${text.length}ch`,
      response: `dim=${res.vector.length}`,
    });
    return { kind: 'ok', response: res };
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown error';
    await logLlmCall({
      ts: startedAt,
      purpose: 'embed',
      model: modelId,
      inTokens: null,
      outTokens: null,
      costUsd: 0,
      ok: false,
      error: msg.slice(0, 500),
      request: `embed ${text.length}ch`,
      response: '',
    });
    return { kind: 'failed', reason: msg };
  }
}

/** Helper: Sonnet-style narrate-the-output for chat tool loops. */
export function chatResponseText(res: ChatResponse): string {
  return res.text;
}

function summarizeRequest(req: ChatRequest): string {
  // Trim to keep the audit log readable. Full prompts are reproducible from
  // code + state anyway.
  const lines: string[] = [];
  if (req.system) lines.push(`SYSTEM: ${req.system.slice(0, 400)}`);
  for (const m of req.messages) {
    lines.push(`${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`);
  }
  return lines.join('\n').slice(0, 8000);
}

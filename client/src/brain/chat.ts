/**
 * Chat turn runner. Tool-calling against local SQLite with RAG-injected context.
 *
 * Loop: cost-cap check → POST with tools → if tool_use, execute locally → repeat
 * (max TOOL_LOOPS iterations) → return final assistant message.
 *
 * Tool definitions and handlers live in brain/tools.ts.
 * RAG context is injected via buildChatSystemPrompt before the first call.
 */
import { retrieveContext } from '../memory/rag';
import { runChatTask } from '../llm/router';
import { getToolsForScope } from './tools';
import type { ChatMessage } from '../llm/types';

const MAX_OUTPUT_TOKENS = 1024;
const TOOL_LOOPS = 4;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface ChatRunResult {
  text: string;
  costUsd: number;
  toolCalls: number;
  skipped: 'cost_cap' | 'no_key' | null;
  error: string | null;
  durationMs: number;
}

const SYSTEM_PROMPT = `You are the in-app assistant for AI Life OS, a personal phone tracker.
You help one user (the owner of this device) understand their own habits.

Rules:
- Be concise. 1-3 short paragraphs. No emojis. No marketing tone.
- When the user asks something concrete ("how much YouTube yesterday?", "did I sleep enough?"),
  call a tool first to get real numbers, then narrate the answer in plain language.
- Never invent metrics. If the data isn't there, say so plainly.

Tool selection priority for *precise timing / duration / location* questions
("how long at office today?", "what time did I leave the gym?", "am I staying
later this week than last?"):
  1. PREFER raw events via get_events_window(start_ts, end_ts, kinds?, limit?).
     They are the only source of exact timestamps. Compute today's window as
     [00:00 local, 24h later] in epoch ms.
  2. Use list_places to translate place ids in geo_enter / geo_exit events.
  3. Compute durations yourself by pairing matching enter/exit events.
  4. Use get_daily_rollup / count_events_by_app for AGGREGATE answers
     ("how much YouTube yesterday?") — they're cheaper but less precise.
  5. Use search_memories / list_recent_memories only when the user asks for
     PATTERNS or insights, not for raw numbers.

Read-only inventories: list_places, list_todos, list_recent_memories,
list_proactive_questions, get_app_categories.

A few write tools (create_todo, propose_rule, mark_memory_archived,
add_geofence_place, mark_pattern_memory, ask_user_question) are available —
use them ONLY when the user explicitly asks you to record / schedule / discard
or when adding a place from a clear conversational signal.`;

export async function runChatTurn(history: ChatTurn[]): Promise<ChatRunResult> {
  const startedAt = Date.now();
  const result: ChatRunResult = {
    text: '',
    costUsd: 0,
    toolCalls: 0,
    skipped: null,
    error: null,
    durationMs: 0,
  };

  try {
    const messages: ChatMessage[] = history.map((t) => ({
      role: t.role,
      content: t.text,
    }));
    const systemPrompt = await buildChatSystemPrompt(history);
    const tools = getToolsForScope('chat');

    let finalText = '';
    let totalCost = 0;

    for (let i = 0; i < TOOL_LOOPS; i += 1) {
      const callRes = await runChatTask('chat', {
        system: systemPrompt,
        messages,
        tools: tools.defs,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      if (callRes.kind === 'skipped') {
        result.skipped = callRes.reason === 'cap_exceeded' ? 'cost_cap' : 'no_key';
        return done(result, startedAt);
      }
      if (callRes.kind === 'failed') {
        result.error = callRes.reason;
        return done(result, startedAt);
      }
      const response = callRes.response;
      totalCost += response.usage.costUsd;
      if (response.text) finalText = response.text;

      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
        break;
      }

      messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
      });
      for (const tc of response.toolCalls) {
        result.toolCalls += 1;
        const out = await tools.run(tc.name, (tc.arguments ?? {}) as Record<string, unknown>);
        const resultStr = JSON.stringify(out).slice(0, 6000);
        messages.push({
          role: 'tool',
          content: resultStr,
          toolResultFor: tc.id,
        });
      }
    }

    result.text = finalText || '(no response)';
    result.costUsd = totalCost;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error('[chat] failed:', result.error);
  }
  return done(result, startedAt);
}

function done(r: ChatRunResult, startedAt: number): ChatRunResult {
  r.durationMs = Date.now() - startedAt;
  return r;
}

/**
 * Pull memories relevant to the user's latest question and append
 * them to SYSTEM_PROMPT as a MEMORY_CONTEXT section. Falls back to the bare
 * SYSTEM_PROMPT when there are no memories yet or RAG fails.
 */
async function buildChatSystemPrompt(history: ChatTurn[]): Promise<string> {
  try {
    const lastUser = [...history].reverse().find((t) => t.role === 'user');
    const queryText = lastUser?.text?.trim();
    if (!queryText) return SYSTEM_PROMPT;
    const r = await retrieveContext({ decisionType: 'chat', queryText, k: 6 });
    if (!r.embedded || r.memories.length === 0) return SYSTEM_PROMPT;
    return `${SYSTEM_PROMPT}\n\n${r.contextBlock}`;
  } catch (e) {
    console.warn('[chat] rag failed:', (e as Error).message);
    return SYSTEM_PROMPT;
  }
}

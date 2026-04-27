/**
 * Stage-9 Chat. Sonnet with tool-calling against the local SQLite DB.
 *
 * Loop:
 *   1. cost-cap + key check     (hard wall, same as nightly/smart)
 *   2. POST /v1/messages        with `tools` + the running message log
 *   3. if stop_reason=tool_use  execute the tool locally → append tool_result
 *      → POST again (max TOOL_LOOPS iterations)
 *   4. accumulate text blocks → return final assistant message
 *
 * All tools are **read-only views** over rollup-level data. No raw events:
 * "no raw events to LLMs" rule still holds (CLAUDE.md §7).
 */
import { withDb } from '../db';
import { getAnthropicKey, loadSnapshot } from '../secure/keys';
import { deviceTz, localDateStr, prevDate } from '../aggregator/time';
import { sumTodayLlmCostUsd } from './smartNudge';
import { retrieveContext } from '../memory/rag';

const MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_OUTPUT_TOKENS = 1024;
const TOOL_LOOPS = 4;

// claude-sonnet-4-5 pricing (USD per 1M tokens, April 2026).
const PRICE_INPUT_PER_M = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;

// ─────────────────────────────────────────────────────────── public types

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

// ────────────────────────────────────────────────────── anthropic shapes

interface AnthroTextBlock {
  type: 'text';
  text: string;
}
interface AnthroToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type AnthroBlock = AnthroTextBlock | AnthroToolUseBlock;

interface AnthroResponse {
  content?: AnthroBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

interface OutMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        | {
            type: 'tool_result';
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          }
      >;
}

const SYSTEM_PROMPT = `You are the in-app assistant for AI Life OS, a personal phone tracker.
You help one user (the owner of this device) understand their own habits.

Rules:
- Be concise. 1-3 short paragraphs. No emojis. No marketing tone.
- When the user asks something concrete ("how much YouTube yesterday?", "did I sleep enough?"),
  call a tool first to get real numbers, then narrate the answer in plain language.
- Never invent metrics. If the data isn't there, say so plainly.
- All tools are read-only views of the user's own local data.`;

// ────────────────────────────────────────────────────────────── tools

const TOOL_DEFS = [
  {
    name: 'get_today_summary',
    description:
      "Today's daily rollup + productivity score, sleep, top apps, screen time, nudges fired.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_daily_rollup',
    description: 'Daily rollup for a specific date (YYYY-MM-DD).',
    input_schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
    },
  },
  {
    name: 'get_recent_rollups',
    description:
      'Compact rollup summary for the last N days (productivity score, sleep duration, screen time, top app). Default 7.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 30 } },
      required: [],
    },
  },
  {
    name: 'get_profile',
    description:
      "The user's behavior profile (good habits, time-wasters, suggested rules). Built nightly by Sonnet.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_recent_nudges',
    description:
      'Nudges fired in the last N days (default 7), with whether the user marked them helpful.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 30 } },
      required: [],
    },
  },
] as const;

interface ToolHandlerArgs {
  date?: unknown;
  days?: unknown;
}
type ToolHandler = (args: ToolHandlerArgs) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_today_summary: async () => {
    const today = localDateStr(Date.now(), deviceTz());
    return loadDailyRollup(today);
  },
  get_daily_rollup: async ({ date }) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { error: 'date must be YYYY-MM-DD' };
    }
    return loadDailyRollup(date);
  },
  get_recent_rollups: async ({ days }) => {
    const n = clampInt(days, 1, 30, 7);
    const tz = deviceTz();
    const out: unknown[] = [];
    let d = localDateStr(Date.now(), tz);
    for (let i = 0; i < n; i += 1) {
      out.push(await loadDailyRollupCompact(d));
      d = prevDate(d);
    }
    return out;
  },
  get_profile: async () => {
    return withDb(async (db) => {
      const r = await db.getFirstAsync<{ data: string; built_ts: number; based_on_days: number }>(
        `SELECT data, built_ts, based_on_days FROM behavior_profile
         ORDER BY built_ts DESC LIMIT 1`,
      );
      if (!r) return { note: 'no profile yet — nightly job has not run' };
      try {
        const parsed = JSON.parse(r.data) as Record<string, unknown>;
        return { built_ts: r.built_ts, based_on_days: r.based_on_days, ...parsed };
      } catch {
        return { built_ts: r.built_ts, based_on_days: r.based_on_days, raw: r.data };
      }
    });
  },
  get_recent_nudges: async ({ days }) => {
    const n = clampInt(days, 1, 30, 7);
    const since = Date.now() - n * 24 * 3600_000;
    return withDb(async (db) => {
      const rows = await db.getAllAsync<{
        ts: number;
        source: string;
        level: number;
        message: string;
        user_helpful: number | null;
      }>(
        `SELECT ts, source, level, message, user_helpful FROM nudges_log
         WHERE ts >= ? ORDER BY ts DESC LIMIT 50`,
        [since],
      );
      return rows.map((r) => ({
        ago_minutes: Math.round((Date.now() - r.ts) / 60_000),
        source: r.source,
        level: r.level,
        message: r.message,
        user_helpful: r.user_helpful, // 1 = ▲, -1 = ▼, null = no feedback
      }));
    });
  },
};

async function loadDailyRollup(date: string): Promise<unknown> {
  return withDb(async (db) => {
    const r = await db.getFirstAsync<{ data: string; productivity_score: number | null }>(
      `SELECT data, productivity_score FROM daily_rollup WHERE date = ?`,
      [date],
    );
    if (!r) return { date, note: 'no rollup for that date' };
    try {
      const parsed = JSON.parse(r.data) as Record<string, unknown>;
      return { date, productivity_score: r.productivity_score, ...parsed };
    } catch {
      return { date, productivity_score: r.productivity_score, raw: r.data };
    }
  });
}

async function loadDailyRollupCompact(date: string): Promise<unknown> {
  return withDb(async (db) => {
    const r = await db.getFirstAsync<{ data: string; productivity_score: number | null }>(
      `SELECT data, productivity_score FROM daily_rollup WHERE date = ?`,
      [date],
    );
    if (!r) return { date, note: 'no rollup' };
    let topApp: string | undefined;
    let topAppMin: number | undefined;
    let sleepMin: number | undefined;
    let screenMin: number | undefined;
    try {
      const p = JSON.parse(r.data) as {
        by_app?: { pkg: string; minutes: number }[];
        sleep?: { duration_min?: number };
        screen_on_minutes?: number;
      };
      const a = p.by_app?.[0];
      if (a) {
        topApp = a.pkg;
        topAppMin = a.minutes;
      }
      sleepMin = p.sleep?.duration_min;
      screenMin = p.screen_on_minutes;
    } catch {
      // ignore
    }
    return {
      date,
      productivity_score: r.productivity_score,
      sleep_min: sleepMin,
      screen_on_min: screenMin,
      top_app: topApp,
      top_app_min: topAppMin,
    };
  });
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ─────────────────────────────────────────────────────────── runner

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
    const snapshot = await loadSnapshot();
    const todayCost = await sumTodayLlmCostUsd();
    if (todayCost >= snapshot.dailyCapUsd) {
      result.skipped = 'cost_cap';
      return done(result, startedAt);
    }
    const apiKey = await getAnthropicKey();
    if (!apiKey) {
      result.skipped = 'no_key';
      return done(result, startedAt);
    }

    const messages: OutMessage[] = history.map((t) => ({ role: t.role, content: t.text }));
    let inTokensTotal = 0;
    let outTokensTotal = 0;
    let finalText = '';

    // Stage 13: RAG — retrieve memories relevant to the latest user turn.
    // Failure (cost cap, no key, embed http error) silently degrades to the
    // v2 path: the system prompt stays as-is.
    const systemPrompt = await buildChatSystemPrompt(history);

    for (let i = 0; i < TOOL_LOOPS; i += 1) {
      const httpResponse = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemPrompt,
          tools: TOOL_DEFS,
          messages,
        }),
      });
      const responseText = await httpResponse.text();
      if (!httpResponse.ok) {
        result.error = `http ${httpResponse.status}: ${responseText.slice(0, 240)}`;
        await logChatCall({
          ts: Date.now(),
          ok: false,
          inTokens: null,
          outTokens: null,
          costUsd: 0,
          request: JSON.stringify(messages).slice(0, 8000),
          response: responseText,
          error: result.error,
        });
        return done(result, startedAt);
      }
      let body: AnthroResponse;
      try {
        body = JSON.parse(responseText) as AnthroResponse;
      } catch {
        result.error = 'malformed anthropic response';
        return done(result, startedAt);
      }
      inTokensTotal += body.usage?.input_tokens ?? 0;
      outTokensTotal += body.usage?.output_tokens ?? 0;

      const blocks = body.content ?? [];
      const textParts: string[] = [];
      const toolUses: AnthroToolUseBlock[] = [];
      for (const b of blocks) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') toolUses.push(b);
      }
      const turnText = textParts.join('\n').trim();
      if (turnText) finalText = turnText;

      if (body.stop_reason !== 'tool_use' || toolUses.length === 0) {
        break;
      }

      // Append assistant message + run tools + append tool_result block.
      messages.push({ role: 'assistant', content: blocks });
      const toolResults: OutMessage = { role: 'user', content: [] };
      for (const tu of toolUses) {
        result.toolCalls += 1;
        const handler = TOOL_HANDLERS[tu.name];
        let resultStr: string;
        let isError = false;
        if (!handler) {
          resultStr = JSON.stringify({ error: `unknown tool: ${tu.name}` });
          isError = true;
        } else {
          try {
            const out = await handler(tu.input ?? {});
            resultStr = JSON.stringify(out).slice(0, 6000);
          } catch (e) {
            resultStr = JSON.stringify({
              error: e instanceof Error ? e.message : String(e),
            });
            isError = true;
          }
        }
        (toolResults.content as Array<{
          type: 'tool_result';
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }>).push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultStr,
          is_error: isError,
        });
      }
      messages.push(toolResults);
    }

    result.text = finalText || '(no response)';
    result.costUsd = computeCost(inTokensTotal, outTokensTotal);
    await logChatCall({
      ts: startedAt,
      ok: true,
      inTokens: inTokensTotal,
      outTokens: outTokensTotal,
      costUsd: result.costUsd,
      request: JSON.stringify(history).slice(0, 8000),
      response: result.text,
      error: null,
    });
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

function computeCost(inTok: number, outTok: number): number {
  return (inTok * PRICE_INPUT_PER_M + outTok * PRICE_OUTPUT_PER_M) / 1_000_000;
}

/**
 * Stage 13: pull memories relevant to the user's latest question and append
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

interface ChatLogRow {
  ts: number;
  ok: boolean;
  inTokens: number | null;
  outTokens: number | null;
  costUsd: number;
  request: string;
  response: string;
  error: string | null;
}

async function logChatCall(row: ChatLogRow): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO llm_calls
        (ts, purpose, model, in_tokens, out_tokens, cost_usd, ok, error, request, response)
       VALUES (?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.ts,
        MODEL,
        row.inTokens,
        row.outTokens,
        row.costUsd,
        row.ok ? 1 : 0,
        row.error,
        row.request,
        row.response,
      ],
    );
  });
}

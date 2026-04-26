/**
 * Smart-nudge tick. Runs every 15 min after the aggregator finishes.
 *
 * Pipeline (single function — `runSmartNudgeTick`):
 *   1. cost cap check     — if today's `llm_calls.cost_usd` sum ≥ user cap, abort
 *   2. key check          — no OPENAI_API_KEY in secure store → abort
 *   3. cooldown check     — last smart nudge < SMART_COOLDOWN_MIN ago → abort
 *   4. build context      — today's rollup, last 24h nudges, current time/place
 *   5. call gpt-4o-mini   — strict JSON output schema
 *   6. log llm_calls      — always, even on no-nudge / failure
 *   7. fire notification  — only if model says should_nudge=true
 *   8. log nudges_log     — only if fired (source='smart', llm_call_id set)
 *
 * The model is prompted to **err on the side of silence**. We'd rather miss a
 * nudge than annoy. Cost cap is the hard floor; cooldown is the soft floor.
 */
import type * as SQLite from 'expo-sqlite';
import { withDb } from '../db';
import { getOpenAiKey, loadSnapshot } from '../secure/keys';
import { fireNudgeNotification, type NudgeLevel } from '../rules/notify';
import { deviceTz, localDateStr, localDayStartMs } from '../aggregator/time';

// gpt-4o-mini pricing as of April 2026 (USD per 1M tokens).
// Override in one place if pricing shifts.
const PRICE_INPUT_PER_M = 0.15;
const PRICE_OUTPUT_PER_M = 0.6;

const MODEL = 'gpt-4o-mini';
const SMART_COOLDOWN_MIN = 90; // don't fire two smart nudges in <90 min

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export interface SmartNudgeReport {
  ranAt: number;
  skipped: 'cost_cap' | 'no_key' | 'cooldown' | null;
  fired: boolean;
  level: NudgeLevel | null;
  title: string | null;
  body: string | null;
  reasoning: string | null;
  costUsd: number;
  durationMs: number;
  error: string | null;
}

interface ModelDecision {
  should_nudge: boolean;
  level: NudgeLevel;
  title: string;
  body: string;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are the smart-nudge layer of a personal-behavior phone app.
You run every 15 minutes. The user wants help breaking unproductive habits and
reinforcing good ones, but they will uninstall the app if it nudges too often
or about trivial things.

Hard rules:
- Default to should_nudge=false. Only fire when there is a clear, specific
  behavior pattern happening RIGHT NOW that a thoughtful friend would mention.
- Never repeat the gist of a notification already fired today.
- Pick the smallest level that gets the message across:
    1 = silent log entry (background reminder, no sound)
    2 = heads-up banner (mild attention)
    3 = modal alarm (only for serious drift, e.g. 2h+ doomscroll past midnight)
- Title ≤ 40 chars. Body ≤ 140 chars. Plain language, no emojis, no jargon.
- Reasoning ≤ 200 chars, references specific numbers from the context.

Output strict JSON matching this TypeScript type, nothing else:
{ "should_nudge": boolean, "level": 1 | 2 | 3, "title": string, "body": string, "reasoning": string }`;

export async function runSmartNudgeTick(): Promise<SmartNudgeReport> {
  const startedAt = Date.now();
  const tz = deviceTz();
  const result: SmartNudgeReport = {
    ranAt: startedAt,
    skipped: null,
    fired: false,
    level: null,
    title: null,
    body: null,
    reasoning: null,
    costUsd: 0,
    durationMs: 0,
    error: null,
  };

  try {
    const snapshot = await loadSnapshot();
    const todayCost = await sumTodayLlmCostUsd();
    if (todayCost >= snapshot.dailyCapUsd) {
      result.skipped = 'cost_cap';
      console.log(`[smart-nudge] skip: cost_cap ($${todayCost.toFixed(4)} ≥ $${snapshot.dailyCapUsd})`);
      return finish(result, startedAt);
    }
    const apiKey = await getOpenAiKey();
    if (!apiKey) {
      result.skipped = 'no_key';
      return finish(result, startedAt);
    }
    if (await isInSmartCooldown(startedAt)) {
      result.skipped = 'cooldown';
      return finish(result, startedAt);
    }

    const context = await buildSmartContext(tz, startedAt);
    const userPrompt = JSON.stringify(context, null, 2);

    const httpResponse = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const responseText = await httpResponse.text();
    if (!httpResponse.ok) {
      result.error = `http ${httpResponse.status}: ${responseText.slice(0, 200)}`;
      await logLlmCall({
        ts: startedAt,
        ok: false,
        inTokens: null,
        outTokens: null,
        costUsd: 0,
        request: userPrompt,
        response: responseText,
        error: result.error,
      });
      return finish(result, startedAt);
    }

    const parsed = parseOpenAiResponse(responseText);
    result.costUsd = computeCostUsd(parsed.inTokens, parsed.outTokens);
    const llmCallId = await logLlmCall({
      ts: startedAt,
      ok: true,
      inTokens: parsed.inTokens,
      outTokens: parsed.outTokens,
      costUsd: result.costUsd,
      request: userPrompt,
      response: parsed.rawContent,
      error: null,
    });

    const decision = parsed.decision;
    if (!decision || !decision.should_nudge) {
      console.log(`[smart-nudge] no nudge · cost=$${result.costUsd.toFixed(5)}`);
      return finish(result, startedAt);
    }

    const level = clampLevel(decision.level);
    await fireNudgeNotification({
      level,
      title: decision.title,
      body: decision.body,
      data: { source: 'smart', llmCallId },
    });
    await withDb(async (db) => {
      await db.runAsync(
        `INSERT INTO nudges_log
          (ts, source, rule_id, llm_call_id, reasoning, message, level)
         VALUES (?, 'smart', NULL, ?, ?, ?, ?)`,
        [startedAt, llmCallId, decision.reasoning, decision.body, level],
      );
    });

    result.fired = true;
    result.level = level;
    result.title = decision.title;
    result.body = decision.body;
    result.reasoning = decision.reasoning;
    console.log(
      `[smart-nudge] fired L${level} "${decision.title}" cost=$${result.costUsd.toFixed(5)}`,
    );
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error('[smart-nudge] failed:', result.error);
  }

  return finish(result, startedAt);
}

function finish(r: SmartNudgeReport, startedAt: number): SmartNudgeReport {
  r.durationMs = Date.now() - startedAt;
  return r;
}

// ────────────────────────────────────────────────────────────────────────────
// Cost cap + ledger
// ────────────────────────────────────────────────────────────────────────────

export async function sumTodayLlmCostUsd(): Promise<number> {
  return withDb(async (db) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const r = await db.getFirstAsync<{ total: number | null }>(
      `SELECT SUM(cost_usd) AS total FROM llm_calls WHERE ts >= ?`,
      [startOfDay.getTime()],
    );
    return r?.total ?? 0;
  });
}

interface LlmCallRowInsert {
  ts: number;
  ok: boolean;
  inTokens: number | null;
  outTokens: number | null;
  costUsd: number;
  request: string;
  response: string;
  error: string | null;
}

async function logLlmCall(row: LlmCallRowInsert): Promise<number> {
  return withDb(async (db) => {
    const r = await db.runAsync(
      `INSERT INTO llm_calls
        (ts, purpose, model, in_tokens, out_tokens, cost_usd, ok, error, request, response)
       VALUES (?, 'tick', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return r.lastInsertRowId;
  });
}

function computeCostUsd(inTok: number | null, outTok: number | null): number {
  const inCost = ((inTok ?? 0) * PRICE_INPUT_PER_M) / 1_000_000;
  const outCost = ((outTok ?? 0) * PRICE_OUTPUT_PER_M) / 1_000_000;
  return inCost + outCost;
}

async function isInSmartCooldown(now: number): Promise<boolean> {
  const since = now - SMART_COOLDOWN_MIN * 60_000;
  return withDb(async (db) => {
    const r = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM nudges_log WHERE source = 'smart' AND ts >= ?`,
      [since],
    );
    return (r?.n ?? 0) > 0;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Context builder
// ────────────────────────────────────────────────────────────────────────────

interface SmartNudgeContext {
  now_local: string;
  tz: string;
  current_place: string | null;
  today_rollup: unknown;
  recent_nudges: Array<{
    minutes_ago: number;
    source: string;
    level: number;
    message: string;
  }>;
}

async function buildSmartContext(tz: string, now: number): Promise<SmartNudgeContext> {
  return withDb(async (db) => {
    const today = localDateStr(now, tz);
    const dayStart = localDayStartMs(today, tz);
    const todayRollup = await loadTodayRollup(db, today);
    const recentNudges = await loadRecentNudges(db, now);
    const currentPlace = await loadCurrentPlace(db, dayStart);
    return {
      now_local: new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short',
      }).format(new Date(now)),
      tz,
      current_place: currentPlace,
      today_rollup: todayRollup,
      recent_nudges: recentNudges,
    };
  });
}

async function loadTodayRollup(
  db: SQLite.SQLiteDatabase,
  date: string,
): Promise<unknown> {
  const r = await db.getFirstAsync<{ data: string; productivity_score: number | null }>(
    `SELECT data, productivity_score FROM daily_rollup WHERE date = ?`,
    [date],
  );
  if (!r) return { date, note: 'no rollup yet' };
  try {
    const parsed = JSON.parse(r.data) as Record<string, unknown>;
    return { date, productivity_score: r.productivity_score, ...parsed };
  } catch {
    return { date, productivity_score: r.productivity_score, raw: r.data };
  }
}

async function loadRecentNudges(
  db: SQLite.SQLiteDatabase,
  now: number,
): Promise<Array<{ minutes_ago: number; source: string; level: number; message: string }>> {
  const since = now - 24 * 3600_000;
  const rows = await db.getAllAsync<{
    ts: number;
    source: string;
    level: number;
    message: string;
  }>(
    `SELECT ts, source, level, message FROM nudges_log
     WHERE ts >= ? ORDER BY ts DESC LIMIT 20`,
    [since],
  );
  return rows.map((r) => ({
    minutes_ago: Math.round((now - r.ts) / 60_000),
    source: r.source,
    level: r.level,
    message: r.message,
  }));
}

async function loadCurrentPlace(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
): Promise<string | null> {
  const r = await db.getFirstAsync<{ kind: string; payload: string } | null>(
    `SELECT kind, payload FROM events
     WHERE kind IN ('geo_enter','geo_exit') AND ts >= ?
     ORDER BY ts DESC LIMIT 1`,
    [dayStart - 24 * 3600_000],
  );
  if (!r || r.kind !== 'geo_enter') return null;
  try {
    const p = JSON.parse(r.payload) as { place_id?: unknown; label?: unknown };
    if (typeof p.label === 'string') return p.label;
    if (typeof p.place_id === 'string') return p.place_id;
  } catch {
    // ignore
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// OpenAI response parsing
// ────────────────────────────────────────────────────────────────────────────

interface ParsedOpenAi {
  decision: ModelDecision | null;
  inTokens: number | null;
  outTokens: number | null;
  rawContent: string;
}

function parseOpenAiResponse(responseText: string): ParsedOpenAi {
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    return { decision: null, inTokens: null, outTokens: null, rawContent: responseText };
  }
  if (typeof body !== 'object' || body === null) {
    return { decision: null, inTokens: null, outTokens: null, rawContent: responseText };
  }
  const obj = body as Record<string, unknown>;
  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const inTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const outTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === 'string' ? message.content : '';
  let decision: ModelDecision | null = null;
  if (content) {
    try {
      const parsed = JSON.parse(content) as Partial<ModelDecision>;
      if (
        typeof parsed.should_nudge === 'boolean' &&
        typeof parsed.title === 'string' &&
        typeof parsed.body === 'string' &&
        typeof parsed.reasoning === 'string'
      ) {
        decision = {
          should_nudge: parsed.should_nudge,
          level: clampLevel(parsed.level),
          title: parsed.title.slice(0, 80),
          body: parsed.body.slice(0, 200),
          reasoning: parsed.reasoning.slice(0, 240),
        };
      }
    } catch {
      // model returned non-JSON; treat as "no nudge"
    }
  }
  return { decision, inTokens, outTokens, rawContent: content || responseText };
}

function clampLevel(v: unknown): NudgeLevel {
  const n = Number(v);
  if (n === 1 || n === 2 || n === 3) return n;
  return 1;
}

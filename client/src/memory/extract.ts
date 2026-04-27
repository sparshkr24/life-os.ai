/**
 * Stage 13 — once-per-day memory extraction.
 *
 * For a given local date `forDate` (typically yesterday at nightly time):
 *   1. cost-cap + key check (hard wall, same as every other LLM call),
 *   2. gate via `schema_meta.last_extract_date` — skip if already done today,
 *   3. load that day's daily_rollup + a 7-day baseline summary,
 *   4. call gpt-4o-mini with strict-JSON output → array of memory candidates,
 *   5. for each candidate: `createMemory` (which embeds + inserts, or skips),
 *   6. log the extraction call to `llm_calls` (purpose='extract'),
 *   7. write `schema_meta.last_extract_date = forDate` on success.
 *
 * The model is told to be conservative: it MUST emit only patterns/causal
 * relationships supported by the rollup numbers. Per the v3 invariants,
 * memories are derived — never authoritative. Bad extraction = silent skip,
 * not a corrupted store (each row is gated by `createMemory`).
 *
 * Model swap is one constant. Set EXTRACT_MODEL = 'deepseek-chat' (or your
 * DeepSeek v3.2 endpoint) and adjust EXTRACT_URL/headers when wiring it up.
 */
import { withDb } from '../db';
import { getOpenAiKey, loadSnapshot } from '../secure/keys';
import { sumTodayLlmCostUsd } from '../brain/smartNudge';
import { createMemory, type MemoryInput } from './store';
import type { MemoryType } from '../db/schema';

const EXTRACT_MODEL = 'gpt-4o-mini';
const EXTRACT_URL = 'https://api.openai.com/v1/chat/completions';

// gpt-4o-mini pricing (USD per 1M tokens, April 2026).
const PRICE_INPUT_PER_M = 0.15;
const PRICE_OUTPUT_PER_M = 0.6;

const META_KEY_LAST_EXTRACT = 'last_extract_date';
const MAX_CANDIDATES = 6;
const MIN_ABS_IMPACT = 0.15; // gate: ignore weaker patterns

const SYSTEM_PROMPT = `You extract durable behavioral memories from a single day's rollup.

Hard rules:
- Output JSON ONLY, matching: { "memories": Array<Memory> } where
  Memory = {
    "type": "pattern" | "causal" | "prediction" | "habit",
    "summary": string,                 // ≤180 chars, plain language
    "cause": string?,                  // for type='causal' or 'prediction'
    "effect": string?,                 // for type='causal'
    "impact_score": number,            // [-1, 1]; negative = harmful
    "confidence": number,              // [0, 1]
    "tags": string[],                  // 2-6 short kebab-case strings
    "predicted_outcome": string?       // ONLY for type='prediction'
  }
- Emit AT MOST 6 memories. Quality > quantity. Skip the day if nothing notable.
- |impact_score| ≥ 0.15 OR omit. Trivial deviations are not memories.
- Numbers in summary/cause/effect MUST come from the rollup. No inventions.
- Causal memories REQUIRE both cause AND effect.
- Prediction memories REQUIRE predicted_outcome stating what should happen
  next given the cause (e.g. "next day's productivity_score will be < 0.6").
- No greetings. No prose outside the JSON object.`;

export interface ExtractReport {
  ranAt: number;
  forDate: string;
  skipped: 'cost_cap' | 'no_key' | 'already_done' | 'no_rollup' | null;
  candidates: number;
  inserted: number;
  costUsd: number;
  durationMs: number;
  error: string | null;
}

interface RawCandidate {
  type?: unknown;
  summary?: unknown;
  cause?: unknown;
  effect?: unknown;
  impact_score?: unknown;
  confidence?: unknown;
  tags?: unknown;
  predicted_outcome?: unknown;
}

const VALID_TYPES: ReadonlySet<MemoryType> = new Set([
  'pattern',
  'causal',
  'prediction',
  'habit',
]);

export async function runDailyMemoryExtraction(forDate: string): Promise<ExtractReport> {
  const startedAt = Date.now();
  const r: ExtractReport = {
    ranAt: startedAt,
    forDate,
    skipped: null,
    candidates: 0,
    inserted: 0,
    costUsd: 0,
    durationMs: 0,
    error: null,
  };

  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(forDate)) {
      r.error = 'forDate must be YYYY-MM-DD';
      return finish(r, startedAt);
    }

    if (await alreadyExtracted(forDate)) {
      r.skipped = 'already_done';
      return finish(r, startedAt);
    }

    const snapshot = await loadSnapshot();
    const todayCost = await sumTodayLlmCostUsd();
    if (todayCost >= snapshot.dailyCapUsd) {
      r.skipped = 'cost_cap';
      return finish(r, startedAt);
    }
    const apiKey = await getOpenAiKey();
    if (!apiKey) {
      r.skipped = 'no_key';
      return finish(r, startedAt);
    }

    const inputs = await loadExtractInputs(forDate);
    if (!inputs.target) {
      r.skipped = 'no_rollup';
      return finish(r, startedAt);
    }

    const userPrompt = buildUserPrompt(forDate, inputs);

    const httpResponse = await fetch(EXTRACT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    const responseText = await httpResponse.text();
    if (!httpResponse.ok) {
      r.error = `http ${httpResponse.status}: ${responseText.slice(0, 200)}`;
      await logExtractCall(startedAt, null, null, 0, false, r.error, userPrompt, responseText);
      return finish(r, startedAt);
    }

    const parsed = parseChatResponse(responseText);
    r.costUsd = computeCost(parsed.inTokens, parsed.outTokens);

    const candidates = extractCandidates(parsed.content);
    r.candidates = candidates.length;

    await logExtractCall(
      startedAt,
      parsed.inTokens,
      parsed.outTokens,
      r.costUsd,
      true,
      null,
      userPrompt,
      parsed.content.slice(0, 1000),
    );

    for (const c of candidates) {
      const id = await createMemory({ ...c, source_ref: `rollup:${forDate}`, rollup_date: forDate });
      if (id) r.inserted += 1;
    }

    await markExtracted(forDate);
    console.log(
      `[extract] ${forDate}: ${r.inserted}/${r.candidates} inserted cost=$${r.costUsd.toFixed(4)}`,
    );
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e);
    console.error('[extract] failed:', r.error);
  }
  return finish(r, startedAt);
}

export async function lastExtractDate(): Promise<string | null> {
  return withDb(async (db) => {
    const row = await db.getFirstAsync<{ value: string } | null>(
      `SELECT value FROM schema_meta WHERE key = ?`,
      [META_KEY_LAST_EXTRACT],
    );
    return row ? row.value : null;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Inputs + prompt
// ────────────────────────────────────────────────────────────────────────────

interface ExtractInputs {
  target: { date: string; productivity_score: number | null; data: Record<string, unknown> } | null;
  baseline: Array<{ date: string; productivity_score: number | null }>;
}

async function loadExtractInputs(forDate: string): Promise<ExtractInputs> {
  return withDb(async (db) => {
    const target = await db.getFirstAsync<{ date: string; data: string; productivity_score: number | null }>(
      `SELECT date, data, productivity_score FROM daily_rollup WHERE date = ?`,
      [forDate],
    );
    const baseline = await db.getAllAsync<{ date: string; productivity_score: number | null }>(
      `SELECT date, productivity_score FROM daily_rollup
       WHERE date < ? ORDER BY date DESC LIMIT 7`,
      [forDate],
    );
    return {
      target: target
        ? {
            date: target.date,
            productivity_score: target.productivity_score,
            data: safeParse(target.data) as Record<string, unknown>,
          }
        : null,
      baseline,
    };
  });
}

function buildUserPrompt(forDate: string, inputs: ExtractInputs): string {
  return `TARGET_DAY (${forDate}):
${JSON.stringify(inputs.target, null, 2)}

PRIOR_7_DAYS_PRODUCTIVITY:
${JSON.stringify(inputs.baseline, null, 2)}

Extract up to ${MAX_CANDIDATES} memories from TARGET_DAY. Respond with a single JSON object: { "memories": [...] }.`;
}

// ────────────────────────────────────────────────────────────────────────────
// Response parsing
// ────────────────────────────────────────────────────────────────────────────

interface ParsedChat {
  content: string;
  inTokens: number | null;
  outTokens: number | null;
}

function parseChatResponse(responseText: string): ParsedChat {
  const body = safeParse(responseText);
  if (typeof body !== 'object' || body === null) {
    return { content: responseText, inTokens: null, outTokens: null };
  }
  const obj = body as Record<string, unknown>;
  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const inTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const outTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = typeof first?.message?.content === 'string' ? first.message.content : '';
  return { content, inTokens, outTokens };
}

function extractCandidates(content: string): MemoryInput[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = safeParse(cleaned);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const arr = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(arr)) return [];

  const out: MemoryInput[] = [];
  for (const raw of arr.slice(0, MAX_CANDIDATES)) {
    const c = raw as RawCandidate;
    const type = typeof c.type === 'string' ? (c.type as MemoryType) : null;
    const summary = typeof c.summary === 'string' ? c.summary.trim() : '';
    const impact = typeof c.impact_score === 'number' ? c.impact_score : NaN;
    const confidence = typeof c.confidence === 'number' ? c.confidence : NaN;
    const tags = Array.isArray(c.tags)
      ? c.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
      : [];

    if (!type || !VALID_TYPES.has(type)) continue;
    if (summary.length === 0) continue;
    if (!Number.isFinite(impact) || !Number.isFinite(confidence)) continue;
    if (Math.abs(impact) < MIN_ABS_IMPACT) continue;
    if (confidence < 0 || confidence > 1) continue;
    if (impact < -1 || impact > 1) continue;

    const cause = typeof c.cause === 'string' ? c.cause : undefined;
    const effect = typeof c.effect === 'string' ? c.effect : undefined;
    const predicted = typeof c.predicted_outcome === 'string' ? c.predicted_outcome : undefined;

    if (type === 'causal' && (!cause || !effect)) continue;
    if (type === 'prediction' && !predicted) continue;

    out.push({
      type,
      summary: summary.slice(0, 240),
      cause,
      effect,
      impact_score: impact,
      confidence,
      tags,
      predicted_outcome: predicted,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Gate + logging
// ────────────────────────────────────────────────────────────────────────────

async function alreadyExtracted(forDate: string): Promise<boolean> {
  const last = await lastExtractDate();
  return last === forDate;
}

async function markExtracted(forDate: string): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [META_KEY_LAST_EXTRACT, forDate],
    );
  });
}

async function logExtractCall(
  ts: number,
  inTokens: number | null,
  outTokens: number | null,
  costUsd: number,
  ok: boolean,
  error: string | null,
  request: string,
  response: string,
): Promise<void> {
  try {
    await withDb(async (db) => {
      await db.runAsync(
        `INSERT INTO llm_calls
          (ts, purpose, model, in_tokens, out_tokens, cost_usd, ok, error, request, response)
         VALUES (?, 'extract', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ts,
          EXTRACT_MODEL,
          inTokens,
          outTokens,
          costUsd,
          ok ? 1 : 0,
          error,
          request.slice(0, 4000),
          response.slice(0, 2000),
        ],
      );
    });
  } catch (e) {
    console.warn('[extract] log failed:', (e as Error).message);
  }
}

function computeCost(inTok: number | null, outTok: number | null): number {
  return ((inTok ?? 0) * PRICE_INPUT_PER_M + (outTok ?? 0) * PRICE_OUTPUT_PER_M) / 1_000_000;
}

function finish(r: ExtractReport, startedAt: number): ExtractReport {
  r.durationMs = Date.now() - startedAt;
  return r;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

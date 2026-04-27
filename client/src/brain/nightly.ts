/**
 * Stage 8 — nightly behavior_profile rebuild.
 *
 * Runs once per local day, around 03:00, kicked by either:
 *   - Kotlin AlarmManager (preferred, fires at 03:05 → wakes the FG service
 *     → next 15 min aggregator tick picks it up via the watchdog)
 *   - the watchdog inside `runAggregatorTick`, which checks if it's past
 *     03:00 local AND > 20h since the last successful run
 *
 * Pipeline (all inside one function — `runNightlyRebuild`):
 *   1. cost cap check         — hard wall
 *   2. key check              — needs ANTHROPIC_API_KEY
 *   3. ensure yesterday's productivity_score is finalized (recompute once)
 *   4. computeNudgeEffectiveness for the last 7 days (fills score_delta)
 *   5. buildVerifiedFacts     — pre-computed correlations
 *   6. load PRIOR profile + last 30 daily_rollups + last 3 monthly_rollups
 *   7. call Sonnet            — strict JSON output
 *   8. validate               — must parse + have v3 keys
 *   9. UPSERT behavior_profile (id=1)
 *  10. log llm_calls          — always, even on failure
 *  11. write schema_meta.last_nightly_ts
 */
import { withDb } from '../db';
import { getAnthropicKey, loadSnapshot } from '../secure/keys';
import { sumTodayLlmCostUsd } from './smartNudge';
import { buildVerifiedFacts } from './verifiedFacts';
import { computeNudgeEffectiveness } from './nudgeEffectiveness';
import { computeProductivityScore } from './productivityScore';
import { NIGHTLY_SYSTEM_PROMPT, buildNightlyUserPrompt } from './nightly.prompt';
import type { BehaviorProfileV3 } from './behaviorProfile.types';
import { deviceTz, localDateStr, prevDate } from '../aggregator/time';
import { runDailyMemoryExtraction } from '../memory/extract';
import { retrieveContext } from '../memory/rag';

// claude-sonnet-4 pricing as of April 2026 (USD per 1M tokens).
const PRICE_INPUT_PER_M = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;

const MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_OUTPUT_TOKENS = 4096;

const META_KEY_LAST_NIGHTLY = 'last_nightly_ts';

export interface NightlyReport {
  ranAt: number;
  skipped: 'cost_cap' | 'no_key' | null;
  ok: boolean;
  basedOnDays: number;
  costUsd: number;
  durationMs: number;
  error: string | null;
}

export async function runNightlyRebuild(): Promise<NightlyReport> {
  const startedAt = Date.now();
  const tz = deviceTz();
  const result: NightlyReport = {
    ranAt: startedAt,
    skipped: null,
    ok: false,
    basedOnDays: 0,
    costUsd: 0,
    durationMs: 0,
    error: null,
  };

  try {
    const snapshot = await loadSnapshot();
    const todayCost = await sumTodayLlmCostUsd();
    if (todayCost >= snapshot.dailyCapUsd) {
      result.skipped = 'cost_cap';
      console.log(
        `[nightly] skip: cost_cap ($${todayCost.toFixed(4)} ≥ $${snapshot.dailyCapUsd})`,
      );
      return finish(result, startedAt);
    }
    const apiKey = await getAnthropicKey();
    if (!apiKey) {
      result.skipped = 'no_key';
      console.log('[nightly] skip: no anthropic key');
      return finish(result, startedAt);
    }

    const yesterday = prevDate(localDateStr(startedAt, tz));

    // Pre-LLM SQL pass: finalise yesterday's score + nudge effectiveness for
    // the last 7 days. Both idempotent.
    await withDb(async (db) => {
      await computeProductivityScore(db, yesterday);
      for (let i = 0; i < 7; i += 1) {
        const d = stepDate(yesterday, -i);
        await computeNudgeEffectiveness(db, d);
      }
    });

    // Stage 13: extract memories from yesterday's rollup before consolidating.
    // Self-gated by schema_meta.last_extract_date; cheap when already done.
    try {
      const ex = await runDailyMemoryExtraction(yesterday);
      if (ex.error) console.warn('[nightly] extract error:', ex.error);
    } catch (e) {
      console.warn('[nightly] extract threw:', (e as Error).message);
    }

    const { prior, days, months, verifiedFacts } = await loadNightlyInputs();
    result.basedOnDays = days.length;

    // Stage 13: RAG — retrieve memories relevant to consolidation.
    const memoryBlock = await buildNightlyMemoryBlock(days);

    const userPrompt =
      buildNightlyUserPrompt({ prior, days, months, verifiedFacts }) +
      (memoryBlock ? `\n\n${memoryBlock}` : '');

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
        system: NIGHTLY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const responseText = await httpResponse.text();
    if (!httpResponse.ok) {
      result.error = `http ${httpResponse.status}: ${responseText.slice(0, 200)}`;
      await logNightlyCall({
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

    const parsed = parseAnthropicResponse(responseText);
    result.costUsd = computeCostUsd(parsed.inTokens, parsed.outTokens);

    await logNightlyCall({
      ts: startedAt,
      ok: parsed.profile != null,
      inTokens: parsed.inTokens,
      outTokens: parsed.outTokens,
      costUsd: result.costUsd,
      request: userPrompt,
      response: parsed.rawContent,
      error: parsed.profile ? null : 'malformed_profile_json',
    });

    if (!parsed.profile) {
      result.error = 'model returned malformed JSON';
      return finish(result, startedAt);
    }

    await persistProfile(parsed.profile, days.length, startedAt);
    await markNightlyComplete(startedAt);
    result.ok = true;
    console.log(
      `[nightly] ok days=${days.length} cost=$${result.costUsd.toFixed(4)} in ${
        Date.now() - startedAt
      }ms`,
    );
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error('[nightly] failed:', result.error);
  }

  return finish(result, startedAt);
}

function finish(r: NightlyReport, startedAt: number): NightlyReport {
  r.durationMs = Date.now() - startedAt;
  return r;
}

// ────────────────────────────────────────────────────────────────────────────
// Watchdog — called from the 15-min aggregator tick
// ────────────────────────────────────────────────────────────────────────────

const NIGHTLY_HOUR_LOCAL = 3;
const NIGHTLY_MIN_GAP_MS = 20 * 3600_000; // 20h since last success

/**
 * If it's past 03:00 local AND we haven't run a successful nightly in 20+ h,
 * run one now. Cheap (one schema_meta read) when it's not time yet.
 */
export async function maybeRunNightlyWatchdog(): Promise<NightlyReport | null> {
  const now = Date.now();
  const tz = deviceTz();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(
      new Date(now),
    ),
  );
  if (hour < NIGHTLY_HOUR_LOCAL) return null;

  const last = await readLastNightlyTs();
  if (last && now - last < NIGHTLY_MIN_GAP_MS) return null;

  console.log('[nightly] watchdog firing (last=' + (last ?? 'never') + ')');
  return runNightlyRebuild();
}

async function readLastNightlyTs(): Promise<number | null> {
  return withDb(async (db) => {
    const r = await db.getFirstAsync<{ value: string } | null>(
      `SELECT value FROM schema_meta WHERE key = ?`,
      [META_KEY_LAST_NIGHTLY],
    );
    if (!r) return null;
    const n = Number(r.value);
    return Number.isFinite(n) ? n : null;
  });
}

async function markNightlyComplete(ts: number): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [META_KEY_LAST_NIGHTLY, String(ts)],
    );
  });
}

export async function lastNightlyTs(): Promise<number | null> {
  return readLastNightlyTs();
}

// ────────────────────────────────────────────────────────────────────────────
// Inputs + persistence
// ────────────────────────────────────────────────────────────────────────────

interface NightlyInputs {
  prior: unknown;
  days: unknown[];
  months: unknown[];
  verifiedFacts: Awaited<ReturnType<typeof buildVerifiedFacts>>;
}

async function loadNightlyInputs(): Promise<NightlyInputs> {
  return withDb(async (db) => {
    const priorRow = await db.getFirstAsync<{ data: string } | null>(
      `SELECT data FROM behavior_profile WHERE id = 1`,
    );
    const prior = priorRow ? safeParse(priorRow.data) : {};

    const dayRows = await db.getAllAsync<{ date: string; data: string; productivity_score: number | null }>(
      `SELECT date, data, productivity_score FROM daily_rollup
       ORDER BY date DESC LIMIT 30`,
    );
    const days = dayRows.map((r) => ({
      date: r.date,
      productivity_score: r.productivity_score,
      ...(safeParse(r.data) as Record<string, unknown>),
    }));

    const monthRows = await db.getAllAsync<{ month: string; data: string }>(
      `SELECT month, data FROM monthly_rollup ORDER BY month DESC LIMIT 3`,
    );
    const months = monthRows.map((r) => ({
      month: r.month,
      ...(safeParse(r.data) as Record<string, unknown>),
    }));

    const verifiedFacts = await buildVerifiedFacts(db);
    return { prior, days, months, verifiedFacts };
  });
}

async function persistProfile(
  profile: BehaviorProfileV3,
  basedOnDays: number,
  ts: number,
): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO behavior_profile (id, data, built_ts, based_on_days, model)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         built_ts = excluded.built_ts,
         based_on_days = excluded.based_on_days,
         model = excluded.model`,
      [JSON.stringify(profile), ts, basedOnDays, MODEL],
    );
  });
}

interface NightlyLlmRow {
  ts: number;
  ok: boolean;
  inTokens: number | null;
  outTokens: number | null;
  costUsd: number;
  request: string;
  response: string;
  error: string | null;
}

async function logNightlyCall(row: NightlyLlmRow): Promise<void> {
  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO llm_calls
        (ts, purpose, model, in_tokens, out_tokens, cost_usd, ok, error, request, response)
       VALUES (?, 'nightly', ?, ?, ?, ?, ?, ?, ?, ?)`,
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

function computeCostUsd(inTok: number | null, outTok: number | null): number {
  const inCost = ((inTok ?? 0) * PRICE_INPUT_PER_M) / 1_000_000;
  const outCost = ((outTok ?? 0) * PRICE_OUTPUT_PER_M) / 1_000_000;
  return inCost + outCost;
}

// ────────────────────────────────────────────────────────────────────────────
// Anthropic response parsing + validation
// ────────────────────────────────────────────────────────────────────────────

interface ParsedAnthropic {
  profile: BehaviorProfileV3 | null;
  inTokens: number | null;
  outTokens: number | null;
  rawContent: string;
}

function parseAnthropicResponse(responseText: string): ParsedAnthropic {
  const body = safeParse(responseText);
  if (typeof body !== 'object' || body === null) {
    return { profile: null, inTokens: null, outTokens: null, rawContent: responseText };
  }
  const obj = body as Record<string, unknown>;
  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const inTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
  const outTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  const content = Array.isArray(obj.content) ? obj.content : [];
  const firstText = content.find(
    (c): c is { type: 'text'; text: string } =>
      typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' &&
      typeof (c as { text?: unknown }).text === 'string',
  );
  const rawContent = firstText?.text ?? responseText;
  const profile = validateProfile(rawContent);
  return { profile, inTokens, outTokens, rawContent };
}

/** Strips ```json fences if Sonnet adds them, then JSON.parses + sanity-checks. */
function validateProfile(text: string): BehaviorProfileV3 | null {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const parsed = safeParse(cleaned);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  // v3 sentinel keys must exist (even if empty arrays).
  if (!('causal_chains' in obj) || !('rule_suggestions' in obj)) return null;
  return obj as unknown as BehaviorProfileV3;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stepDate(date: string, deltaDays: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the RAG memory block for the nightly user prompt. Empty string when
 * we have no embeddable signal yet (no memories, embed failure, cost cap) so
 * the prompt cleanly degrades to the v2 path.
 */
async function buildNightlyMemoryBlock(days: unknown[]): Promise<string> {
  try {
    const recent = days.slice(0, 4) as Array<Record<string, unknown>>;
    const queryText = recent
      .map((d) => {
        const date = typeof d.date === 'string' ? d.date : '?';
        const score =
          typeof d.productivity_score === 'number' ? d.productivity_score.toFixed(2) : 'n/a';
        return `${date} score=${score}`;
      })
      .join(' | ');
    if (!queryText) return '';
    const r = await retrieveContext({
      decisionType: 'nightly_consolidation',
      queryText,
      k: 12,
    });
    if (!r.embedded || r.memories.length === 0) return '';
    return r.contextBlock;
  } catch (e) {
    console.warn('[nightly] rag failed:', (e as Error).message);
    return '';
  }
}

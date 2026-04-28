/**
 * Nightly two-pass tool-calling session (v3 Phase E, raw-events-aware).
 *
 * Watchdog fires once per night around 03:05 local. We split the work into
 * two separate model runs:
 *
 *   Pass 1  — runMemoryPass(yesterday)
 *     Goal: build the most accurate possible mental model of yesterday from
 *     primary evidence (raw events with `_ctx` ambient blocks) and reconcile
 *     it with the existing memory store.
 *     Tool scope: 'nightly_memory' (read tools + memory mutation tools +
 *     set_app_category). Side effects ARE the output — no JSON parsing.
 *
 *   Pass 2  — runProfilePass(yesterday)
 *     Goal: rebuild behavior_profile.data from rollups + verifiedFacts +
 *     a digest of the (now-refreshed) memory store. Read-only tools only.
 *     Output: the new behavior_profile JSON (assistant's last message).
 *
 * Splitting the passes is intentional (see ARCHITECTURE.md §7.3):
 *   - Different context size: memory pass eats 50–200k tok of raw events;
 *     profile pass stays under 20k.
 *   - Failure isolation: a malformed profile JSON cannot lose the memories
 *     the memory pass already saved.
 *   - Different temperature needs (memory = interpretive; profile = deterministic).
 *
 * Hard invariants (CLAUDE.md §7, §11–§12):
 *   - Raw events go to runMemoryPass ONLY. Every other call sees rollups +
 *     memory context.
 *   - Memory mutation is restricted to feedback columns. summary/cause/
 *     effect/embedding are immutable after createMemory.
 *   - Original event payload/ts/kind are immutable forever.
 */
import { withDb } from '../db';
import { buildVerifiedFacts } from './verifiedFacts';
import { computeNudgeEffectiveness } from './nudgeEffectiveness';
import { computeProductivityScore } from './productivityScore';
import type { BehaviorProfileV3 } from './behaviorProfile.types';
import { deviceTz, localDateStr, prevDate } from '../aggregator/time';
import { runChatTask } from '../llm/router';
import { DEFAULT_TASK_MODELS } from '../llm/models';
import { getToolsForScope, type ToolScope } from './tools';
import type { ChatMessage, ToolDefinition } from '../llm/types';
import { loadRawEventsForDate, MAX_EVENTS_FOR_MEMORY } from './rawEvents';

const MEMORY_TOOL_LOOPS = 8;
const PROFILE_TOOL_LOOPS = 4;
const MEMORY_MAX_OUTPUT_TOKENS = 2048;
const PROFILE_MAX_OUTPUT_TOKENS = 4096;
const META_KEY_LAST_NIGHTLY = 'last_nightly_ts';

export interface NightlyReport {
  ranAt: number;
  yesterday: string;
  memory: PassReport;
  profile: PassReport;
  ok: boolean;
  durationMs: number;
}

interface PassReport {
  skipped: 'cost_cap' | 'no_key' | null;
  ok: boolean;
  costUsd: number;
  toolTurns: number;
  error: string | null;
  lastModelId?: string;
}

const EMPTY_PASS: PassReport = {
  skipped: null,
  ok: false,
  costUsd: 0,
  toolTurns: 0,
  error: null,
};

const MEMORY_SYSTEM_PROMPT = `You are the on-device memory builder for a single-user life-OS. You run once per night. Your single job is to capture what actually happened yesterday, in the user's own context, with enough precision that another AI later can predict the user's next move.

You are seeing the FULL raw event timeline of yesterday (every app foreground, notification, geofence transition, screen on/off, sleep/wake, activity recognition, health snapshot, etc.). Each event line is:

  HH:MM:SS [kind] <payload-json>

The payload includes a "_ctx" block stamped at insert time with ambient phone state: place_id, batt (battery %), charging, net (network type), audio (output device). Use these to ground every memory in real conditions. NEVER invent a location, a time, or a duration that isn't in the timeline.

Workflow:
  1. EXTRACT new memories — call 'create_memory' for each pattern, behaviour
     trigger, or causal chain you observe. Be specific. Bad: "user was on
     phone in evening". Good: "after 22:00 at home on wifi with phone
     unplugged, opens Instagram for 40+ min sessions; correlates with late
     sleep next day". Use types: causal | habit | prediction | preference |
     identity. Predictions MUST set predicted_outcome.
  2. VERIFY predictions — for each unverified prediction whose target date
     has passed, call 'verify_memory' with the actual_outcome derived from
     yesterday's events/rollup and was_correct.
  3. REINFORCE / CONTRADICT — if yesterday confirms an existing memory call
     'reinforce_memory'; if it directly contradicts one call
     'contradict_memory'. Use 'mark_memory_archived' only for clearly
     superseded memories with a one-line reason.
  4. CONSOLIDATE — if 3+ specific memories share a clear pattern, call
     'consolidate_memories' to create an abstract parent. Children must keep
     their full evidence; the parent is just the summary.
  5. ENRICH app_categories — call 'get_app_categories(only_unenriched=true)'
     and for each pkg call 'set_app_category' with category + subcategory +
     a one-line details note. If you cannot tell from the package id alone,
     leave it.

HARD RULES:
  - You CANNOT modify event metadata (ts, kind, payload) — it is the primary
    record.
  - You CANNOT rewrite a memory's summary/cause/effect/embedding. Only
    feedback columns are mutable. To "fix" a wrong memory: archive it and
    create a new one.
  - Quote concrete evidence from the timeline in 'cause' and 'effect'
    fields when relevant — exact times, place_ids, app names.
  - Skip noise. Don't create memories for routine app opens unless they
    cluster into a pattern.

Reply with a brief plain-text summary of what you did (counts of created /
verified / reinforced / contradicted / archived / consolidated / enriched).
No JSON. No code fences.`;

const PROFILE_SYSTEM_PROMPT = `You are the on-device behavior modeler for a single-user life-OS. The memory pass has already run for yesterday. Your job now is to rebuild behavior_profile.data from the rollups, the verified-facts block, and the freshly-updated memory store.

You have READ-ONLY tools. Use 'search_memories', 'get_memory', 'get_recent_rollups', 'get_recent_nudges', etc. to ground claims. Do NOT call any write tools.

Hard rules:
  1. Output ONE JSON object matching the schema below as your FINAL message.
     No prose. No markdown fences.
  2. Every quantitative claim MUST be derived from the provided rollups or
     VERIFIED_FACTS. Do NOT invent numbers.
  3. The productivity_score on each daily_rollup is ground truth for "how
     good was that day". Use it; do not recompute.
  4. silence_correlations MUST be VERIFIED_FACTS verbatim.
  5. Every causal_chain MUST cite an upstream date and a downstream date and
     reference at least one numeric metric from each.
  6. Every rule_suggestion MUST be expressible as a deterministic trigger
     (time-window + app/place + threshold). No fuzzy conditions.
  7. Confidence values are in [0,1]. Use 0.5 when guessing.
  8. If a section has no entries, return an empty array for it.

Final JSON shape:
{
  "causal_chains":        [CausalChain],
  "day_attribution":      DayAttribution,
  "rule_suggestions":     [RuleSuggestion],
  "silence_priors":       SilencePriors,
  "silence_correlations": [SilenceCorrelation]
}`;

// ────────────────────────────────────────────────────────────────────────────
// Top-level runner
// ────────────────────────────────────────────────────────────────────────────

export async function runNightlyRebuild(): Promise<NightlyReport> {
  const startedAt = Date.now();
  const tz = deviceTz();
  const yesterday = prevDate(localDateStr(startedAt, tz));

  const report: NightlyReport = {
    ranAt: startedAt,
    yesterday,
    memory: { ...EMPTY_PASS },
    profile: { ...EMPTY_PASS },
    ok: false,
    durationMs: 0,
  };

  try {
    // Pre-LLM idempotent SQL.
    await withDb(async (db) => {
      await computeProductivityScore(db, yesterday);
      for (let i = 0; i < 7; i += 1) {
        await computeNudgeEffectiveness(db, stepDate(yesterday, -i));
      }
    });

    report.memory = await runMemoryPass(yesterday);

    // Profile rebuild only proceeds if memory pass didn't burn the cap.
    if (report.memory.skipped === 'cost_cap') {
      console.log('[nightly] cap hit during memory pass, skipping profile rebuild');
    } else {
      report.profile = await runProfilePass(yesterday);
    }

    if (report.memory.ok || report.profile.ok) {
      await markNightlyComplete(startedAt);
    }
    report.ok = report.memory.ok && report.profile.ok;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[nightly] failed:', message);
    if (!report.memory.error) report.memory.error = message;
  }

  report.durationMs = Date.now() - startedAt;
  console.log(
    `[nightly] yesterday=${yesterday} memory=${describePass(report.memory)} profile=${describePass(report.profile)} totalMs=${report.durationMs}`,
  );
  return report;
}

function describePass(p: PassReport): string {
  if (p.skipped) return `skip:${p.skipped}`;
  if (p.error) return `error:${p.error}`;
  if (p.ok) return `ok turns=${p.toolTurns} cost=$${p.costUsd.toFixed(4)}`;
  return 'noop';
}

// ────────────────────────────────────────────────────────────────────────────
// Pass 1 — memory
// ────────────────────────────────────────────────────────────────────────────

async function runMemoryPass(yesterday: string): Promise<PassReport> {
  const report: PassReport = { ...EMPTY_PASS };
  try {
    const timeline = await loadRawEventsForDate(yesterday);
    const memoryInputs = await loadMemoryPassInputs(yesterday);
    const userPrompt = buildMemoryUserPrompt(yesterday, timeline, memoryInputs);

    const finalText = await runToolLoop({
      scope: 'nightly_memory',
      system: MEMORY_SYSTEM_PROMPT,
      userPrompt,
      maxLoops: MEMORY_TOOL_LOOPS,
      maxOutputTokens: MEMORY_MAX_OUTPUT_TOKENS,
      report,
    });

    if (finalText !== null) {
      report.ok = true;
      console.log(`[nightly:memory] ${finalText.slice(0, 240)}`);
    }
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    console.error('[nightly:memory] failed:', report.error);
  }
  return report;
}

interface MemoryPassInputs {
  priorProfile: unknown;
  yesterdayRollup: unknown;
  unverifiedPredictions: Array<{
    id: string;
    summary: string;
    predicted_outcome: string;
    rollup_date: string | null;
  }>;
  unenrichedAppCount: number;
}

async function loadMemoryPassInputs(yesterday: string): Promise<MemoryPassInputs> {
  return withDb(async (db) => {
    const priorRow = await db.getFirstAsync<{ data: string } | null>(
      `SELECT data FROM behavior_profile WHERE id = 1`,
    );
    const priorProfile = priorRow ? safeParse(priorRow.data) : {};

    const rollupRow = await db.getFirstAsync<{ data: string; productivity_score: number | null } | null>(
      `SELECT data, productivity_score FROM daily_rollup WHERE date = ?`,
      [yesterday],
    );
    const yesterdayRollup = rollupRow
      ? { ...(safeParse(rollupRow.data) as Record<string, unknown>), productivity_score: rollupRow.productivity_score }
      : null;

    const predictionRows = await db.getAllAsync<{
      id: string;
      summary: string;
      predicted_outcome: string;
      rollup_date: string | null;
    }>(
      `SELECT id, summary, predicted_outcome, rollup_date FROM memories
       WHERE archived_ts IS NULL
         AND type = 'prediction'
         AND predicted_outcome IS NOT NULL
         AND was_correct IS NULL
         AND (rollup_date IS NULL OR rollup_date <= ?)
       ORDER BY created_ts DESC LIMIT 30`,
      [yesterday],
    );

    const unenrichedRow = await db.getFirstAsync<{ count: number } | null>(
      `SELECT COUNT(*) as count FROM app_categories WHERE enriched = 0`,
    );

    return {
      priorProfile,
      yesterdayRollup,
      unverifiedPredictions: predictionRows,
      unenrichedAppCount: unenrichedRow?.count ?? 0,
    };
  });
}

function buildMemoryUserPrompt(
  yesterday: string,
  timeline: Awaited<ReturnType<typeof loadRawEventsForDate>>,
  inputs: MemoryPassInputs,
): string {
  const weekday = new Date(yesterday + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });
  const lines: string[] = [];
  lines.push(`# Yesterday`);
  lines.push(`Date: ${yesterday} (${weekday})`);
  lines.push(
    `Events: ${timeline.totalEvents} total, ${timeline.emittedEvents} shown` +
      (timeline.droppedAppFg > 0 ? `, dropped ${timeline.droppedAppFg} short app_fg` : '') +
      (timeline.truncated ? ` (capped at ${MAX_EVENTS_FOR_MEMORY})` : ''),
  );
  lines.push(`Unverified predictions targeting yesterday: ${inputs.unverifiedPredictions.length}`);
  lines.push(`Unenriched app_categories rows: ${inputs.unenrichedAppCount}`);
  lines.push('');
  lines.push(`## Yesterday's daily_rollup (deterministic summary, for cross-checking):`);
  lines.push(JSON.stringify(inputs.yesterdayRollup ?? null, null, 2));
  lines.push('');
  lines.push(`## Prior behavior_profile snapshot:`);
  lines.push(JSON.stringify(inputs.priorProfile ?? {}, null, 2));
  lines.push('');
  lines.push(`## Unverified predictions you should call verify_memory on:`);
  lines.push(JSON.stringify(inputs.unverifiedPredictions, null, 2));
  lines.push('');
  lines.push(`## Yesterday's full event timeline (one event per line, chronological):`);
  lines.push('```');
  lines.push(...timeline.lines);
  lines.push('```');
  lines.push('');
  lines.push(
    `Now do the work. Call tools as needed. When done, reply with a one-paragraph summary of counts.`,
  );
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Pass 2 — profile
// ────────────────────────────────────────────────────────────────────────────

async function runProfilePass(yesterday: string): Promise<PassReport> {
  const report: PassReport = { ...EMPTY_PASS };
  try {
    const inputs = await loadProfilePassInputs();
    const userPrompt = buildProfileUserPrompt(yesterday, inputs);

    const finalText = await runToolLoop({
      scope: 'nightly_profile',
      system: PROFILE_SYSTEM_PROMPT,
      userPrompt,
      maxLoops: PROFILE_TOOL_LOOPS,
      maxOutputTokens: PROFILE_MAX_OUTPUT_TOKENS,
      report,
    });

    if (finalText === null) return report;

    const profile = validateProfile(finalText);
    if (!profile) {
      report.error = 'model returned malformed JSON';
      return report;
    }

    await persistProfile(profile, inputs.days.length, Date.now(), report.lastModelId ?? DEFAULT_TASK_MODELS.nightly);
    report.ok = true;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    console.error('[nightly:profile] failed:', report.error);
  }
  return report;
}

interface ProfilePassInputs {
  prior: unknown;
  days: unknown[];
  months: unknown[];
  verifiedFacts: Awaited<ReturnType<typeof buildVerifiedFacts>>;
  topMemories: Array<{
    id: string;
    type: string;
    summary: string;
    impact_score: number;
    confidence: number;
    occurrences: number;
    was_correct: number | null;
  }>;
}

async function loadProfilePassInputs(): Promise<ProfilePassInputs> {
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

    // Digest of the memory store: top 25 by |impact| × confidence.
    const topMemories = await db.getAllAsync<{
      id: string;
      type: string;
      summary: string;
      impact_score: number;
      confidence: number;
      occurrences: number;
      was_correct: number | null;
    }>(
      `SELECT id, type, summary, impact_score, confidence, occurrences, was_correct
       FROM memories
       WHERE archived_ts IS NULL
       ORDER BY (ABS(impact_score) * confidence) DESC
       LIMIT 25`,
    );

    return { prior, days, months, verifiedFacts, topMemories };
  });
}

function buildProfileUserPrompt(yesterday: string, input: ProfilePassInputs): string {
  const lines: string[] = [];
  lines.push(`YESTERDAY: ${yesterday}`);
  lines.push('');
  lines.push('PRIOR_PROFILE:');
  lines.push(JSON.stringify(input.prior ?? {}, null, 2));
  lines.push('');
  lines.push('DAYS (last 30, newest first):');
  lines.push(JSON.stringify(input.days, null, 2));
  lines.push('');
  lines.push('MONTHS (last 3):');
  lines.push(JSON.stringify(input.months, null, 2));
  lines.push('');
  lines.push('VERIFIED_FACTS (use these verbatim in silence_correlations):');
  lines.push(JSON.stringify(input.verifiedFacts, null, 2));
  lines.push('');
  lines.push('TOP_MEMORIES (digest of the freshly-updated memory store; use as evidence):');
  lines.push(JSON.stringify(input.topMemories, null, 2));
  lines.push('');
  lines.push(
    'Use the read tools to dig deeper into any memory or rollup if you need to. When done, return ONLY the merged behavior_profile.data JSON.',
  );
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Tool loop runner — shared by both passes
// ────────────────────────────────────────────────────────────────────────────

interface ToolLoopArgs {
  scope: ToolScope;
  system: string;
  userPrompt: string;
  maxLoops: number;
  maxOutputTokens: number;
  report: PassReport & { lastModelId?: string };
}

async function runToolLoop(args: ToolLoopArgs): Promise<string | null> {
  const tools = getToolsForScope(args.scope);
  const messages: ChatMessage[] = [{ role: 'user', content: args.userPrompt }];
  const toolDefs: ToolDefinition[] = tools.defs;

  for (let loop = 0; loop < args.maxLoops; loop += 1) {
    const callRes = await runChatTask('nightly', {
      system: args.system,
      messages,
      tools: toolDefs,
      maxOutputTokens: args.maxOutputTokens,
    });

    if (callRes.kind === 'skipped') {
      args.report.skipped = callRes.reason === 'cap_exceeded' ? 'cost_cap' : 'no_key';
      console.log(`[nightly:${args.scope}] skip: ${callRes.reason} (loop=${loop})`);
      return null;
    }
    if (callRes.kind === 'failed') {
      args.report.error = callRes.reason;
      console.warn(`[nightly:${args.scope}] failed:`, callRes.reason);
      return null;
    }

    const response = callRes.response;
    args.report.costUsd += response.usage.costUsd;
    args.report.toolTurns = loop + 1;
    args.report.lastModelId = response.modelId;

    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
      return response.text;
    }

    for (const toolCall of response.toolCalls) {
      let toolResult: unknown;
      try {
        toolResult = await tools.run(toolCall.name, toolCall.arguments);
      } catch (e) {
        toolResult = { error: e instanceof Error ? e.message : String(e) };
      }
      messages.push({
        role: 'tool',
        toolResultFor: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  args.report.error = `tool loop exhausted (${args.maxLoops}) without final answer`;
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Watchdog — called from the 15-min aggregator tick
// ────────────────────────────────────────────────────────────────────────────

const NIGHTLY_HOUR_LOCAL = 3;
const NIGHTLY_MIN_GAP_MS = 20 * 3600_000; // 20h since last success

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
    const row = await db.getFirstAsync<{ value: string } | null>(
      `SELECT value FROM schema_meta WHERE key = ?`,
      [META_KEY_LAST_NIGHTLY],
    );
    if (!row) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
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
// Profile validation + persistence
// ────────────────────────────────────────────────────────────────────────────

async function persistProfile(
  profile: BehaviorProfileV3,
  basedOnDays: number,
  ts: number,
  modelId: string,
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
      [JSON.stringify(profile), ts, basedOnDays, modelId],
    );
  });
}

function validateProfile(text: string): BehaviorProfileV3 | null {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace >= 0 && lastBrace < cleaned.length - 1) {
    cleaned = cleaned.slice(0, lastBrace + 1);
  }

  const parsed = safeParse(cleaned);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
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

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
import { runMemoryMaintenance } from '../memory/maintenance';

const MEMORY_TOOL_LOOPS = 8;
const PROFILE_TOOL_LOOPS = 4;
const NUDGE_TOOL_LOOPS = 6;
const MEMORY_MAX_OUTPUT_TOKENS = 2048;
const PROFILE_MAX_OUTPUT_TOKENS = 4096;
const NUDGE_MAX_OUTPUT_TOKENS = 2048;
const META_KEY_LAST_NIGHTLY = 'last_nightly_ts';

export interface NightlyReport {
  ranAt: number;
  yesterday: string;
  memory: PassReport;
  profile: PassReport;
  nudge: PassReport;
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

CONFIDENCE & ARCHIVAL ARE AUTOMATIC. After your tool loop ends a deterministic SQL sweep runs that:
  • bumps confidence +0.05 on every reinforce_memory and -0.10 on every contradict_memory
  • soft-archives memories with was_correct=0 AND reinforcement=0 (failed predictions never re-confirmed)
  • soft-archives memories with contradiction ≥ 3 AND contradiction ≥ 2× reinforcement (consistently disproven)
  • soft-archives memories with confidence < 0.10 AND reinforcement = 0
  • soft-archives consolidation children whose parent has been alive ≥14d
You only need to call mark_memory_archived for clearly superseded memories that don't fit those rules. Don't bookkeep — just send the right signal.

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
    nudge: { ...EMPTY_PASS },
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
      console.log('[nightly] cap hit during memory pass, skipping profile + nudge passes');
    } else {
      report.profile = await runProfilePass(yesterday);
      // Nudge pass needs the just-written profile; skip if profile failed
      // or the cap is exhausted.
      if (report.profile.skipped === 'cost_cap') {
        console.log('[nightly] cap hit during profile pass, skipping nudge pass');
      } else if (!report.profile.ok) {
        console.log('[nightly] profile pass did not succeed, skipping nudge pass');
      } else {
        report.nudge = await runNudgePass(yesterday);
      }
    }

    if (report.memory.ok || report.profile.ok || report.nudge.ok) {
      await markNightlyComplete(startedAt);
    }
    report.ok = report.memory.ok && report.profile.ok && report.nudge.ok;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[nightly] failed:', message);
    if (!report.memory.error) report.memory.error = message;
  }

  report.durationMs = Date.now() - startedAt;
  console.log(
    `[nightly] yesterday=${yesterday} memory=${describePass(report.memory)} profile=${describePass(report.profile)} nudge=${describePass(report.nudge)} totalMs=${report.durationMs}`,
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
      // Stage 15/16: deterministic sweep that closes the feedback loop after
      // the LLM has done its interpretive work. Pure SQL — never throws cost.
      try {
        const sweep = await runMemoryMaintenance();
        console.log(
          `[nightly:memory] maintenance sweep: failed=${sweep.archivedFailedPredictions} ` +
            `contradicted=${sweep.archivedContradicted} ` +
            `lowConfidence=${sweep.archivedLowConfidence} ` +
            `supersededChildren=${sweep.archivedSupersededChildren}`,
        );
      } catch (e) {
        console.error(
          '[nightly:memory] maintenance sweep failed:',
          e instanceof Error ? e.message : String(e),
        );
      }
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
  shakyMemories: Array<{
    id: string;
    type: string;
    summary: string;
    confidence: number;
    reinforcement: number;
    contradiction: number;
    was_correct: number | null;
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

    // Memories whose evidence is shaky: at least one contradiction, OR a low
    // confidence with no reinforcement. The LLM may decide to revise (cause/
    // effect was wrong → archive + create new), reinforce (today's events
    // actually confirm it), or leave alone (one-off miss). The post-pass
    // deterministic sweep will catch the rest.
    const shakyMemories = await db.getAllAsync<{
      id: string;
      type: string;
      summary: string;
      confidence: number;
      reinforcement: number;
      contradiction: number;
      was_correct: number | null;
    }>(
      `SELECT id, type, summary, confidence, reinforcement, contradiction, was_correct
       FROM memories
       WHERE archived_ts IS NULL
         AND (contradiction >= 1 OR (confidence < 0.4 AND reinforcement = 0))
       ORDER BY contradiction DESC, confidence ASC
       LIMIT 20`,
    );

    return {
      priorProfile,
      yesterdayRollup,
      unverifiedPredictions: predictionRows,
      shakyMemories,
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
  lines.push(
    `## Shaky memories (contradictions or low confidence) — review against today's evidence:`,
  );
  lines.push(
    `For each, decide: reinforce_memory (today confirms it), contradict_memory (today refutes it again), or leave alone. The post-pass sweep auto-archives anything with ≥3 contradictions and ratio ≥2:1 vs reinforcement.`,
  );
  lines.push(JSON.stringify(inputs.shakyMemories, null, 2));
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
// Pass 3 — nudge rules (Stage 14)
// ────────────────────────────────────────────────────────────────────────────

const NUDGE_SYSTEM_PROMPT = `You are the on-device nudge-rule curator for a single-user life-OS. You run AFTER the memory pass and the profile pass. Your job is to keep the user's nudge rules sharp and personalised: create new ones grounded in causal memories, refine existing LLM-generated rules based on observed effectiveness, and disable ones that are demonstrably annoying or net-negative.

You have these write tools (LLM-rules ONLY — refuses on user/seed rules):
  - create_rule({name, trigger, action, cooldown_min, predicted_impact_score, based_on_memory_ids})
  - update_rule({id, ...patch})
  - disable_rule({id, reason})

Read tools (use freely):
  - list_rules({source?, enabled?})  — see what already exists
  - get_rule_effectiveness({rule_id, days})  — fired/acted/dismissed counts, avg score_delta, helpful_up/down
  - search_memories, get_memory, get_profile, get_recent_nudges, get_recent_rollups, etc.

Trigger shapes the engine understands (use ONE per rule, JSON-encoded as a string):

  { "app": "<pkg>", "after_local": "HH:MM", "threshold_min_today": <int> }
    → Today's foreground time on app ≥ threshold AND wall-clock ≥ after_local

  { "after_event": "wake", "within_sec": <int>, "app_any": ["<pkg>", ...] }
    → An app from app_any opened within within_sec of today's wake_ts

  { "between_local": ["HH:MM","HH:MM"], "category": "productive"|"neutral"|"unproductive",
    "threshold_min_today": <int>, "location": "<place_label>" }
    → Wall-clock in window AND today's category minutes ≥ threshold AND user inside place

Action shape: { "level": 1|2|3, "message": "<short, second-person, action-oriented>" }
  level 1 = silent, 2 = heads-up, 3 = modal. Default to 2 unless extreme.

Workflow:
  1. List existing LLM rules via list_rules({source:"llm"}).
  2. For each, call get_rule_effectiveness({rule_id, days:14}).
       - avg_score_delta > 0 AND helpful_up > helpful_down → keep; consider raising cooldown if fired > 7×.
       - avg_score_delta < 0 OR helpful_down >> helpful_up → disable_rule with one-line reason.
       - mixed → update_rule to narrow trigger (raise threshold, tighter time window) and lower predicted_impact_score.
  3. Search memories for unprotected high-impact patterns. For each new actionable pattern with abs(impact_score) ≥ 0.15 AND confidence ≥ 0.5 that is NOT already covered by an existing rule, call create_rule with a trigger derived from the memory's cause and action targeting the effect. Pass the source memory id(s) in based_on_memory_ids.
  4. Do NOT create more than 4 new rules per night. Quality over quantity.
  5. NEVER call create_rule with predicted_impact_score < 0.15 — the tool will reject it.

Hard rules:
  - You CANNOT create or modify user/seed rules. The tools refuse — don't waste turns.
  - Every create_rule MUST cite at least one memory id in based_on_memory_ids.
  - Use second-person message text ("You've spent…") not third-person.
  - Reply with a brief plain-text summary of what you did. No JSON.`;

async function runNudgePass(yesterday: string): Promise<PassReport> {
  const report: PassReport = { ...EMPTY_PASS };
  try {
    const inputs = await loadNudgePassInputs();
    const userPrompt = buildNudgeUserPrompt(yesterday, inputs);

    const finalText = await runToolLoop({
      scope: 'nightly_nudge',
      system: NUDGE_SYSTEM_PROMPT,
      userPrompt,
      maxLoops: NUDGE_TOOL_LOOPS,
      maxOutputTokens: NUDGE_MAX_OUTPUT_TOKENS,
      report,
    });

    if (finalText !== null) {
      report.ok = true;
      console.log(`[nightly:nudge] ${finalText.slice(0, 240)}`);
    }
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    console.error('[nightly:nudge] failed:', report.error);
  }
  return report;
}

interface NudgePassInputs {
  profile: unknown;
  llmRules: Array<{
    id: string;
    name: string;
    enabled: number;
    trigger: string;
    action: string;
    cooldown_min: number;
    predicted_impact_score: number | null;
    based_on_memory_ids: string | null;
    disabled_reason: string | null;
  }>;
  topActionableMemories: Array<{
    id: string;
    type: string;
    summary: string;
    cause: string | null;
    effect: string | null;
    impact_score: number;
    confidence: number;
    occurrences: number;
    tags: string;
  }>;
  recentNudgeStats: {
    last14d_fired: number;
    last14d_acted: number;
    last14d_dismissed: number;
    last14d_helpful_up: number;
    last14d_helpful_down: number;
  };
}

async function loadNudgePassInputs(): Promise<NudgePassInputs> {
  return withDb(async (db) => {
    const profileRow = await db.getFirstAsync<{ data: string } | null>(
      `SELECT data FROM behavior_profile WHERE id = 1`,
    );
    const profile = profileRow ? safeParse(profileRow.data) : {};

    const llmRules = await db.getAllAsync<{
      id: string;
      name: string;
      enabled: number;
      trigger: string;
      action: string;
      cooldown_min: number;
      predicted_impact_score: number | null;
      based_on_memory_ids: string | null;
      disabled_reason: string | null;
    }>(
      `SELECT id, name, enabled, trigger, action, cooldown_min,
              predicted_impact_score, based_on_memory_ids, disabled_reason
       FROM rules
       WHERE source = 'llm'`,
    );

    const topActionableMemories = await db.getAllAsync<{
      id: string;
      type: string;
      summary: string;
      cause: string | null;
      effect: string | null;
      impact_score: number;
      confidence: number;
      occurrences: number;
      tags: string;
    }>(
      `SELECT id, type, summary, cause, effect, impact_score, confidence, occurrences, tags
       FROM memories
       WHERE archived_ts IS NULL
         AND ABS(impact_score) >= 0.15
         AND confidence >= 0.5
         AND (type = 'causal' OR type = 'habit' OR type = 'prediction')
       ORDER BY (ABS(impact_score) * confidence) DESC
       LIMIT 30`,
    );

    const since = Date.now() - 14 * 86_400_000;
    const stats = await db.getFirstAsync<{
      last14d_fired: number;
      last14d_acted: number;
      last14d_dismissed: number;
      last14d_helpful_up: number;
      last14d_helpful_down: number;
    }>(
      `SELECT
          COUNT(*) AS last14d_fired,
          SUM(CASE WHEN user_action='acted'     THEN 1 ELSE 0 END) AS last14d_acted,
          SUM(CASE WHEN user_action='dismissed' THEN 1 ELSE 0 END) AS last14d_dismissed,
          SUM(CASE WHEN user_helpful= 1 THEN 1 ELSE 0 END) AS last14d_helpful_up,
          SUM(CASE WHEN user_helpful=-1 THEN 1 ELSE 0 END) AS last14d_helpful_down
       FROM nudges_log
       WHERE ts >= ?`,
      [since],
    );

    return {
      profile,
      llmRules,
      topActionableMemories,
      recentNudgeStats: {
        last14d_fired: stats?.last14d_fired ?? 0,
        last14d_acted: stats?.last14d_acted ?? 0,
        last14d_dismissed: stats?.last14d_dismissed ?? 0,
        last14d_helpful_up: stats?.last14d_helpful_up ?? 0,
        last14d_helpful_down: stats?.last14d_helpful_down ?? 0,
      },
    };
  });
}

function buildNudgeUserPrompt(yesterday: string, input: NudgePassInputs): string {
  const lines: string[] = [];
  lines.push(`YESTERDAY: ${yesterday}`);
  lines.push('');
  lines.push('PROFILE (just rebuilt):');
  lines.push(JSON.stringify(input.profile ?? {}, null, 2));
  lines.push('');
  lines.push(`EXISTING_LLM_RULES (${input.llmRules.length}):`);
  lines.push(JSON.stringify(input.llmRules, null, 2));
  lines.push('');
  lines.push(`TOP_ACTIONABLE_MEMORIES (${input.topActionableMemories.length}):`);
  lines.push(JSON.stringify(input.topActionableMemories, null, 2));
  lines.push('');
  lines.push('NUDGE_STATS_LAST_14D:');
  lines.push(JSON.stringify(input.recentNudgeStats, null, 2));
  lines.push('');
  lines.push(
    'For each existing LLM rule, call get_rule_effectiveness({rule_id, days:14}) before deciding to keep/refine/disable. ' +
      'Then create at most 4 new rules grounded in the highest-impact unprotected memories. Reply with a one-paragraph summary.',
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

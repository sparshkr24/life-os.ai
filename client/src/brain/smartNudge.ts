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
import { fireNudgeNotification, type NudgeLevel } from '../rules/notify';
import { deviceTz, localDateStr, localDayStartMs } from '../aggregator/time';
import { runChatTask } from '../llm/router';
// Re-exported so existing callers (memory/embed legacy paths, observability
// summaries) keep working without churn.
export { sumTodayLlmCostUsd } from '../llm/ledger';

const SMART_COOLDOWN_MIN = 90; // don't fire two smart nudges in <90 min

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
    if (await isInSmartCooldown(startedAt)) {
      result.skipped = 'cooldown';
      return finish(result, startedAt);
    }

    const context = await buildSmartContext(tz, startedAt);
    const userPrompt = JSON.stringify(context, null, 2);

    const callRes = await runChatTask('smart_nudge', {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      jsonMode: true,
      temperature: 0.2,
      maxOutputTokens: 512,
    });

    if (callRes.kind === 'skipped') {
      result.skipped = callRes.reason === 'cap_exceeded' ? 'cost_cap' : 'no_key';
      console.log(`[smart-nudge] skip: ${callRes.reason}`);
      return finish(result, startedAt);
    }
    if (callRes.kind === 'failed') {
      result.error = callRes.reason;
      console.warn('[smart-nudge] failed:', callRes.reason);
      return finish(result, startedAt);
    }

    const response = callRes.response;
    result.costUsd = response.usage.costUsd;
    const decision = parseDecision(response.text);
    const llmCallId = await lastLlmCallId();

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

/**
 * Read back the row id of the last `llm_calls` row written. The router
 * inserts immediately after the call, so this is safe in the same tick.
 */
async function lastLlmCallId(): Promise<number | null> {
  return withDb(async (db) => {
    const r = await db.getFirstAsync<{ id: number } | null>(
      `SELECT id FROM llm_calls ORDER BY id DESC LIMIT 1`,
    );
    return r?.id ?? null;
  });
}

function finish(r: SmartNudgeReport, startedAt: number): SmartNudgeReport {
  r.durationMs = Date.now() - startedAt;
  return r;
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
// Decision parsing (model returns strict JSON via response_format=json_object)
// ────────────────────────────────────────────────────────────────────────────

function parseDecision(content: string): ModelDecision | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as Partial<ModelDecision>;
    if (
      typeof parsed.should_nudge === 'boolean' &&
      typeof parsed.title === 'string' &&
      typeof parsed.body === 'string' &&
      typeof parsed.reasoning === 'string'
    ) {
      return {
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
  return null;
}

function clampLevel(v: unknown): NudgeLevel {
  const n = Number(v);
  if (n === 1 || n === 2 || n === 3) return n;
  return 1;
}

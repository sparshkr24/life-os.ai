/**
 * Proactive AI questions (v7).
 *
 * Runs at the end of every aggregator tick. Three deterministic detectors
 * decide whether the phone is seeing a *possibly meaningful* gap (long dwell
 * outside any known place, total phone silence during a normally-active
 * hour, weekend-late-night dwell). When at least one detector fires, a small
 * gpt-5.4-mini-class call drafts a single short question with options. The
 * row goes into `proactive_questions` and an interactive notification fires.
 *
 * Hard gates (cheap, run BEFORE the LLM call):
 *   - 120-min throttle                        (schema_meta.last_proactive_question_ts)
 *   - daily cap of 3 questions                (count(status≠'expired') today)
 *   - no pending question already             (no status='pending' rows)
 *   - same trigger not asked in last 24 h     (count by trigger_kind)
 *   - cost cap                                (router enforces via runChatTask)
 *
 * The LLM is told to either return `{should_ask: false, …}` (we drop the
 * row) or a question. When `should_ask=true` we persist + notify.
 *
 * Note: detectors read events directly. They do NOT try to be perfectly
 * accurate — false negatives just mean a missed prompt; false positives mean
 * the LLM refuses to ask. Both fail safely.
 */
import type * as SQLite from 'expo-sqlite';
import { runChatTask } from '../llm/router';
import { retrieveContext } from '../memory/rag';
import { getProfile } from '../repos/observability';
import { LifeOsBridge } from '../bridge/lifeOsBridge';
import { Platform } from 'react-native';
import { fireProactiveQuestionNotification } from '../rules/proactiveNotify';
import { localHour, localDateStr } from '../aggregator/time';
import type {
  ProactiveExpectedKind,
  ProactiveQuestionRow,
  ProactiveTriggerKind,
} from '../db/schema';

const META_KEY_LAST_TS = 'last_proactive_question_ts';
const MIN_INTERVAL_MS = 120 * 60 * 1000;     // 120 min between questions
const DAILY_CAP = 3;
const SAME_TRIGGER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const QUESTION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Detector thresholds.
const DWELL_MIN_MS = 90 * 60 * 1000;         // 90 min still
const NO_USAGE_WINDOW_MS = 120 * 60 * 1000;  // look at last 120 min
const NO_USAGE_MAX_FG_MS = 5 * 60 * 1000;    // <5 min phone use → silent
const ACTIVE_HOUR_START = 9;
const ACTIVE_HOUR_END = 22;                  // 09:00–22:00 weekday/weekend default
const LATE_NIGHT_START = 22;                 // ≥22:00
const LATE_NIGHT_END = 2;                    // <02:00 (next day)

interface Trigger {
  kind: ProactiveTriggerKind;
  /** Free-form context passed to the LLM. Persisted as JSON in `trigger_payload`. */
  context: Record<string, unknown>;
  /** Suggested coordinates if the trigger is location-based. Captured once. */
  suggestedLat?: number;
  suggestedLng?: number;
}

export interface ProactiveTickReport {
  ran: boolean;
  reason?: string;
  trigger?: ProactiveTriggerKind;
  questionId?: string;
}

export async function maybeRunProactiveQuestion(
  db: SQLite.SQLiteDatabase,
  now: number,
  tz: string,
): Promise<ProactiveTickReport> {
  // 1. Throttle ----------------------------------------------------------
  const last = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM schema_meta WHERE key = ?`,
    [META_KEY_LAST_TS],
  );
  if (last && now - Number(last.value) < MIN_INTERVAL_MS) {
    return { ran: false, reason: 'throttled' };
  }

  // 2. Daily cap ---------------------------------------------------------
  const today = localDateStr(now, tz);
  const todayStart = Date.parse(`${today}T00:00:00`);
  const askedToday = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM proactive_questions WHERE ts >= ?`,
    [todayStart],
  );
  if ((askedToday?.n ?? 0) >= DAILY_CAP) {
    return { ran: false, reason: 'daily_cap' };
  }

  // 3. Pending question already? ----------------------------------------
  const pending = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM proactive_questions WHERE status = 'pending'`,
  );
  if ((pending?.n ?? 0) > 0) {
    return { ran: false, reason: 'pending_exists' };
  }

  // 4. Detect (cheap, deterministic) ------------------------------------
  const trigger = await detectTrigger(db, now, tz);
  if (!trigger) return { ran: false, reason: 'no_trigger' };

  // 5. Same-trigger cooldown --------------------------------------------
  const recentSameKind = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM proactive_questions
     WHERE trigger_kind = ? AND ts >= ?`,
    [trigger.kind, now - SAME_TRIGGER_COOLDOWN_MS],
  );
  if ((recentSameKind?.n ?? 0) > 0) {
    return { ran: false, reason: 'same_trigger_cooldown' };
  }

  // 6. RAG context -------------------------------------------------------
  // How memories are picked: we embed `buildQueryText` (trigger kind + day-
  // of-week + hour + JSON of trigger context) with text-embedding-3-small,
  // cosine-similarity that against every active memory's stored embedding,
  // then re-rank by `sim*0.5 + recency*0.2 + |impact|*0.15 + confidence*0.15`
  // (recency = exp(-daysSinceLastAccessed / 30), so newer use bumps score).
  // We do NOT pass *all* memories: a mature store can be 200+ rows × ~200
  // tokens → 40K+ tokens, well past sane budget for one quick draft. Top-8
  // is the sweet spot — enough pattern coverage without bloating the prompt.
  const queryText = buildQueryText(trigger, now, tz);
  const rag = await retrieveContext({ decisionType: 'chat', queryText, k: 8 });
  const memoryBlock = rag.embedded ? rag.contextBlock : '';

  // Behavior profile snapshot — helps the LLM reference user-specific labels
  // (e.g. "the user calls their evening gym Crunch") instead of generic ones.
  const profile = await getProfile();
  const profileBlock = buildProfileBlock(profile);

  // 7. LLM call ----------------------------------------------------------
  const llmRes = await callQuestionDrafter(trigger, memoryBlock, profileBlock, now, tz);
  if (llmRes.kind !== 'ok') {
    return { ran: false, reason: `llm_${llmRes.kind}` };
  }
  if (!llmRes.draft.should_ask) {
    return { ran: false, reason: 'llm_declined' };
  }

  // 8. Persist + fire notification --------------------------------------
  const id = uuid();
  const ts = Date.now();
  const optionsJson = JSON.stringify(llmRes.draft.options);
  await db.runAsync(
    `INSERT INTO proactive_questions
       (id, ts, trigger_kind, trigger_payload, prompt, options, expected_kind,
        suggested_lat, suggested_lng, status, llm_call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id,
      ts,
      trigger.kind,
      JSON.stringify(trigger.context),
      llmRes.draft.prompt,
      optionsJson,
      llmRes.draft.expected_kind,
      trigger.suggestedLat ?? null,
      trigger.suggestedLng ?? null,
      llmRes.draft.llm_call_id ?? null,
    ],
  );
  await db.runAsync(
    `INSERT INTO events (ts, kind, payload) VALUES (?, 'ai_question', ?)`,
    [
      ts,
      JSON.stringify({
        question_id: id,
        trigger_kind: trigger.kind,
        prompt: llmRes.draft.prompt,
      }),
    ],
  );
  await db.runAsync(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [META_KEY_LAST_TS, String(ts)],
  );

  // notification (best effort — failure doesn't undo the row)
  try {
    const notifId = await fireProactiveQuestionNotification({
      id,
      prompt: llmRes.draft.prompt,
      options: llmRes.draft.options,
      expectedKind: llmRes.draft.expected_kind,
    });
    if (notifId) {
      await db.runAsync(
        `UPDATE proactive_questions SET notification_id = ? WHERE id = ?`,
        [notifId, id],
      );
    }
  } catch (e) {
    console.error('[proactive] notify failed:', e instanceof Error ? e.message : String(e));
  }

  console.log(`[proactive] asked id=${id} kind=${trigger.kind} prompt="${llmRes.draft.prompt}"`);
  return { ran: true, trigger: trigger.kind, questionId: id };
}

// ─────────────────────────────────────────────────────────────────────
// Detectors
// ─────────────────────────────────────────────────────────────────────

async function detectTrigger(
  db: SQLite.SQLiteDatabase,
  now: number,
  tz: string,
): Promise<Trigger | null> {
  // Priority order: long_dwell_unknown > weekend_late_night > no_phone_usage.
  const longDwell = await detectLongDwellUnknown(db, now);
  if (longDwell) return longDwell;
  const weekend = await detectWeekendLateNight(db, now, tz);
  if (weekend) return weekend;
  const silence = await detectNoPhoneUsage(db, now, tz);
  if (silence) return silence;
  return null;
}

/**
 * STILL ≥ 90 min AND user is currently outside every known geofence.
 * "Outside" is determined by the most recent geo_enter / geo_exit event:
 * if the latest one is geo_exit (or there are no geo events at all in the
 * past 24h), we treat the user as outside.
 */
async function detectLongDwellUnknown(
  db: SQLite.SQLiteDatabase,
  now: number,
): Promise<Trigger | null> {
  // Currently inside a place?
  const lastGeo = await db.getFirstAsync<{ kind: string; payload: string; ts: number }>(
    `SELECT kind, payload, ts FROM events
     WHERE kind IN ('geo_enter','geo_exit') AND ts >= ?
     ORDER BY ts DESC LIMIT 1`,
    [now - 24 * 60 * 60 * 1000],
  );
  if (lastGeo && lastGeo.kind === 'geo_enter') return null;

  // Continuous STILL of at least DWELL_MIN_MS?
  const dwellMs = await stillStreakMs(db, now);
  if (dwellMs < DWELL_MIN_MS) return null;

  // Try to capture a coordinate so a future "Save place" answer can persist
  // it without re-prompting GPS. Best-effort; non-fatal on failure.
  let lat: number | undefined;
  let lng: number | undefined;
  if (Platform.OS === 'android' && LifeOsBridge) {
    try {
      const fix = await LifeOsBridge.getCurrentLocation();
      lat = fix.lat;
      lng = fix.lng;
    } catch (e) {
      console.warn('[proactive] getCurrentLocation failed:', (e as Error).message);
    }
  }

  return {
    kind: 'long_dwell_unknown',
    context: {
      still_minutes: Math.round(dwellMs / 60000),
      had_geo_history: !!lastGeo,
      captured_coords: lat != null && lng != null,
    },
    suggestedLat: lat,
    suggestedLng: lng,
  };
}

/**
 * No phone usage at all during a normally-active hour.
 *  - sum app_fg duration_ms over [now-120m, now]
 *  - require sum < 5 min
 *  - require local hour ∈ [9, 22]
 */
async function detectNoPhoneUsage(
  db: SQLite.SQLiteDatabase,
  now: number,
  tz: string,
): Promise<Trigger | null> {
  const hour = localHour(now, tz);
  if (hour < ACTIVE_HOUR_START || hour >= ACTIVE_HOUR_END) return null;

  const r = await db.getFirstAsync<{ ms: number | null }>(
    `SELECT SUM(MAX(0,CAST(json_extract(payload,'$.duration_ms') AS INTEGER))) AS ms
     FROM events
     WHERE kind = 'app_fg'
       AND ts >= ? AND ts < ?`,
    [now - NO_USAGE_WINDOW_MS, now],
  );
  const totalMs = r?.ms ?? 0;
  if (totalMs >= NO_USAGE_MAX_FG_MS) return null;

  return {
    kind: 'no_phone_usage',
    context: {
      window_minutes: Math.round(NO_USAGE_WINDOW_MS / 60000),
      foreground_minutes: Math.round(totalMs / 60000),
      hour,
    },
  };
}

/**
 * Sat/Sun, 22:00–02:00 local, with phone roughly idle (<30 min foreground in
 * the last 60 min). The point is to capture a likely "out somewhere" moment.
 */
async function detectWeekendLateNight(
  db: SQLite.SQLiteDatabase,
  now: number,
  tz: string,
): Promise<Trigger | null> {
  const dow = new Date(
    new Date(now).toLocaleString('en-US', { timeZone: tz }),
  ).getDay(); // 0=Sun, 6=Sat
  if (dow !== 0 && dow !== 6) return null;

  const hour = localHour(now, tz);
  const isLateNight = hour >= LATE_NIGHT_START || hour < LATE_NIGHT_END;
  if (!isLateNight) return null;

  // Roughly idle? <30 min foreground in last hour.
  const r = await db.getFirstAsync<{ ms: number | null }>(
    `SELECT SUM(MAX(0,CAST(json_extract(payload,'$.duration_ms') AS INTEGER))) AS ms
     FROM events
     WHERE kind = 'app_fg' AND ts >= ?`,
    [now - 60 * 60 * 1000],
  );
  if ((r?.ms ?? 0) > 30 * 60 * 1000) return null;

  return {
    kind: 'weekend_late_night',
    context: { hour, dow, foreground_minutes: Math.round((r?.ms ?? 0) / 60000) },
  };
}

/**
 * Returns the duration (ms) of the latest contiguous STILL streak ending
 * at `now`. Reads `activity` events; if the very latest one is not STILL,
 * returns 0.
 *
 * Activity events are written by the Stage-3b transition receiver with
 * payload `{type: 'STILL'|'WALKING'|'RUNNING'|'IN_VEHICLE'|'ON_BICYCLE',
 * transition: 'enter'|'exit'}`. We treat 'enter' as the start of a streak
 * and the next 'exit' (or any other type's 'enter') as its end.
 */
async function stillStreakMs(
  db: SQLite.SQLiteDatabase,
  now: number,
): Promise<number> {
  const rows = await db.getAllAsync<{ ts: number; payload: string }>(
    `SELECT ts, payload FROM events
     WHERE kind = 'activity' AND ts >= ?
     ORDER BY ts DESC LIMIT 32`,
    [now - 6 * 60 * 60 * 1000],
  );
  if (rows.length === 0) return 0;
  // Walk newest → oldest. Find the most recent STILL/enter that hasn't been
  // closed by a later non-STILL or STILL/exit.
  let streakStartTs: number | null = null;
  let openStill = false;
  for (let i = 0; i < rows.length; i += 1) {
    let p: { type?: string; transition?: string };
    try {
      p = JSON.parse(rows[i].payload);
    } catch {
      continue;
    }
    const type = (p.type ?? '').toUpperCase();
    const trans = (p.transition ?? '').toLowerCase();
    if (i === 0) {
      // Latest event must be STILL/enter for there to be an open streak.
      if (type === 'STILL' && trans === 'enter') {
        openStill = true;
        streakStartTs = rows[i].ts;
      } else {
        return 0;
      }
    } else if (openStill) {
      // Walk back; keep updating start as long as we keep seeing STILL/enter
      // (and no STILL/exit or non-STILL/enter) — but once we see a non-STILL
      // event we stop and use the previous start.
      if (type === 'STILL' && trans === 'enter') {
        streakStartTs = rows[i].ts;
      } else {
        break;
      }
    }
  }
  if (!streakStartTs) return 0;
  return now - streakStartTs;
}

// ─────────────────────────────────────────────────────────────────────
// LLM
// ─────────────────────────────────────────────────────────────────────

interface QuestionDraft {
  should_ask: boolean;
  prompt: string;
  options: string[];
  expected_kind: ProactiveExpectedKind;
  llm_call_id?: number | null;
}

interface QuestionDraftOk {
  kind: 'ok';
  draft: QuestionDraft;
}
interface QuestionDraftSkipped {
  kind: 'skipped' | 'failed';
  reason: string;
}

async function callQuestionDrafter(
  trigger: Trigger,
  memoryBlock: string,
  profileBlock: string,
  now: number,
  tz: string,
): Promise<QuestionDraftOk | QuestionDraftSkipped> {
  const hour = localHour(now, tz);
  const dow = new Date(
    new Date(now).toLocaleString('en-US', { timeZone: tz }),
  ).getDay();
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];

  const system = `You are Life OS's proactive observer. The user's phone noticed something that *might* be a meaningful pattern. Your job: decide whether asking ONE short question would help the AI learn about the user, and if so, draft it.

GUIDELINES
- Ask ONLY when the answer would meaningfully improve future suggestions or save a place. When in doubt, set should_ask=false.
- One sentence, ≤ 18 words, conversational. Mention the time/day when relevant ("It's 11pm on a Saturday — …").
- Provide 2–4 short options. For yes/no questions, exactly ["Yes","No"] (the user can also type a free-form answer if they tap "Other").
- expected_kind:
    "yes_no"      — answer is Yes or No.
    "place_name"  — answer is the name of a place (Office, Home, Gym, …); user may also type freely.
    "free_text"   — open-ended (what the user is doing).
- Never invent place names; never assume what the user is doing — ASK.

INPUT
trigger_kind: ${trigger.kind}
trigger_context: ${JSON.stringify(trigger.context)}
local_time: ${dayName} ${String(hour).padStart(2, '0')}:00 (${tz})
${profileBlock ? `\n${profileBlock}\n` : ''}${memoryBlock ? `\nMEMORY_CONTEXT (relevant past patterns):\n${memoryBlock}\n` : ''}

OUTPUT — JSON only, no prose:
{"should_ask": boolean, "prompt": string, "options": string[], "expected_kind": "yes_no"|"place_name"|"free_text"}`;

  const callRes = await runChatTask('proactive_question', {
    system,
    messages: [{ role: 'user', content: 'Decide and draft.' }],
    maxOutputTokens: 220,
    temperature: 0.4,
    jsonMode: true,
  });
  if (callRes.kind !== 'ok') {
    return { kind: callRes.kind === 'skipped' ? 'skipped' : 'failed', reason: callRes.kind };
  }

  const text = callRes.response.text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (e) {
    return { kind: 'failed', reason: 'parse: ' + (e as Error).message };
  }
  const draft = validateDraft(parsed);
  if (!draft) return { kind: 'failed', reason: 'invalid_draft' };
  return { kind: 'ok', draft };
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function validateDraft(v: unknown): QuestionDraft | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.should_ask !== 'boolean') return null;
  if (!o.should_ask) {
    return {
      should_ask: false,
      prompt: '',
      options: [],
      expected_kind: 'free_text',
    };
  }
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, 280) : '';
  if (!prompt) return null;
  const options = Array.isArray(o.options)
    ? (o.options as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 4)
    : [];
  if (options.length < 2) return null;
  const ek = o.expected_kind;
  const expected_kind: ProactiveExpectedKind =
    ek === 'yes_no' || ek === 'place_name' || ek === 'free_text' ? ek : 'free_text';
  return { should_ask: true, prompt, options, expected_kind };
}

function buildQueryText(trigger: Trigger, now: number, tz: string): string {
  const hour = localHour(now, tz);
  const dow = new Date(
    new Date(now).toLocaleString('en-US', { timeZone: tz }),
  ).getDay();
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
  const ctx = JSON.stringify(trigger.context);
  return `Trigger=${trigger.kind} on ${dayName} ${hour}:00. Context=${ctx}. What past patterns relate to this time of day, day of week, and trigger type?`;
}

/**
 * Compact serialization of `behavior_profile` for the proactive prompt.
 * The full profile JSON can run several KB; we cap it at ~1500 chars so the
 * prompt stays under ~3K tokens total. Returns '' when no profile yet exists.
 */
function buildProfileBlock(
  profile: { data: string; built_ts: number; based_on_days: number } | null,
): string {
  if (!profile) return '';
  const built = new Date(profile.built_ts).toISOString().slice(0, 10);
  let data = profile.data;
  if (data.length > 1500) data = data.slice(0, 1500) + ' …(truncated)';
  return `BEHAVIOR_PROFILE (built ${built}, ${profile.based_on_days}d window):\n${data}`;
}

function uuid(): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1)
    hex.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0');
  hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

// ─────────────────────────────────────────────────────────────────────
// Maintenance: expire pending questions older than 24 h.
// Called from the same aggregator tick. Cheap, deterministic.
// ─────────────────────────────────────────────────────────────────────
export async function expireOldProactiveQuestions(
  db: SQLite.SQLiteDatabase,
  now: number,
): Promise<number> {
  const r = await db.runAsync(
    `UPDATE proactive_questions
       SET status = 'expired'
     WHERE status = 'pending' AND ts < ?`,
    [now - QUESTION_EXPIRY_MS],
  );
  return r.changes ?? 0;
}

// ─────────────────────────────────────────────────────────────────────
// Apply user response. Used by both the notification action handler
// and the in-app pending-question card.
// ─────────────────────────────────────────────────────────────────────

import { createMemory } from '../memory/store';
import { addPlace } from '../repos/places';

export interface ProactiveAnswer {
  questionId: string;
  text: string;
  /** True when the user used the in-app card and we should auto-save the
   * place if expected_kind === 'place_name'. The notification YES/NO
   * buttons set this to false. */
  fromInAppCard: boolean;
}

export interface ProactiveAnswerResult {
  ok: boolean;
  memoryId: string | null;
  placeId: string | null;
  reason?: string;
}

export async function applyProactiveAnswer(
  db: SQLite.SQLiteDatabase,
  ans: ProactiveAnswer,
  tz: string,
): Promise<ProactiveAnswerResult> {
  const row = await db.getFirstAsync<ProactiveQuestionRow>(
    `SELECT * FROM proactive_questions WHERE id = ?`,
    [ans.questionId],
  );
  if (!row) return { ok: false, memoryId: null, placeId: null, reason: 'not_found' };
  if (row.status !== 'pending') {
    return { ok: false, memoryId: null, placeId: null, reason: 'not_pending' };
  }

  const now = Date.now();
  const cleanText = ans.text.trim().slice(0, 200);
  await db.runAsync(
    `UPDATE proactive_questions
        SET status = 'answered', response_text = ?, response_ts = ?
      WHERE id = ?`,
    [cleanText, now, ans.questionId],
  );
  await db.runAsync(
    `INSERT INTO events (ts, kind, payload) VALUES (?, 'ai_question_response', ?)`,
    [
      now,
      JSON.stringify({
        question_id: ans.questionId,
        trigger_kind: row.trigger_kind,
        prompt: row.prompt,
        answer: cleanText,
      }),
    ],
  );

  // 1. Auto-save place when applicable. ---------------------------------
  let placeId: string | null = null;
  const looksLikePlaceName =
    row.expected_kind === 'place_name' &&
    ans.fromInAppCard &&
    cleanText.length > 0 &&
    cleanText.toLowerCase() !== 'no' &&
    cleanText.toLowerCase() !== 'yes' &&
    cleanText.toLowerCase() !== 'other';
  if (looksLikePlaceName && row.suggested_lat != null && row.suggested_lng != null) {
    try {
      const p = await addPlace({
        label: cleanText,
        lat: row.suggested_lat,
        lng: row.suggested_lng,
        radiusM: 25,
      });
      placeId = p.id;
    } catch (e) {
      console.error('[proactive] addPlace failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // 2. Create a memory row from the Q+A. --------------------------------
  const memoryId = await materializeMemory(row, cleanText, tz);
  if (memoryId) {
    await db.runAsync(`UPDATE proactive_questions SET memory_id = ? WHERE id = ?`, [
      memoryId,
      ans.questionId,
    ]);
  }
  if (placeId) {
    await db.runAsync(
      `UPDATE proactive_questions SET status = 'answered' WHERE id = ?`,
      [ans.questionId],
    );
  }

  console.log(
    `[proactive] answered id=${ans.questionId} kind=${row.trigger_kind} answer="${cleanText}" memory=${memoryId} place=${placeId}`,
  );
  return { ok: true, memoryId, placeId };
}

async function materializeMemory(
  row: ProactiveQuestionRow,
  answer: string,
  tz: string,
): Promise<string | null> {
  const now = Date.now();
  const hour = localHour(now, tz);
  const dow = new Date(new Date(now).toLocaleString('en-US', { timeZone: tz })).getDay();
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
  const dom = new Date(new Date(now).toLocaleString('en-US', { timeZone: tz })).getDate();
  const dateStr = localDateStr(now, tz);

  const tags = [
    'source:proactive',
    `trigger:${row.trigger_kind}`,
    `dow:${dayName}`,
    `hour:${hour}`,
    `dom:${dom}`,
  ];

  // Sniff a yes/no for confidence: explicit yes is a strong signal.
  const lower = answer.toLowerCase();
  const isYes = lower === 'yes' || lower === 'y';
  const isNo = lower === 'no' || lower === 'n';
  let summary = `${row.prompt} → "${answer}"`;
  if (isYes) summary = `${row.prompt} (user confirmed: yes)`;
  if (isNo) summary = `${row.prompt} (user said: no)`;

  return createMemory({
    type: row.trigger_kind === 'long_dwell_unknown' ? 'pattern' : 'habit',
    summary,
    cause: `${dayName} ${hour}:00, trigger=${row.trigger_kind}`,
    effect: answer,
    impact_score: 0,
    confidence: isYes || isNo ? 0.7 : 0.55,
    tags,
    source_ref: `proactive_question:${row.id}`,
    rollup_date: dateStr,
  });
}

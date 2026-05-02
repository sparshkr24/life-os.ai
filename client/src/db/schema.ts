/**
 * Phone-side SQLite schema (expo-sqlite). Single source of truth.
 *
 * v2 (2026-04-26): local-first migration. Adds behavior_profile, monthly_rollup,
 * llm_calls. Extends nudges_log with reasoning/level/llm_call_id. Drops the
 * sync-related index (the column stays, harmless). See docs/ARCHITECTURE.md §3.2.
 *
 * Schema bumps require uninstall+reinstall on the phone to wipe the old DB.
 */

export const SCHEMA_VERSION = 7;

/**
 * v7 (2026-04-30) — additive only. Proactive AI questions.
 *  - new table `proactive_questions`: rows the eligibility scanner + LLM
 *    create when the phone notices a possibly-meaningful pattern (long
 *    dwell at an unknown spot, no phone usage on a usually-active evening,
 *    weekend night dwell, etc). User answers via interactive notification
 *    or in-app card; the answer is materialised into a `memories` row and
 *    optionally a new `places` row.
 *  - new EventKind values: 'ai_question', 'ai_question_response'.
 *  - new LlmPurpose: 'proactive_question'.
 * No DROP, no RENAME.
 */

/**
 * v6 (2026-04-29) — additive only. Stage 14 (LLM-generated rules).
 *  - rules.source                  TEXT  ('user' | 'seed' | 'llm') default 'user'
 *  - rules.predicted_impact_score  REAL  set by the nightly nudge pass
 *  - rules.based_on_memory_ids     TEXT  JSON array of memory.id
 *  - rules.disabled_reason         TEXT  free-form, set when LLM auto-disables
 *  - rules.last_refined_ts         INTEGER  epoch ms
 * Applied via `addColumnIfMissing`.
 */

/**
 * v5 (2026-04-28) — additive only.
 *  - app_categories.subcategory          TEXT     (e.g. 'social_media', 'video_streaming')
 *  - app_categories.enriched             INTEGER  (0/1, 1 once LLM has filled metadata)
 *  - app_categories.last_categorized_ts  INTEGER  (when LLM last touched the row)
 *  - app_categories.details              TEXT     (JSON: publisher, description, official_site, ...)
 *  - app_categories.source 'discovered' is a new sentinel for pkgs auto-added
 *    by the aggregator when seen in events but not seeded.
 * Applied via `addColumnIfMissing`. No DROP, no RENAME.
 * v4 (2026-04-28) — additive only. Stage 12 (Intelligence Evolution).
 *  - new table `memories`: derived patterns/predictions with embeddings.
 *  - embedding column is JSON-encoded float[] (1536-dim, text-embedding-3-small).
 *  - soft-delete via archived_ts; never DELETE.
 * See docs/ARCHITECTURE.md §9 and docs/LIFEOS_ARCHITECTURE_EVOLUTION.md.
 *
 * v3 (2026-04-26) — additive only.
 *  - daily_rollup.productivity_score REAL  (deterministic SQL score, see brain/productivityScore.ts)
 *  - nudges_log.next_day_score    REAL    (productivity_score for the day after the nudge)
 *  - nudges_log.baseline_score    REAL    (median over preceding 7 days)
 *  - nudges_log.score_delta       REAL    (next_day - baseline)
 *  - new EventKind values: 'inferred_activity', 'user_clarification'
 *  - nudges_log.user_helpful  INTEGER  (1 = thumbs up, -1 = thumbs down, NULL = no manual feedback)
 * Applied by `migrate()` via PRAGMA table_info guarded ALTER TABLE.
 * No DROP, no RENAME — never.
 */

/** Ordered list of statements run on every app start (all idempotent). */
export const PHONE_SCHEMA_SQL: readonly string[] = [
  // raw events, append-only, retention 30d (45d ceiling). `synced` is legacy.
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);`,

  // one row per day, rebuilt by aggregator. retention 365d.
  `CREATE TABLE IF NOT EXISTS daily_rollup (
    date TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_ts INTEGER NOT NULL
  );`,

  // one row per month. retention 24m.
  `CREATE TABLE IF NOT EXISTS monthly_rollup (
    month TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_ts INTEGER NOT NULL
  );`,

  // single-row user model, overwritten nightly by Sonnet.
  `CREATE TABLE IF NOT EXISTS behavior_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    built_ts INTEGER NOT NULL,
    based_on_days INTEGER NOT NULL,
    model TEXT NOT NULL
  );`,

  // todos — local source of truth.
  `CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT,
    due_ts INTEGER,
    priority INTEGER NOT NULL DEFAULT 2,
    remind_strategy TEXT NOT NULL DEFAULT 'none',
    remind_context TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_ts INTEGER NOT NULL,
    done_ts INTEGER,
    updated_ts INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);`,

  // nudge rules — user-editable.
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger TEXT NOT NULL,
    action TEXT NOT NULL,
    cooldown_min INTEGER NOT NULL DEFAULT 30
  );`,

  // nudges fired (debug + fatigue + reward signal). retention 60d.
  `CREATE TABLE IF NOT EXISTS nudges_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    rule_id TEXT,
    llm_call_id INTEGER,
    reasoning TEXT NOT NULL,
    message TEXT NOT NULL,
    level INTEGER NOT NULL,
    user_action TEXT,
    acted_within_sec INTEGER
  );`,
  `CREATE INDEX IF NOT EXISTS idx_nudges_log_ts ON nudges_log(ts);`,

  // LLM call ledger (cost + debug). retention 30d.
  `CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    in_tokens INTEGER,
    out_tokens INTEGER,
    cost_usd REAL,
    ok INTEGER NOT NULL,
    error TEXT,
    request TEXT,
    response TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts);`,

  // places (Home, Office, Gym, ...).
  `CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius_m INTEGER NOT NULL
  );`,

  // app classification.
  `CREATE TABLE IF NOT EXISTS app_categories (
    pkg TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed',
    subcategory TEXT,
    enriched INTEGER NOT NULL DEFAULT 0,
    last_categorized_ts INTEGER,
    details TEXT
  );`,

  // schema version + arbitrary KV (last_nightly_ts, last_aggregator_ts, ...).
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,

  // v4 — memory store. Derived patterns/predictions with embeddings.
  // `embedding` is a JSON-encoded float[]; cosine scan is in-process.
  // `archived_ts` is soft-delete; never DELETE rows.
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    cause TEXT,
    effect TEXT,
    impact_score REAL NOT NULL,
    confidence REAL NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 1,
    reinforcement INTEGER NOT NULL DEFAULT 0,
    contradiction INTEGER NOT NULL DEFAULT 0,
    last_accessed INTEGER NOT NULL,
    decay_factor REAL NOT NULL DEFAULT 0.05,
    tags TEXT NOT NULL DEFAULT '[]',
    source_ref TEXT,
    rollup_date TEXT,
    embedding TEXT NOT NULL,
    embed_model TEXT NOT NULL,
    predicted_outcome TEXT,
    actual_outcome TEXT,
    was_correct INTEGER,
    archived_ts INTEGER,
    parent_id TEXT,
    child_ids TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(archived_ts, last_accessed);`,
  `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);`,
  `CREATE INDEX IF NOT EXISTS idx_memories_rollup ON memories(rollup_date);`,

  // v7 — proactive AI questions.
  // status: 'pending' (notification fired, no answer yet)
  //       | 'answered' (user replied; response_text holds the answer)
  //       | 'dismissed' (user swiped the notification away)
  //       | 'expired'  (older than 24h with no response).
  // suggested_lat/lng are captured at question time when the trigger is a
  // location-dwell, so an 'answered' response that names a place can be
  // saved to `places` without re-reading GPS.
  `CREATE TABLE IF NOT EXISTS proactive_questions (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    trigger_kind TEXT NOT NULL,
    trigger_payload TEXT NOT NULL,
    prompt TEXT NOT NULL,
    options TEXT NOT NULL,
    expected_kind TEXT NOT NULL DEFAULT 'free_text',
    suggested_lat REAL,
    suggested_lng REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    response_text TEXT,
    response_ts INTEGER,
    llm_call_id INTEGER,
    memory_id TEXT,
    notification_id TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_proactive_questions_status ON proactive_questions(status, ts);`,
];

export type EventKind =
  | 'app_fg'
  | 'app_bg'
  | 'screen_on'
  | 'screen_off'
  | 'sleep'
  | 'wake'
  | 'geo_enter'
  | 'geo_exit'
  | 'activity'
  | 'steps'
  | 'heart_rate'
  // v3: written by the aggregator's silence classifier.
  | 'inferred_activity'
  // v3: written when the user answers the silence-prompt nudge.
  | 'user_clarification'
  // v7: a proactive AI question was fired. Payload mirrors `proactive_questions`.
  | 'ai_question'
  // v7: user replied to a proactive question. Payload: {question_id, answer}.
  | 'ai_question_response';

export type AppCategory = 'productive' | 'neutral' | 'unproductive';

/**
 * Fine-grained category. Free-form on purpose — the LLM picks the best label
 * from common ones rather than us locking a hard enum that goes stale every
 * year. Encourage these in the prompt: social_media, messaging, video_streaming,
 * music, gaming, news, reading, learning, productivity, work_communication,
 * dev_tools, finance, shopping, travel, navigation, health, fitness, dating,
 * browser, system, utility, photography, content_creation, generative_ai.
 */
export type AppSubcategory = string;
export type TodoStatus = 'open' | 'done' | 'snoozed' | 'dropped';
export type RemindStrategy = 'fixed' | 'context' | 'none';
export type NudgeSource = 'rule' | 'smart' | 'todo';
export type LlmPurpose =
  | 'nightly'
  | 'nightly_memory'
  | 'nightly_profile'
  | 'nightly_nudge'
  | 'tick'
  | 'chat'
  | 'embed'
  | 'extract'
  | 'proactive_question';
export type LlmModel = 'claude-sonnet-4-x' | 'gpt-4o-mini';

export interface EventRow {
  id: number;
  ts: number;
  kind: EventKind;
  payload: string;
  synced: 0 | 1;
}

export interface DailyRollupRow {
  date: string;
  data: string;
  updated_ts: number;
  /** v3. Deterministic SQL score in [0,1]. NULL until aggregator computes it. */
  productivity_score: number | null;
}

export interface MonthlyRollupRow {
  month: string;
  data: string;
  updated_ts: number;
}

export interface BehaviorProfileRow {
  id: 1;
  data: string;
  built_ts: number;
  based_on_days: number;
  model: string;
}

export interface RuleRow {
  id: string;
  name: string;
  enabled: 0 | 1;
  trigger: string;
  action: string;
  cooldown_min: number;
}

export interface NudgeRow {
  id: number;
  ts: number;
  source: NudgeSource;
  rule_id: string | null;
  llm_call_id: number | null;
  reasoning: string;
  message: string;
  level: 1 | 2 | 3;
  user_action: 'dismissed' | 'acted' | 'ignored' | null;
  acted_within_sec: number | null;
  /** v3. productivity_score of the day AFTER ts (local). */
  next_day_score: number | null;
  /** v3. Median productivity_score over the 7 days preceding ts. */
  baseline_score: number | null;
  /** v3. next_day_score - baseline_score. */
  score_delta: number | null;
  /** v3. Manual user feedback on whether a nudge was useful. 1 = up, -1 = down, null = unrated. Independent of LLM analysis. */
  user_helpful: 1 | -1 | null;
}

export interface LlmCallRow {
  id: number;
  ts: number;
  purpose: LlmPurpose;
  model: string;
  in_tokens: number | null;
  out_tokens: number | null;
  cost_usd: number | null;
  ok: 0 | 1;
  error: string | null;
  request: string | null;
  response: string | null;
}

export interface AppCategoryRow {
  pkg: string;
  category: AppCategory;
  /** 'seed' = built-in, 'user' = manually set, 'discovered' = auto-added when seen in events, 'llm' = LLM-enriched. */
  source: 'seed' | 'user' | 'discovered' | 'llm';
  /** v5. Fine-grained class (e.g. 'social_media'). NULL until enrichment runs. */
  subcategory: AppSubcategory | null;
  /** v5. 1 once the LLM has filled in subcategory + details. */
  enriched: 0 | 1;
  /** v5. Last time the LLM touched this row (epoch ms). */
  last_categorized_ts: number | null;
  /** v5. Free-form JSON: {publisher?, description?, official_site?, ...}. */
  details: string | null;
}

export interface PlaceRow {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radius_m: number;
}

// v7 — proactive AI questions.

export type ProactiveTriggerKind =
  | 'long_dwell_unknown'      // ≥ N min still in same spot, no known geofence
  | 'no_phone_usage'          // ≥ N min with zero app_fg during normally-active hours
  | 'weekend_late_night'      // Sat/Sun 22:00–02:00 dwell
  | 'unusual_hour_at_place'   // at a known place at an unusual time of day
  | 'ad_hoc';                 // chat tool fired by the AI in conversation

export type ProactiveQuestionStatus = 'pending' | 'answered' | 'dismissed' | 'expired';

export type ProactiveExpectedKind = 'yes_no' | 'place_name' | 'free_text';

export interface ProactiveQuestionRow {
  id: string;
  ts: number;
  trigger_kind: ProactiveTriggerKind;
  /** JSON-encoded snapshot of what fired the trigger (durations, place ids, …). */
  trigger_payload: string;
  prompt: string;
  /** JSON-encoded string[]. */
  options: string;
  expected_kind: ProactiveExpectedKind;
  suggested_lat: number | null;
  suggested_lng: number | null;
  status: ProactiveQuestionStatus;
  response_text: string | null;
  response_ts: number | null;
  llm_call_id: number | null;
  memory_id: string | null;
  /** expo-notifications request id (so we can dismiss when answered in-app). */
  notification_id: string | null;
}

// v4 — memory store.

export type MemoryType = 'pattern' | 'causal' | 'prediction' | 'habit';

export interface MemoryRow {
  id: string;
  created_ts: number;
  updated_ts: number;
  type: MemoryType;
  summary: string;
  cause: string | null;
  effect: string | null;
  /** [-1, 1]. Negative = harmful, positive = beneficial. */
  impact_score: number;
  /** [0, 1]. */
  confidence: number;
  occurrences: number;
  reinforcement: number;
  contradiction: number;
  last_accessed: number;
  decay_factor: number;
  /** JSON-encoded string[] of tags. */
  tags: string;
  source_ref: string | null;
  /** YYYY-MM-DD if extracted from a daily rollup. */
  rollup_date: string | null;
  /** JSON-encoded number[] (length === embedding dim, e.g. 1536). */
  embedding: string;
  embed_model: string;
  predicted_outcome: string | null;
  actual_outcome: string | null;
  was_correct: 0 | 1 | null;
  /** Soft-delete. NULL = active. */
  archived_ts: number | null;
  parent_id: string | null;
  /** JSON-encoded string[] of child memory ids that this row subsumes. */
  child_ids: string | null;
}

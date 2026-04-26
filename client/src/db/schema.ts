/**
 * Phone-side SQLite schema (expo-sqlite). Single source of truth.
 *
 * v2 (2026-04-26): local-first migration. Adds behavior_profile, monthly_rollup,
 * llm_calls. Extends nudges_log with reasoning/level/llm_call_id. Drops the
 * sync-related index (the column stays, harmless). See docs/ARCHITECTURE.md §3.2.
 *
 * Schema bumps require uninstall+reinstall on the phone to wipe the old DB.
 */

export const SCHEMA_VERSION = 2;

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
    source TEXT NOT NULL DEFAULT 'seed'
  );`,

  // schema version + arbitrary KV (last_nightly_ts, last_aggregator_ts, ...).
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
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
  | 'notif'
  | 'heart_rate';

export type AppCategory = 'productive' | 'neutral' | 'unproductive';
export type TodoStatus = 'open' | 'done' | 'snoozed' | 'dropped';
export type RemindStrategy = 'fixed' | 'context' | 'none';
export type NudgeSource = 'rule' | 'smart' | 'todo';
export type LlmPurpose = 'nightly' | 'tick' | 'chat';
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
  source: 'seed' | 'user';
}

export interface PlaceRow {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radius_m: number;
}

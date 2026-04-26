# AI Life OS — Local-First Personal Build

> One user. One phone. One developer. No server. No cloud DB.

---

## 0. Status

This document supersedes the prior hybrid (phone + Express) design. Effective
2026-04-26 the system is **fully local-first**. The only network calls are
outbound HTTPS to LLM providers (Anthropic + OpenAI). Everything else lives in
`<filesDir>/SQLite/lifeos.db`.

---

## 1. TL;DR

- **No backend.** Phone is the entire system.
- **Local SQLite** (`expo-sqlite`) is the source of truth.
- **Kotlin foreground service** writes raw events directly into the same DB.
- **Aggregator** (WorkManager, every 15 min) maintains `daily_rollup`.
- **Rule engine** (in-process, every 60 s) handles deterministic nudges, offline.
- **LLM brain** runs on-device via outbound API calls:
  - Sonnet — once nightly (~03:00) — rebuilds `behavior_profile`.
  - gpt-4o-mini — every 15 min (gated) — decides smart nudges.
  - Sonnet — on-demand for chat with tool-calling against local SQLite.
- **API keys** entered in app Settings, persisted in `expo-secure-store`. Editable.
- **Hard daily LLM cost cap**: $0.30. Tracked in `llm_calls`.
- **Notifications**: local only (`expo-notifications`). No FCM.
- **Backups**: weekly DB export to `Documents/lifeos-backup-YYYYMMDD.db`.

---

## 2. Architecture Diagram

```
┌──────────────────────── PHONE (sideloaded APK) ───────────────────────────┐
│                                                                           │
│  React Native UI (TypeScript)                                             │
│   ├─ Today          ├─ Events       ├─ Rollups                            │
│   ├─ LLM Calls      ├─ Nudges       ├─ Profile (summary)                  │
│   ├─ Chat           └─ Settings (API keys, cost cap, backup)              │
│                                                                           │
│            writes ▲              reads ▼                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  SQLite (lifeos.db, WAL)                                            │  │
│  │  events · daily_rollup · monthly_rollup · behavior_profile          │  │
│  │  todos · rules · nudges_log · llm_calls · places · app_categories   │  │
│  │  schema_meta                                                        │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│            ▲                                ▲           ▲                 │
│  Kotlin FG service                Aggregator           Brain              │
│  ─────────────────                ──────────           ─────              │
│   UsageStatsPoller (60 s)         WorkManager 15 min   Anthropic SDK      │
│   SleepApi / AR / Geofence        rebuilds today's     OpenAI SDK         │
│   Health Connect (15 min)         daily_rollup +       cost-capped        │
│   NotificationListener            seals previous day                      │
│   ScreenOn/Off                                                            │
│                                   AlarmManager 03:00 ─► Sonnet nightly    │
│                                   ─► behavior_profile                     │
│                                                                           │
│   Rule engine (in-process, 60 s) ─► local notif (expo-notifications)      │
│   Tick worker  (15 min)          ─► gpt-4o-mini ─► local notif (gated)    │
└───────────────────────────────────────────────────────────────────────────┘
                              │ outbound HTTPS only
                              ▼
                       Anthropic + OpenAI APIs
```

---

## 3. Components

### 3.1 Native bridge (Kotlin)

One module: `LifeOsBridge`. Methods exposed to RN:

```kotlin
@ReactMethod fun startService()
@ReactMethod fun stopService()
@ReactMethod fun hasUsageAccess(promise)
@ReactMethod fun openUsageAccessSettings()
@ReactMethod fun setGeofences(places)
@ReactMethod fun fireLocalNotification(payload)
@ReactMethod fun getStats(promise)
@ReactMethod fun scheduleNightly(hour, minute)   // sets the AlarmManager alarm
```

Foreground service hosts every collector. Direct SQLite writes (no JS bridge in
the hot path). Same DB file the RN app uses.

### 3.2 SQLite schema (v2)

```sql
-- Raw events. Bounded retention: 30 days (45 day hard ceiling).
CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,        -- epoch ms
  kind    TEXT    NOT NULL,        -- 'app_fg' | 'screen_on' | 'sleep' | ...
  payload TEXT    NOT NULL,        -- JSON
  synced  INTEGER NOT NULL DEFAULT 0  -- legacy column, ignored in v2
);
CREATE INDEX idx_events_ts ON events(ts);

-- One row per day. Retention: 365 days, then folded into monthly_rollup.
CREATE TABLE daily_rollup (
  date       TEXT PRIMARY KEY,     -- 'YYYY-MM-DD'
  data       TEXT NOT NULL,        -- JSON, see §3.5
  updated_ts INTEGER NOT NULL
);

-- One row per month. Retention: 24 months.
CREATE TABLE monthly_rollup (
  month      TEXT PRIMARY KEY,     -- 'YYYY-MM'
  data       TEXT NOT NULL,        -- JSON, see §3.5
  updated_ts INTEGER NOT NULL
);

-- The user model. Single row, overwritten nightly.
CREATE TABLE behavior_profile (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  data            TEXT NOT NULL,   -- JSON, see §3.5
  built_ts        INTEGER NOT NULL,
  based_on_days   INTEGER NOT NULL,
  model           TEXT NOT NULL    -- 'claude-sonnet-4-x'
);

-- Todos. Local source of truth.
CREATE TABLE todos (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  notes           TEXT,
  due_ts          INTEGER,
  priority        INTEGER NOT NULL DEFAULT 2,
  remind_strategy TEXT NOT NULL DEFAULT 'none',
  remind_context  TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_ts      INTEGER NOT NULL,
  done_ts         INTEGER,
  updated_ts      INTEGER NOT NULL
);
CREATE INDEX idx_todos_status ON todos(status);

-- Rule definitions.
CREATE TABLE rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  trigger      TEXT NOT NULL,       -- JSON
  action       TEXT NOT NULL,       -- JSON
  cooldown_min INTEGER NOT NULL DEFAULT 30
);

-- Nudges fired (debug + fatigue + reward signal). Retention: 60 days.
CREATE TABLE nudges_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  source           TEXT NOT NULL,      -- 'rule' | 'smart' | 'todo'
  rule_id          TEXT,                -- when source = 'rule'
  llm_call_id      INTEGER,             -- when source = 'smart'  (FK -> llm_calls.id)
  reasoning        TEXT NOT NULL,       -- human-readable WHY
  message          TEXT NOT NULL,
  level            INTEGER NOT NULL,    -- 1 silent | 2 heads-up | 3 modal
  user_action      TEXT,                -- 'dismissed' | 'acted' | 'ignored'
  acted_within_sec INTEGER
);
CREATE INDEX idx_nudges_log_ts ON nudges_log(ts);

-- LLM call ledger (cost + debug). Retention: 30 days.
CREATE TABLE llm_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  purpose     TEXT NOT NULL,            -- 'nightly' | 'tick' | 'chat'
  model       TEXT NOT NULL,
  in_tokens   INTEGER,
  out_tokens  INTEGER,
  cost_usd    REAL,
  ok          INTEGER NOT NULL,         -- 1 success, 0 fail
  error       TEXT,
  request     TEXT,                     -- truncated prompt for debug
  response    TEXT                      -- truncated reply for debug
);
CREATE INDEX idx_llm_calls_ts ON llm_calls(ts);

-- Places (Home, Office, Gym, ...).
CREATE TABLE places (
  id       TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  radius_m INTEGER NOT NULL
);

-- App classification.
CREATE TABLE app_categories (
  pkg      TEXT PRIMARY KEY,
  category TEXT NOT NULL,                -- 'productive' | 'neutral' | 'unproductive'
  source   TEXT NOT NULL DEFAULT 'seed'
);

-- Schema version + arbitrary KV (last_nightly_ts, last_aggregator_ts, ...).
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`SCHEMA_VERSION = 2`. Migration from v1 is additive; no data loss. The
`synced` column on `events` is kept (it's harmless) but is no longer read or
written by anything in v2.

### 3.3 Retention policy

Run during the nightly job, after rollup rebuild:

```
DELETE FROM events         WHERE ts    < now - 30d
DELETE FROM nudges_log     WHERE ts    < now - 60d
DELETE FROM llm_calls      WHERE ts    < now - 30d
DELETE FROM daily_rollup   WHERE date  < today - 365d  -- after folding into monthly
DELETE FROM monthly_rollup WHERE month < today_month - 24
VACUUM;
```

If aggressive event volume (>50 MB on `events`) is observed, cap stretches to 45
days. Daily rollups are folded into the corresponding `monthly_rollup` row
*before* deletion.

### 3.4 Execution model (replaces backend cron)

| Job                    | Mechanism                                  | Cadence | Tier |
|------------------------|--------------------------------------------|---------|------|
| Collectors             | `LifeOsForegroundService`                  | cont.   | 1    |
| Rule engine            | inline tick in same FG service             | 60 s    | 1    |
| Aggregator + tick      | `WorkManager` periodic worker              | 15 min  | 2    |
| Nightly profile rebuild| `AlarmManager.setExactAndAllowWhileIdle` → broadcast → FG service → RN headless task | 03:00 daily | 3 |
| Backup export          | WorkManager weekly                         | 7 days  | 2    |
| Watchdog               | App-open hook: if `last_nightly < now-28h`, run inline | on resume | 1 |

OEM-specific autostart guidance is surfaced in onboarding. Doze/battery
whitelist prompts are mandatory for the FG service.

### 3.5 Behavior memory — three layers

**Layer 1 — `events`** — append-only truth. Never sent to any LLM.

**Layer 2 — `daily_rollup.data`** — deterministic SQL aggregation, ~3 KB / day:

```jsonc
{
  "date": "2026-04-25",
  "sleep": { "start": "...", "end": "...", "duration_min": 436, "confidence": 0.82 },
  "wake_first_app": "com.instagram.android",
  "first_pickup_min_after_wake": 2,
  "screen_on_minutes": 387,
  "by_app": [{ "pkg": "...", "minutes": 92, "sessions": 14, "category": "unproductive" }],
  "by_category": { "productive": 184, "neutral": 71, "unproductive": 132 },
  "by_hour": { "00": { "unproductive": 18 }, "...": {} },
  "places":   [{ "id": "home", "minutes": 620 }],
  "transitions": ["home→commute→office"],
  "steps": 7421,
  "active_minutes": 38,
  "todos": { "created": 4, "completed": 2 },
  "nudges": { "fired": 5, "acted": 2, "dismissed": 3 },
  "deviations_from_baseline": [
    { "metric": "unproductive_after_22", "z": 2.3, "delta_min": 47 }
  ]
}
```

**Layer 2.5 — `monthly_rollup.data`** — month summary built from that month's
daily rollups: top apps, sleep p50/p90, place hours, habit adherence, top
deviations. ~2 KB / month.

**Layer 3 — `behavior_profile.data`** — the user model. Target size 10–30 KB.
Rebuilt nightly by Sonnet from: previous profile + last 30 daily rollups + last
3 monthly rollups. Optimised for LLM intake; sections below are mandatory.

```jsonc
{
  "schema_version": 2,
  "as_of": "2026-04-26T03:00:00+05:30",
  "based_on_days": 30,
  "confidence": 0.71,                       // grows with data, target >0.98

  "identity": {
    "timezone": "Asia/Kolkata",
    "weekly_pattern": "Mon-Fri office, Sat errands, Sun rest"
  },

  "schedule": {
    "sleep":      { "start_p50": "00:38", "start_p90": "01:42", "end_p50": "07:51", "end_p90": "08:30", "duration_p50_min": 433 },
    "wake_first_action": [{ "action": "open_instagram", "prob": 0.62 }],
    "work":       { "in_office_p50": "09:34", "out_p50": "18:51", "office_days": ["Mon","Tue","Wed","Thu","Fri"] },
    "places":     [{ "id": "home", "weekly_hours": 85 }, { "id": "office", "weekly_hours": 47 }]
  },

  "habits_good": [{ "name": "gym_3x_week", "adherence_4w": 0.83, "trend": "stable" }],
  "habits_bad":  [{ "name": "phone_within_2min_of_wake", "adherence_4w": 0.93, "trend": "worsening" }],
  "time_wasters": [
    { "pkg": "com.instagram.android", "weekly_minutes": 612, "trend": "+8%", "peak_window": "22:00–01:00" }
  ],

  "productivity_windows": [
    { "window": "10:00–12:30", "productive_share": 0.78, "location": "office" }
  ],

  "predictions": {
    "next_action_now":    [{ "action": "open_instagram", "prob": 0.41, "basis": "23:14, home, post-dinner" }],
    "todays_risk_windows":[{ "window": "22:30–00:30", "risk": "instagram_binge", "expected_minutes": 58 }],
    "todays_optimal_focus_window": { "start": "10:30", "end": "12:00" }
  },

  "open_loops": ["postponing 'pay rent' for 4 days; usually completes errands Saturday morning at home"],

  "deviations": {
    "vs_last_week":  [{ "metric": "sleep_start", "delta_min": 22, "direction": "later" }],
    "vs_last_month": [{ "metric": "instagram_weekly_min", "delta_pct": 18, "direction": "up" }]
  },

  "model_self_eval": {
    "prediction_hit_rate_7d": 0.62,
    "areas_low_confidence":  ["weekend behavior", "exercise schedule"]
  }
}
```

The `model_self_eval` block is the feedback loop: each nightly run scores
yesterday's `predictions.next_action_now` against what actually happened (from
`events`) and writes the hit-rate. Over weeks this calibrates the model and
gives us a number to chase toward >0.98.

The LLM **never** sees raw events. Per chat turn it gets `behavior_profile` +
today's partial rollup (~6 KB total). When the user asks "this week" type
questions, the chat tool `query_week()` returns the last 7 daily rollups.

### 3.6 LLM strategy

| Trigger             | Model         | Frequency        | Budget impact   |
|---------------------|---------------|------------------|-----------------|
| Nightly profile     | Sonnet 4.x    | 1 / day          | ~$0.05 / day    |
| Smart-nudge tick    | gpt-4o-mini   | ≤ 96 / day, gated| ~$0.05 / day    |
| Chat                | Sonnet 4.x    | on-demand        | depends on use  |

Cost ceiling: **$0.30 / day**. Enforced before every call by summing today's
`llm_calls.cost_usd`. If exceeded, calls return a synthetic "budget reached"
response and the UI surfaces it.

Tick gating (skip the LLM entirely if):
- No new `app_fg` event for any flagged app since last tick, **and**
- No `geo_enter` since last tick, **and**
- No `screen_on` after 22:00 since last tick.

### 3.7 Settings + secrets

`expo-secure-store` (Android Keystore-backed) holds:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `LLM_DAILY_USD_CAP`        (default 0.30)

Editable from the Settings screen; never logged, never echoed back to the UI in
full (only last 4 chars).

### 3.8 Notifications

100% local. `expo-notifications` for L1 (silent) and L2 (heads-up). L3 (modal)
is an in-app full-screen view triggered when the app is open or via L2 tap +
`fullScreenIntent`. No FCM, no Expo Push.

### 3.9 Observability surfaces (in-app)

Every datum has a UI surface so the user can audit it:

| Tab          | Shows                                                                 |
|--------------|-----------------------------------------------------------------------|
| Today        | Yesterday recap · today risk windows · top 3 todos                    |
| Events       | Latest events, scrollable, filter by `kind` and date range            |
| Rollups      | Daily + monthly rollups, filter by date and free-text title/desc, sort asc/desc |
| LLM          | All `llm_calls`, filter by purpose (nightly / tick / chat), expand for full request + response |
| Nudges       | All nudges, why fired (rule name, or smart-nudge reasoning + linked llm_call), user action |
| Profile      | Brief overview of `behavior_profile` — top patterns, top time-wasters, deviations vs last week / month. **Never** the full raw JSON unless explicitly toggled. |
| Chat         | Text chat with Sonnet (voice in v1.x)                                 |
| Settings     | API keys, cost cap, retention overrides, manual backup, schedule next nightly |

---

## 4. Tech stack (final, locked)

| Layer            | Choice                                                          |
|------------------|-----------------------------------------------------------------|
| App shell        | React Native (Expo bare), TypeScript, strict                    |
| Local DB         | `expo-sqlite` (WAL on)                                          |
| Secrets          | `expo-secure-store`                                             |
| Notifications    | `expo-notifications` (local only)                               |
| Background       | `expo-task-manager` + `expo-background-fetch` for 15-min worker; `AlarmManager` (Kotlin) for nightly |
| Native bridge    | One Kotlin module, `LifeOsBridge`                               |
| LLM              | `@anthropic-ai/sdk` + `openai` (called direct from RN)          |
| Hosting          | none                                                            |
| Auth             | none (single-user, on-device)                                   |

---

## 5. Stage tracker (replaces previous plan)

| Stage | Status | Delivers                                                                |
|-------|--------|-------------------------------------------------------------------------|
| 1     | done   | Scaffold + schema v1                                                    |
| 2     | done   | FG service + boot receiver + bridge + APK build                         |
| 3a    | done   | UsageStatsManager → `events`                                            |
| 3b    |        | ActivityRecognition + Sleep API                                         |
| 3c    |        | Geofencing + NotificationListener                                       |
| 3d    |        | Health Connect                                                          |
| 4     | now    | **Schema v2 + observability tabs (Events, Rollups, LLM, Nudges, Profile summary, Chat shell, Settings) + secure store key entry** |
| 5     |        | Aggregator (WorkManager 15 min) — builds `daily_rollup` + monthly fold  |
| 6     |        | Rule engine (60 s) + 3-level local notifications + `nudges_log`         |
| 7     |        | Smart-nudge tick (gpt-4o-mini) + cost cap enforcement                   |
| 8     |        | Nightly Sonnet profile rebuild + AlarmManager + watchdog                |
| 9     |        | Chat (Sonnet, tool-calling against local SQLite)                        |
| 10    |        | Backups + retention sweeps + OEM autostart helper                       |
| 11    |        | Today screen polish + behavior-aware todo reminders                     |
| v1.x  |        | Voice input · home-screen widget · on-device fallback (Gemini Nano)     |

---

## 6. Risks (carried forward)

| Risk                                  | Mitigation                                              |
|---------------------------------------|---------------------------------------------------------|
| OEM kills FG service                  | Onboarding deep-link to autostart; "service alive since" badge |
| Nightly slips (Doze, phone off)       | Watchdog on app open: if last_nightly > 28 h, run inline |
| API key on-device                     | `expo-secure-store`; daily $ cap blunts a leak           |
| No remote backup                      | Weekly DB export to `Documents/`; v1.x Drive integration |
| LLM outage                            | Rule engine still works; chat shows offline banner       |
| Malformed profile JSON                | zod validate; on failure keep yesterday's profile        |
| Cost runaway from chat loop bug       | Hard daily cap in `llm_calls`                            |

---

## 7. Explicitly cut

`server/`, FCM, Tailscale, OAuth, Postgres, Play Store, iOS, AccessibilityService,
TFLite app classifier, MediaProjection screenshots, vector DB, RL bandits, on-device LLM (v1).

*End of document.*

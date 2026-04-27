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

## 5. Stage tracker

### v2 — Foundation (delivered)

| Stage | Status | Delivers                                                                |
|-------|--------|-------------------------------------------------------------------------|
| 1     | done   | Scaffold + schema v1                                                    |
| 2     | done   | FG service + boot receiver + bridge + APK build                         |
| 3a    | done   | UsageStatsManager → `events`                                            |
| 3b    | done   | ActivityRecognition + Sleep API                                         |
| 3c    | done   | Geofencing + NotificationListener                                       |
| 3d    | done   | Health Connect                                                          |
| 4     | done   | Schema v3 + observability tabs + secure-store key entry + chat shell    |
| 5     | done   | Aggregator (15 min) — `daily_rollup` + monthly fold + productivity score|
| 6     | done   | Rule engine (60 s) + 3-level local notifications + `nudges_log`         |
| 7     | done   | Smart-nudge tick (gpt-4o-mini) + cost cap enforcement                   |
| 8     | done   | Nightly Sonnet profile rebuild + AlarmManager + watchdog                |
| 9     | done   | Chat (Sonnet, tool-calling against local SQLite)                        |
| 10    |        | Backups + retention sweeps + OEM autostart helper                       |
| 11    |        | Today screen polish + behavior-aware todo reminders                     |

### v3 — Intelligence Evolution (see §9)

The v2 system is a reactive tracker. v3 adds a **Memory Layer**, **RAG**, and a
**self-learning loop** to push prediction accuracy from ~62% toward 90%+ while
*reducing* monthly LLM cost. Stages 12–17 deliver this evolution in order; each
is additive and reversible.

| Stage | Status | Delivers                                                                |
|-------|--------|-------------------------------------------------------------------------|
| 12    | now    | Memory store foundation: schema v4 (`memories` table) + embeddings + RAG retrieval + scoring (no LLM integration yet) |
| 13    |        | RAG-fed nightly profile + RAG-fed chat (replaces "send everything")     |
| 14    |        | LLM-generated rules (weekly) replace the smart-nudge tick               |
| 15    |        | Self-learning loop: prediction outcomes tracked back into memories      |
| 16    |        | Pattern abstraction + memory merging (specific → general)               |
| 17    |        | Optimization, caching, battery profiling, edge cases                    |
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

---

## 8. End-to-end execution flow (module by module)

This section is the canonical "what runs where, and what feeds what". Read top
to bottom — each module hands off to the next.

```
                ┌─────────────────────────────────────────────────┐
                │ MODULE 1 · Collectors  (Kotlin, always-on)      │
                │ ─────────────────────────────────────────────── │
                │ UsageStats poll (60s)        → app_fg           │
                │ ActivityRecognition (push)   → activity         │
                │ Sleep API (segment only)     → sleep            │
                │ Geofence (push)              → geo_enter/exit   │
                │ NotificationListener (push)  → notif_post       │
                │ HealthConnect poll (5 min)   → steps/active_min │
                └────────────────────┬────────────────────────────┘
                                     │ INSERT
                                     ▼
                            ┌──────────────────┐
                            │   events table   │  (raw firehose)
                            └────────┬─────────┘
                                     │
        every 15 min ────────────────┼──────────────────────────────
                                     ▼
                ┌─────────────────────────────────────────────────┐
                │ MODULE 2 · Ingestion pipeline (JS)              │
                │ client/src/ingest/cleanup.ts                    │
                │ ─────────────────────────────────────────────── │
                │ ① drop noise pkgs (android, launchers, …)       │
                │ ② merge same-pkg sessions within 90 s           │
                │ ③ drop sub-1s app_fg rows                       │
                │ Bounded to last 24h. Idempotent.                │
                └────────────────────┬────────────────────────────┘
                                     ▼
                ┌─────────────────────────────────────────────────┐
                │ MODULE 3 · Daily rollup (JS)                    │
                │ client/src/aggregator/rollup.ts                 │
                │ rebuildDailyRollup(today)  + (yesterday)        │
                └────────────────────┬────────────────────────────┘
                                     ▼
                ┌─────────────────────────────────────────────────┐
                │ MODULE 4 · Productivity score (deterministic)   │
                │ client/src/brain/productivityScore.ts           │
                └────────────────────┬────────────────────────────┘
                                     ▼
                ┌─────────────────────────────────────────────────┐
                │ MODULE 5 · Monthly fold (once per local day)    │
                │ client/src/aggregator/monthlyFold.ts            │
                └────────────────────┬────────────────────────────┘
                                     ▼
                                 (async branch)
                  ┌──────────────────┴──────────────────┐
                  ▼                                     ▼
   ┌────────────────────────────┐       ┌────────────────────────────┐
   │ MODULE 6a · Rule engine    │       │ MODULE 6b · Smart-nudge    │
   │ every 60 s while open +    │       │ tick (gpt-4o-mini, 15 min) │
   │ once per 15-min tick in bg │       │ cost-cap gated             │
   │ pure if/else over rollup   │       │                            │
   └─────────────┬──────────────┘       └─────────────┬──────────────┘
                 │ writes                              │ writes
                 ▼                                     ▼
                              nudges_log
                                   │
                    once nightly 03:00 (AlarmManager)
                                   ▼
                ┌─────────────────────────────────────────────────┐
                │ MODULE 7 · Behavior profile rebuild (Sonnet)    │
                │ inputs: prior profile + last 30 daily_rollups + │
                │         last 6 monthly_rollups + nudges_log     │
                │         (with score_delta) + VERIFIED_FACTS     │
                │ output: new behavior_profile row                │
                └─────────────────────────────────────────────────┘
```

### Module 1 — Collectors

Kotlin foreground service + receivers. Each one has **one job**: capture a raw
signal and `INSERT` into `events`. No cross-row logic, no rollups. A small
write-time denylist exists in Kotlin (`NOISE_PKGS` in `LifeOsForegroundService`)
to keep the firehose tractable; everything else is left to Module 2.

| Source              | Event kind     | Cadence               | Payload shape                                  |
| ------------------- | -------------- | --------------------- | ---------------------------------------------- |
| UsageStatsManager   | `app_fg`       | poll every 60 s       | `{pkg, start_ts, end_ts, duration_ms}`         |
| ActivityRecognition | `activity`     | push (transitions)    | `{type, transition: enter/exit}`               |
| Sleep API           | `sleep`        | push (once per night) | `{kind:"segment", start_ts, end_ts, status}`   |
| Geofencing          | `geo_enter`/`geo_exit` | push           | `{place_id}`                                   |
| NotificationListener| `notif_post`   | push                  | `{pkg, title, text}`                           |
| HealthConnect       | `steps`/`active_min` | poll every 5 min| `{count, source}` / `{minutes, source}`        |

**Why we only keep sleep `segment` events:** the Sleep API also fires
`SleepClassifyEvent` every ~10 min (a probability sample). They have no
duration, the rollup never reads them, and they flood the events table.
`SleepReceiver` drops them at write time.

### Module 2 — Ingestion pipeline

`client/src/ingest/cleanup.ts` runs at the start of every aggregator tick,
before rollups. It owns three rules today:

1. **Noise-pkg purge** — drops `app_fg` rows whose `pkg` matches a noise
   denylist (`android`, system UI, launchers, settings, etc). Catches OEM
   variants that slip past Kotlin's write-time filter.
2. **Adjacent-session merge** — walks the last 24h of `app_fg` rows in time
   order; whenever two consecutive same-pkg rows are within 90 s, the later
   row is folded into the earlier (extending `end_ts`/`duration_ms`) and
   deleted. Patches over service restarts that reset Kotlin's in-memory dedup.
3. **Short-session purge** — deletes `app_fg` rows with `duration_ms < 1 s`.
   These are RESUMED/PAUSED storms (sub-activity nav, share sheet round-trips)
   that survived merging.

**Add new rules here, not in collectors.** Collectors stay dumb. The pipeline
is the single source of truth for "what counts as noise".

### Module 3 — Daily rollup

`rebuildDailyRollup(date, tz)`. UPSERT into `daily_rollup`. Inputs are the
clean events stream produced by Module 2.

In plain English:

- Window: `[localMidnight, nextLocalMidnight)`.
- **App minutes**: bucket `app_fg` rows by pkg, sum `duration_ms`. Apply
  `app_categories` to also bucket per category and per local hour.
- **Sleep**: pick the longest `sleep` segment whose `end_ts` falls in
  `[date − 12h, date + 14h]`. That window captures "the night that belongs to
  this date" without grabbing a nap from yesterday.
- **`wake_first_app`**: first `app_fg` after `sleep.end_ts` that is **not**
  in `WAKE_NOISE_PKGS` (launchers, lock screen, alarm clocks, dialers).
  These auto-fire and aren't a real choice.
- **Places**: walk `geo_enter`/`geo_exit` in time order, accumulating the
  open span per `place_id`. Carry over an open span from before midnight.
- **Activity / steps / nudges / silences**: sum/count from the matching
  event kinds. Silences come from `inferred_activity` rows written by
  `classifySilences`.

Cadence: every 15 min, for **today and yesterday**. Yesterday is rebuilt for a
few hours after midnight so late-arriving events (sleep segments, HC steps)
get folded in. After ~6 h post-midnight, no new data can land in yesterday's
window, so the rebuild is a no-op — *that's* when yesterday is "frozen".

### Module 4 — Productivity score

`computeProductivityScore(date)`. Pure deterministic SQL over the row Module 3
just wrote. Stored in `daily_rollup.productivity_score`. Re-runs every tick
alongside the rollup; once yesterday's rollup stops changing, its score
stops changing too.

### Module 5 — Monthly fold

`foldMonth(month)` runs at most once per local day, gated by
`schema_meta.last_monthly_fold_date`. Folds the previous month's
`daily_rollup` rows into one `monthly_rollup` row (top apps, sleep p50/p90,
place hours, totals, avg productivity score). Idempotent — re-firing on the
same day is cheap and produces the same row.

### Module 6 — Notifications: two pathways

There are **two** independent triggers writing to `nudges_log`. They never
share a code path.

**6a. Rule engine** — `client/src/rules/engine.ts`. Pure if/else over today's
rollup + recent events. Runs every 60 s while the app is open and once per
15-min aggregator tick when it isn't. Cheap, deterministic, offline. Each
rule has a cooldown enforced via lookback in `nudges_log`. Example rules:

- "Instagram > 60 min after 22:00 → level-2 nudge"
- "first thing after wake is doomscroll within 60 s → level-1 nudge"
- "at home 14:00–18:00, browsing > 90 min → level-3 nudge"

`nudges_log.source = 'rule'`.

**6b. Smart-nudge tick** — Stage 7. Every 15 min, after the aggregator
finishes, gpt-4o-mini receives a compact context (today-so-far rollup,
behavior_profile summary, last 24 h of `nudges_log`, current time + place)
and decides whether **right now** is a meaningful moment. It can be
predictive ("you usually fall into Instagram at 22:30 — set a 22:00 cutoff
today?"). Hard-walled by `llm_calls` daily cost cap; if today is over $0.30
the call short-circuits.

`nudges_log.source = 'smart'`, with `llm_call_id` set.

Both pathways call `fireNudgeNotification({level, title, body})`, which maps
levels 1/2/3 to the `lifeos.silent` / `lifeos.headsup` / `lifeos.modal`
channels (LOW / DEFAULT / MAX importance, escalating vibration).

### Module 7 — Nightly behavior-profile rebuild (Sonnet)

Stage 8. AlarmManager fires once around 03:00. Inputs:

- previous `behavior_profile` row (priors)
- last **30** `daily_rollup` rows
- last **6** `monthly_rollup` rows
- last 7 days of `nudges_log` rows, each enriched with `score_delta`
  (next-day productivity score − baseline) so the model can see which nudges
  actually helped vs. which annoyed
- a `VERIFIED_FACTS` block of deterministic correlations
  (e.g. `low_phone_night.score_delta = +0.12`) computed in
  `client/src/brain/verifiedFacts.ts`

Output: a new `behavior_profile` row. **The LLM narrates verified facts; it
never invents numbers.** All correlations come from `VERIFIED_FACTS`.

### What the LLM never sees

- Raw `events` rows.
- Anything not in a rollup or in `VERIFIED_FACTS`.

### Cadences at a glance

| Trigger              | Cadence                | Module(s) it runs       |
| -------------------- | ---------------------- | ----------------------- |
| Foreground service   | 60 s poll              | M1 (UsageStats, HC)     |
| Aggregator tick      | every 15 min           | M2 → M3 → M4 → M5 → M6b |
| Rule engine          | 60 s (fg) + 15 min (bg)| M6a                     |
| Smart-nudge tick     | every 15 min (gated)   | M6b                     |
| Nightly profile      | 03:00 once             | M7                      |

*End of document.*

---

## 9. Stitch.ai design prompt (paste into stitch.ai)

The block below is the canonical prompt used to generate the visual design
system for the app. Treat it as a spec for the UI layer. When new screens are
added, extend this section first, then design.

````
ROLE
You are designing a sideload-only personal Android app called "Life OS". One
user (the developer). No marketing, no onboarding pitch. The user opens the app
to (a) glance at how today is going, (b) trust that the background tracking is
healthy, (c) read what the AI thinks of them, and (d) configure permissions
and API keys. The vibe is calm, data-rich, slightly nerdy, never gamified.

DESIGN PRINCIPLES
- Minimal but high information density. No empty hero sections, no "Welcome".
- Typography does the heavy lifting. Color is functional, never decorative.
- Every screen is glanceable in <2 seconds and drillable in <2 taps.
- Numbers are first-class citizens — large, monospaced, high contrast.
- Motion is restrained: 150–200 ms ease-out, no bouncy springs, no parallax.
- Dark mode is the default (the user uses this app at night). Light mode
  must look equally crafted, not an afterthought.
- Mobile-first portrait. No tablet layouts.

VISUAL LANGUAGE
- Type scale: Inter (UI) + JetBrains Mono (numbers, raw data, code).
- Corner radius: 16px cards, 12px buttons, 8px chips.
- Spacing: 4 / 8 / 12 / 16 / 24 / 32 (no other values).
- Color palette (dark):
    bg            #0B0B0E     (almost-black, warm)
    surface       #14141A
    surface-2     #1C1C24
    border        #25252F
    text-1        #F5F5F7     (primary)
    text-2        #A0A0AB     (secondary)
    text-3        #6B6B76     (tertiary / disabled)
    accent        #7C9CFF     (cool indigo, for primary actions)
    success       #4ADE80
    warning       #F5B35A
    danger        #F87171
    chart-grid    #25252F
- Color palette (light): same hues, swap luminances. bg #FAFAFB,
    surface #FFFFFF, text-1 #0F0F12, text-2 #5C5C66, text-3 #9090A0.
- Iconography: Lucide icons, 1.5 px stroke. No custom illustrations.
- No gradients on primary surfaces. One subtle gradient is allowed: the
  "productivity ring" on Today.

INSPIRATION (per surface, study these specifically)
- Overall information hierarchy + typography:    Linear, Things 3
- Today dashboard density + ring metric:         Apple Fitness, Bevel, Gentler Streak
- Settings + permission rows:                    iOS Settings, 1Password
- Raw events table (technical but readable):     Datadog logs UI, Stripe dashboard
- Daily/monthly rollup as readable narrative:    Reflect notes, Oura "Daily summary"
- Chat surface:                                  Claude.ai, Notion AI side panel
- Nudges feed:                                   Linear inbox, Things 3 today list
- Charts (sleep, app-time, productivity):        Apple Health, Bevel, Whoop
- LLM call log (developer panel):                Vercel logs, OpenAI playground

NAVIGATION SHELL
Bottom tab bar, 4 visible tabs + an overflow ⋯ for the rest. Active tab uses
text-1; inactive uses text-3. No tab badges except a single unread-nudge dot.
Tabs (in order): Today · Insights · Chat · Settings · ⋯ {Events, Rollups,
LLM, Nudges, Profile}. The overflow opens a sheet, not a drawer.

────────────────────────────────────────────────────────────────────────────
SCREEN 1 — TODAY (the only screen the user opens 90% of the time)
────────────────────────────────────────────────────────────────────────────
Inspiration: Apple Fitness rings + Linear's "Today" view + Oura's morning card.

Layout (top → bottom):
1. Header strip: "Today" + tiny weekday + date in text-2. Right side: a small
   live "● tracking" pill that turns warning if the foreground service hasn't
   ticked in >5 min, danger if >30 min.
2. Productivity ring (large, ~180 px). The ring fills 0→100% based on
   `daily_rollup.productivity_score`. Center: the score as a 2-digit integer
   in JetBrains Mono, 56 px. Below it, a single phrase like "ahead of your
   weekly median" or "below baseline" in text-2.
3. 5 component chips under the ring (sleep, focus, wake, move, nudge). Each
   chip = label + tiny sparkline of the last 7 days + delta vs. baseline.
   Tap → drills to Insights pre-filtered to that metric.
4. Three "what happened" cards stacked vertically, each ~96 px tall:
   - Sleep card: bedtime → wake time, duration, sparkline of last 7 nights.
   - Phone time card: top 3 apps with their minute totals + a tiny stacked
     bar of category split (productive / neutral / unproductive).
   - Place card: a horizontal time-strip showing where you were today
     (home / office / gym / out) — like a thin Gantt chart.
5. "Nudges today" section: max 3 most recent rows from `nudges_log`. Each
   row: level dot (silent/heads-up/modal color), title, time, "Did it help?
   👍 / 👎" pair on the right. Tap → expand reasoning.
6. Footer "system" card (collapsed by default): aggregator last tick,
   rules last tick, today's LLM spend, "Run aggregator now / rules now /
   smart nudge now" debug buttons. Visually quieter than the rest.

────────────────────────────────────────────────────────────────────────────
SCREEN 2 — INSIGHTS (the daily / monthly rollup, human readable)
────────────────────────────────────────────────────────────────────────────
Inspiration: Reflect's daily review + Oura's "Daily summary" + Whoop's trends.

Top: a segmented control "Day · Week · Month". Below it, a date picker that
horizontally scrolls (Things 3 style — selected date in larger type). The
content below re-renders for the selected window. **No raw JSON anywhere on
this screen** — the rollup row is rendered as a story:

For Day view:
- Hero block: productivity score with a one-sentence narration generated
  client-side from rollup numbers (e.g. "Strong focus block 09:30–12:10,
  then 2h 14m of Instagram after dinner."). The narration is templated, not
  LLM-written.
- "How you spent your time": a horizontal stacked bar (24 h) showing
  category blocks (sleep, productive, neutral, unproductive, away). Below
  it, a list of top 5 apps with minute totals + category-tinted bar fill.
- "Where you were": a place strip identical to the Today card but for the
  selected day.
- "Movement": steps + active minutes + a tiny line chart of the day's
  hourly steps.
- "Sleep": bedtime / wake / duration / a 7-day sleep-debt mini chart.
- "Nudges fired today": same component as Today, but for the selected day.
- Tiny "View raw JSON" link at the bottom for power-use debugging — opens
  a modal with the rollup row JSON and a copy button.

For Month view: a calendar heatmap of productivity_score (GitHub-contrib
style, 7 rows × ~5 cols) at the top, then the same per-section breakdowns
aggregated to monthly stats (median sleep, top apps for the month, hours
at each place).

────────────────────────────────────────────────────────────────────────────
SCREEN 3 — CHAT (Claude tool-calling against local SQLite, Stage 9)
────────────────────────────────────────────────────────────────────────────
Inspiration: Claude.ai mobile + Notion AI side panel.

- Full-screen, no bottom tab bar visible while typing.
- Single thread (no thread list — one user, one phone).
- Messages: user bubbles right-aligned in surface-2; assistant messages flat
  on bg with a thin left accent bar in `accent`. Tool-calls render inline as
  collapsible cards: header "ran SQL: top apps last 7 days" + a "show query"
  expander revealing the SQL + result preview.
- Input bar: rounded multi-line composer with a paper-plane send. Right of
  the composer, a small cost meter "$0.0124 today" tappable → opens cost-cap
  settings.
- Empty state shows 4 starter chips: "Why was yesterday low?", "When do I
  doomscroll most?", "Suggest a rule for late-night Instagram", "Compare
  this week to last week." Tap to send.

────────────────────────────────────────────────────────────────────────────
SCREEN 4 — SETTINGS
────────────────────────────────────────────────────────────────────────────
Inspiration: iOS Settings + 1Password vault settings.

Sectioned list with section headers in text-3 ALL-CAPS 11 px tracking 0.05em.

Section 1 — TRACKING PERMISSIONS (the most important section)
Each row = title + description in text-2 + a status pill on the right:
  ● granted (success), ● not granted (warning), ● not available (text-3).
Tapping a row deep-links to the relevant Android settings page.
Rows: Usage Access · Activity Recognition · Location (foreground) ·
Location (background) · Sleep API · Notification Listener · Health Connect ·
Notifications. Above the section: a single "X of 8 granted" progress bar.

Section 2 — API KEYS
- Anthropic API key. If set, show "sk-ant-…••••3a2f" in a row with a
  "Replace" button. If unset, show a single full-width input + "Save".
- OpenAI API key. Same pattern.
- Both fields are obscured by default with a tiny eye toggle.

Section 3 — COST & LIMITS
- Daily LLM cost cap: a row showing the current cap (e.g. "$0.30 / day")
  and today's spend as a thin progress bar underneath. Tap → numeric pad
  to edit.
- Today's spend rendered as monospace dollars.

Section 4 — DATA
- Backup now (writes to Documents/lifeos-backup-YYYYMMDD.db).
- Last backup: timestamp + size.
- Retention: events 90d / llm_calls 30d / others forever (read-only display).
- "Wipe local data" — destructive, requires hold-to-confirm.

Section 5 — DEBUG
- Foreground service status (alive / killed / last tick).
- Aggregator status (registered / interval / last tick).
- Reopen DB connection. Run aggregator now. Run rules now. Run smart nudge
  now. Each = a quiet ghost button.

────────────────────────────────────────────────────────────────────────────
SCREEN 5 — EVENTS (raw event table, but human-readable)
────────────────────────────────────────────────────────────────────────────
Inspiration: Datadog logs UI + Stripe dashboard activity.

- Top filter bar: kind multi-select chip group (app_fg / sleep / activity /
  geo / notif / steps / inferred / nudge), date range, search text.
- List rows (NOT a wide-grid table — too cramped on mobile). Each row:
  • Left: a 28 px colored kind icon (Lucide). Color per kind, muted.
  • Middle: a one-line summary FORMATTED FROM THE PAYLOAD, not raw JSON.
    Examples (these are the canonical formats):
      app_fg            → "Instagram · 14m 02s"   sub-line: "20:31 → 20:45"
      sleep (segment)   → "Slept 7h 14m"          sub-line: "23:18 → 06:32"
      geo_enter         → "Arrived at Office"     sub-line: "09:04"
      geo_exit          → "Left Home"             sub-line: "08:41"
      activity          → "Walking · 12 min"      sub-line: "started 17:02"
      steps             → "1,204 steps"           sub-line: "Health Connect"
      notif             → "WhatsApp"              sub-line: "3 notifications"
      inferred_activity → "Focused work · 1h 45m" sub-line: "office · 0.75 conf"
  • Right: relative time ("2m ago") in text-3 monospaced.
- Tap a row → bottom sheet with the formatted summary up top and the raw
  payload JSON in a syntax-highlighted code block (collapsed by default).
- Pull to refresh. Infinite scroll with a footer "showing N of M events".

────────────────────────────────────────────────────────────────────────────
SCREEN 6 — NUDGES (history feed)
────────────────────────────────────────────────────────────────────────────
Inspiration: Linear inbox + Things 3.

- Grouped by day (today / yesterday / earlier).
- Each card: level dot + title (bold) + body in text-2 + a row of metadata
  (source: rule/smart, time, "did it help?" reaction set).
- Smart nudges show a "🪄 smart" tag and a tiny ⓘ that opens reasoning + a
  collapsed "model said:" raw JSON.
- Filter chip row at top: "All · Rule · Smart · Helpful · Annoying".

────────────────────────────────────────────────────────────────────────────
SCREEN 7 — LLM CALLS (developer panel)
────────────────────────────────────────────────────────────────────────────
Inspiration: Vercel logs + OpenAI playground request panel.

- Top stat strip: today's spend / 30-day spend / cost cap / # calls today.
- List rows: model badge (claude-sonnet / 4o-mini) + purpose (nightly / tick
  / chat) + tokens-in/out + cost in monospace + latency + ✓ or ✗ status dot.
- Tap → request/response viewer: side-by-side on landscape, stacked on
  portrait. Both shown as JSON in code blocks. Copy buttons.

────────────────────────────────────────────────────────────────────────────
SCREEN 8 — PROFILE (the AI's model of the user)
────────────────────────────────────────────────────────────────────────────
Inspiration: Reflect's "About you" + Oura's readiness summary.

- Hero: "AI's model of you" + last-rebuilt timestamp + "based on N days".
- Sections rendered from `behavior_profile.data` JSON:
  • Patterns it noticed (bullet list)
  • Causal chains it inferred (visualized as connected pills A → B → C)
  • Suggested rules (each with an "Add as rule" button)
  • Verified facts block (read-only, the deterministic correlations)
- All text comes from the LLM but is presented as the model's notes about
  the user — second-person ("you tend to...") for warmth.

────────────────────────────────────────────────────────────────────────────
TOAST / TOUCH PATTERNS
────────────────────────────────────────────────────────────────────────────
- Toasts at top, slide-down 200 ms, dismiss after 2.5 s. Success = subtle
  success-tinted border; error = danger border + persists until tapped.
- Press states: 92% scale + 80% opacity, 100 ms.
- Hold-to-confirm for destructive actions: 600 ms ring fills, then commits.
- Numeric inputs use a custom keypad sheet, not the system keyboard.

DELIVERABLES
For each screen above, produce:
1. High-fidelity mock in dark mode (1080 × 2400, 3x).
2. The same in light mode.
3. Empty states + loading skeletons (shimmer at 1.2 s loop).
4. Permission-denied state for relevant screens.
5. A single "design tokens" frame listing all colors, type styles, spacing,
   radii, motion durations.

CONSTRAINTS
- Single user, no avatars, no profile pic, no social anything.
- No login screen (sideload-only). First launch goes straight to Today
  with permission prompts inline.
- No marketing language anywhere — copy is precise and slightly dry.
- No emojis in primary copy. (Inline reactions like 👍 / 👎 are allowed.)
````

---

## 9. Intelligence Evolution (v3)

> Source: `docs/LIFEOS_ARCHITECTURE_EVOLUTION.md` (2026-04-28). This section
> distills that doc into the parts that change *this* repo. Read the source
> for full reasoning, cost models, and risk analysis.

### 9.1 The gap

v2 is a reactive tracker: `prediction_hit_rate_7d ≈ 0.62`, every LLM call
receives the entire context window (~30 KB), the smart-nudge tick burns
gpt-4o-mini ~96×/day, and learned patterns live as prose buried in
`behavior_profile.data`. There is no structured, retrievable memory and no
explicit feedback loop. That ceiling is architectural, not a tuning issue.

### 9.2 Three new systems

1. **Memory Layer** — first-class `memories` rows with embeddings, impact
   scores, and outcome tracking. The Layer-3 user model gains a queryable index.
2. **RAG** — every LLM call retrieves only the top-k relevant memories instead
   of receiving full rollups. ~10× token reduction.
3. **Self-learning loop** — predictions are stored *as memories*, then matched
   against actual outcomes the next day. Reinforced or contradicted in place.

These compose: memories feed RAG; RAG feeds the LLM; the LLM emits new
predictions; outcomes update memory confidence; high-confidence patterns get
promoted to LLM-generated rules that the offline rule engine executes.

### 9.3 Schema additions (v4, additive)

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,        -- uuid
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL,
  type          TEXT    NOT NULL,        -- 'pattern'|'causal'|'prediction'|'habit'
  summary       TEXT    NOT NULL,        -- human-readable, ≤200 chars
  cause         TEXT,                    -- causal chains only
  effect        TEXT,
  impact_score  REAL    NOT NULL,        -- −1.0..+1.0
  confidence    REAL    NOT NULL,        -- 0.0..1.0
  occurrences   INTEGER NOT NULL DEFAULT 1,
  reinforcement INTEGER NOT NULL DEFAULT 0,
  contradiction INTEGER NOT NULL DEFAULT 0,
  last_accessed INTEGER NOT NULL,
  decay_factor  REAL    NOT NULL DEFAULT 0.05,
  tags          TEXT    NOT NULL,        -- JSON array of strings
  source_ref    TEXT,                    -- e.g. 'rollup:2026-04-28' or 'prediction:nightly:…'
  rollup_date   TEXT,                    -- YYYY-MM-DD if extracted from a rollup
  embedding     TEXT    NOT NULL,        -- JSON array of floats (Float32 packed)
  embed_model   TEXT    NOT NULL,        -- e.g. 'text-embedding-3-small'
  predicted_outcome TEXT,                -- for type='prediction'
  actual_outcome    TEXT,                -- set when outcome is observable
  was_correct       INTEGER,             -- 1/0/null
  archived_ts   INTEGER,                 -- soft-delete; null = active
  parent_id     TEXT,                    -- when this memory subsumes others
  child_ids     TEXT                     -- JSON array of subsumed memory ids
);
CREATE INDEX idx_memories_active ON memories(archived_ts, last_accessed);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_rollup ON memories(rollup_date);
```

Embeddings are stored as JSON-encoded float arrays in the `embedding` TEXT
column. We do **not** ship `sqlite-vss` in v3 — for ≤5 K rows on-device, a
client-side cosine scan over a single SELECT is fast enough (target: ≤30 ms
for top-5 over 1 K memories). If row count crosses ~5 K, revisit Annoy/JSI.

### 9.4 Embedding choice

OpenAI `text-embedding-3-small` (1536-dim, $0.02/1M tokens). Reasons:

- Anthropic ships no embeddings API.
- The user already has an OpenAI key (smart-nudge stage).
- 1536 floats × 4 bytes × 5000 rows ≈ 30 MB worst case — fine on-device.
- Cost is negligible vs. the LLM cap: extracting 5 memories/day = ~$0.0001/day.

`embed_model` is stored per row so we can migrate or re-embed cleanly later.

### 9.5 Module map (v3-only files)

| Path                            | Role                                                       |
|---------------------------------|------------------------------------------------------------|
| `client/src/memory/embed.ts`    | OpenAI embeddings; cost-capped; logs to `llm_calls`        |
| `client/src/memory/store.ts`    | CRUD + scoring (`computeEffectiveScore`, decay, reinforce) |
| `client/src/memory/rag.ts`      | `retrieveContext({decisionType, …})` → top-k memories      |
| `client/src/memory/extract.ts`  | (Stage 13) once-per-day extraction from yesterday's rollup |
| `client/src/memory/consolidate.ts` | (Stage 14) weekly merge + abstract-pattern generation   |
| `client/src/memory/CLAUDE.md`   | Folder-local instructions                                  |

Stages 13–17 layer on top without touching Stage 12's primitives.

### 9.6 RAG flow (Stage 13)

```
caller (nightly | chat | future-rules)
  ↓
buildRagQuery(decisionType, currentRollup, recentBehavior, requiredTags)
  ↓
embed(queryText)                        ← 1× OpenAI call, ~$0.00002
  ↓
SELECT id, embedding, … FROM memories
  WHERE archived_ts IS NULL
    AND (rollup_date IS NULL OR rollup_date >= today-90d)
  ↓ (in-process)
cosineSim(queryVec, row.embedding)      ← top-3K candidates max
  ↓
re-rank by (similarity·0.5 + recency·0.2 + |impact|·0.15 + confidence·0.15)
  ↓
top-k memories → assembleContext → LLM
```

Caller never sees raw embeddings; `retrieveContext` returns formatted memory
blocks ready to drop into a prompt.

### 9.7 Cost & accuracy targets

| Metric                       | v2 today  | v3 target (Stage 17) |
|------------------------------|-----------|----------------------|
| Prediction hit rate (7d)     | 0.62      | 0.90+                |
| LLM calls / month            | ~230      | ~70                  |
| LLM cost / month             | ~$3.00    | ~$1.10               |
| Tokens per nightly call      | ~30 K     | ~3 K (RAG-trimmed)   |
| Smart-nudge tick LLM calls   | ~96/day   | 0 (rules replace)    |

The cost cap stays at $0.30/day. RAG drives most of the saving by trimming
context; rule generation eliminates the tick entirely.

### 9.8 Hard rules (additions to the existing list)

- **Memories are derived, not authoritative.** Source of truth is still
  `events` + `daily_rollup` + `verifiedFacts`. A corrupted memory store can
  always be rebuilt.
- **Embedding calls obey the cost cap.** Same `sumTodayLlmCostUsd` guard as
  every other LLM call.
- **No RAG-only "facts".** Numbers in prompts still come from `verifiedFacts`.
  Memories provide *patterns* and *predictions*, never raw counts.
- **Soft-delete only.** Memories are archived (`archived_ts` set), never
  DELETEd, so contradicted patterns stay auditable.

### 9.9 What v3 explicitly does NOT add

- No new ML model on-device (no Gemini Nano, no MiniMax, no DeepSeek bundling).
  All model swaps are HTTP endpoint changes, not native code.
- No vector DB native module. JSON embeddings + in-process cosine until
  benchmarks force otherwise.
- No new permissions. Everything reuses existing collectors.
- No server. Same local-first invariant as v2.

*End of document.*

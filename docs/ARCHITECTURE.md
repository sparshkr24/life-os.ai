# AI Life OS — Personal Build (Sideload APK)

> One user. One phone. One developer. Shipping Tuesday.

---

## 1. TL;DR

### Architecture decision (definitive): **Hybrid — local SQLite + remote brain.**

Pure backend = chat/todo feels laggy and dies offline. Pure on-device LLM = you spend the next two weeks fighting Gemini Nano / MediaPipe instead of shipping. Hybrid wins because your two interaction modes have opposite latency requirements:

| Interaction | Where it runs | Why |
|---|---|---|
| Add todo / complete todo / "what's left today" | **On-device** (RN + SQLite) | Must be <100 ms, must work in airplane mode |
| Read raw collector events, write rollups, query history | **On-device SQLite** | Free, fast, no round-trip |
| Pattern analysis, "predict my next move", nudge decisions, free-form chat | **Backend** (Node + Claude API) | LLM reasoning over your full behavior profile |
| Push nudges to phone | Backend → FCM → RN | Standard |

The phone is the source of truth for raw events and todos. The backend is a stateless brain that pulls a snapshot, reasons, writes back decisions. If the backend is down, the app still tracks, still does todos, still fires rule-based nudges — it just can't chat or do "smart" predictions until reconnected.

### Tech stack (locked)
- **Mobile**: React Native (Expo bare workflow — needs custom native modules)
- **Native bridge (Kotlin)**: one module, ~6 functions, only for OS APIs RN can't reach
- **Local DB**: `expo-sqlite` (`op-sqlite` is the perf upgrade if needed later)
- **Backend**: Node.js + Express + TypeScript (single language across stack, fastest ship)
- **Backend DB**: SQLite file via `better-sqlite3` (Postgres is overkill for one user; upgrade later if you ever multi-tenant)
- **LLM**: Claude (Sonnet for chat + nightly analysis, gpt 4o-mini for nudge decisions). No on-device LLM in MVP.
- **Push**: Expo Push (wraps FCM, zero-config)
- **Hosting**: Fly.io free tier or a $5 Hetzner VPS. Tailscale so the phone hits the backend on a private network — no public auth surface, no TLS cert pain.

### Feasibility table (Android-only, sideload)

| Capability | Mechanism | Native or RN |
|---|---|---|
| Foreground app + duration | `UsageStatsManager.queryEvents()` | Kotlin bridge |
| Sleep / wake | Sleep API (`ActivityRecognitionClient`) | Kotlin bridge |
| Activity (still/walking/vehicle) | `ActivityRecognitionClient` | Kotlin bridge |
| Location + geofences (Home/Office/Gym/+) | `FusedLocationProvider` + `GeofencingClient` | Kotlin bridge |
| Steps | Health Connect | Kotlin bridge |
| App-level notifications received | `NotificationListenerService` | Kotlin bridge |
| Background loop | Foreground Service (Kotlin) | Kotlin bridge |
| Todos, UI, chat, settings | RN + SQLite | RN |
| Rule-based nudges (offline) | RN + local rules table | RN |
| Smart nudges + chat + prediction | Backend + Claude | Node |

---

## 2. Architecture Diagram

```
┌────────────────────────────── PHONE (sideloaded APK) ──────────────────────────────┐
│                                                                                    │
│  ┌──────────────────────────── React Native UI ────────────────────────────────┐   │
│  │  Today screen · Todos · Chat · Timeline · Settings · Rules editor          │   │
│  └────────────┬─────────────────────────────────┬─────────────────────────────┘   │
│               │ instant local ops               │ chat / smart nudges             │
│               ▼                                 ▼                                  │
│  ┌──────────────────────────┐         ┌────────────────────────┐                  │
│  │  expo-sqlite (local)     │         │  REST client           │                  │
│  │  - events                │         │  (chat + sync only)    │                  │
│  │  - daily_rollup          │         └───────────┬────────────┘                  │
│  │  - todos                 │                     │                                │
│  │  - rules                 │                     │                                │
│  │  - nudges_log            │                     │                                │
│  │  - profile_cache (JSON)  │                     │                                │
│  └──────────▲───────────────┘                     │                                │
│             │ writes                              │                                │
│  ┌──────────┴────────────────────────────────────┐│                                │
│  │  Native Bridge Module (Kotlin)               ││  FCM receiver ◄────────────┐   │
│  │  ──────────────────────────────────────────  ││                            │   │
│  │  LifeOsForegroundService                     ││                            │   │
│  │   ├─ UsageStatsPoller (60s)                  ││                            │   │
│  │   ├─ SleepApi listener                       ││                            │   │
│  │   ├─ ActivityRecognition listener            ││                            │   │
│  │   ├─ Geofence receiver                       ││                            │   │
│  │   ├─ HealthConnect puller (15 min)           ││                            │   │
│  │   ├─ NotificationListenerService             ││                            │   │
│  │   └─ ScreenOn/Off receiver                   ││                            │   │
│  │  Emits events → SQLite (direct write)        ││                            │   │
│  └──────────────────────────────────────────────┘│                            │   │
└──────────────────────────────────────────────────┼─────────────────────────────┼───┘
                                                   │ (Tailscale, HTTPS)          │
                                                   ▼                             │
┌────────────────────── BACKEND (Node + Express, single VPS) ────────────────────┴───┐
│                                                                                    │
│  POST /sync         ← phone uploads new events since last_synced_at                │
│  POST /chat         ← phone sends user message + recent context                    │
│  POST /tick         ← cron every 15 min: evaluate smart nudges, may push           │
│  POST /nightly      ← cron 03:00 local: rebuild behavior_profile, prime tomorrow   │
│                                                                                    │
│  ┌──────────────────────┐   ┌──────────────────────┐  ┌──────────────────────┐    │
│  │  Ingest + rollups    │──▶│  better-sqlite3      │◀─│  Claude client       │    │
│  │  (deterministic SQL) │   │  events/rollups/     │  │  (Sonnet + gpt 4o-mini)    │    │
│  └──────────────────────┘   │  profile/decisions   │  └──────────────────────┘    │
│                             └──────────────────────┘                                │
│                                       │                                             │
│                                       ▼                                             │
│                             Expo Push → FCM → phone                                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 Native bridge (Kotlin) — minimal surface
One Android module exposing **exactly** these methods to RN:

```kotlin
@ReactMethod fun startEngine()                      // start foreground service
@ReactMethod fun stopEngine()
@ReactMethod fun requestPermissions(promise)        // walks user through all special perms
@ReactMethod fun setGeofences(places: ReadableArray) // [{id, lat, lng, radius}]
@ReactMethod fun pullSinceLastSync(promise)         // returns batched events as JSON
@ReactMethod fun fireLocalNotification(payload)     // for offline rule nudges
```

Inside the foreground service, every collector writes to **the same SQLite file the RN app uses** via direct `android.database.sqlite.SQLiteDatabase` opening the Expo db file path — not over the JS bridge (bridge calls are too slow at 60s poll cadence × multiple collectors).

### 3.2 Local schema (SQLite on phone)

```sql
-- raw events, append-only, never edited
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- epoch ms
  kind TEXT NOT NULL,             -- 'app_fg','app_bg','sleep','wake','geo_enter',
                                  -- 'geo_exit','steps','activity','notif','screen_on','screen_off'
  payload TEXT NOT NULL,          -- JSON
  synced INTEGER DEFAULT 0
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_unsynced ON events(synced) WHERE synced = 0;

-- one row per day, rebuilt each night locally + remotely
CREATE TABLE daily_rollup (
  date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  data TEXT NOT NULL              -- JSON: see §3.5
);

-- todos — local source of truth
CREATE TABLE todos (
  id TEXT PRIMARY KEY,            -- uuid
  title TEXT NOT NULL,
  notes TEXT,
  due_ts INTEGER,                 -- optional
  priority INTEGER DEFAULT 2,     -- 1 high, 2 med, 3 low
  remind_strategy TEXT,           -- 'fixed'|'context'|'none'
  remind_context TEXT,            -- JSON: {place:'home', after_event:'arrive_home', not_before:'19:00'}
  status TEXT DEFAULT 'open',     -- 'open'|'done'|'snoozed'|'dropped'
  created_ts INTEGER NOT NULL,
  done_ts INTEGER,
  updated_ts INTEGER NOT NULL
);

-- nudge rules — user-editable
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  trigger TEXT NOT NULL,          -- JSON: {app:'com.instagram.android', minutes_today:'>30', between:['22:00','02:00']}
  action TEXT NOT NULL,           -- JSON: {level:1, message:'…'}
  cooldown_min INTEGER DEFAULT 30
);

-- nudges fired (for fatigue + reward signal)
CREATE TABLE nudges_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,           -- 'rule'|'smart'
  rule_id TEXT,
  message TEXT,
  user_action TEXT,               -- 'dismissed'|'acted'|'ignored' (filled later)
  acted_within_sec INTEGER
);

-- places (Home, Office, Gym, …)
CREATE TABLE places (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  lat REAL, lng REAL, radius_m INTEGER
);

-- profile cache pulled from backend nightly
CREATE TABLE profile_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,             -- the behavior_profile JSON (§3.5)
  updated_ts INTEGER NOT NULL
);
```

### 3.3 Sync protocol
- Every 5 minutes (or on app open) phone calls `POST /sync` with all rows where `synced=0`. Backend ACKs by id, phone marks `synced=1`. Cap each batch at 5k events.
- After each nightly job, backend pushes back the latest `behavior_profile` JSON; phone overwrites `profile_cache`.
- Loss of a batch is a non-event — events are append-only, retry forever.

### 3.4 Backend (Node + Express)
Five endpoints. That's it.

```
POST /sync     body: { events: [...] }                → { accepted_ids: [...] }
POST /chat     body: { message, recent_window? }      → { reply, tool_calls? }
POST /tick     (cron, every 15 min)                   → maybe push a nudge
POST /nightly  (cron, 03:00 local)                    → rebuilds behavior_profile
GET  /profile                                         → latest behavior_profile JSON
```

Auth: a single static bearer token baked into the APK. Tailscale is the real network boundary. Don't waste a day on OAuth.

Backend SQLite mirrors the phone's `events` + `daily_rollup` + `behavior_profile` tables. Treat the phone as canonical for events and todos; treat the backend as canonical for `behavior_profile`.

### 3.5 The behavior memory — exact format

**This is what you asked about specifically.** Three layers, each serving a different latency need:

#### Layer 1 — `events` (raw, append-only)
Truth source. Cheap. Never queried by the LLM directly. Used for rebuilding rollups.

#### Layer 2 — `daily_rollup.data` (JSON per day)
Deterministic SQL aggregation. Ships to the LLM as structured context. One row per day:

```json
{
  "date": "2026-04-25",
  "sleep": { "start": "2026-04-25T00:42:00+05:30", "end": "2026-04-25T07:58:00+05:30", "duration_min": 436, "confidence": 0.82 },
  "wake_first_app": "com.instagram.android",
  "first_phone_pickup_min_after_wake": 2,
  "screen_on_minutes": 387,
  "by_app": [
    {"pkg":"com.instagram.android","minutes":92,"sessions":14,"category":"unproductive"},
    {"pkg":"com.google.android.apps.docs","minutes":63,"sessions":4,"category":"productive"}
  ],
  "by_category": {"productive": 184, "neutral": 71, "unproductive": 132},
  "by_hour": {
    "00":{"unproductive":18,"productive":0,"neutral":4},
    "09":{"productive":42,"unproductive":3,"neutral":6}
    /* 24 keys */
  },
  "places": [
    {"id":"home","arrived":"2026-04-25T19:14:00+05:30","left":"2026-04-25T08:42:00+05:30","minutes":620},
    {"id":"office","arrived":"2026-04-25T09:31:00+05:30","left":"2026-04-25T18:47:00+05:30","minutes":556}
  ],
  "transitions": ["home→commute→office","office→commute→home"],
  "steps": 7421,
  "active_minutes": 38,
  "todos": {"created":4,"completed":2,"completion_rate":0.5},
  "nudges": {"fired":5,"acted":2,"dismissed":3},
  "deviations_from_baseline": [
    {"metric":"unproductive_after_22","z":2.3,"delta_min":+47}
  ]
}
```

#### Layer 3 — `behavior_profile` (single JSON document, the "user model")
Rebuilt each night from the trailing 30 days of rollups. **This is what gets stuffed into the LLM system prompt.** Compact, ~3–5 KB.

```json
{
  "as_of": "2026-04-26T03:00:00+05:30",
  "based_on_days": 30,
  "schedule": {
    "typical_sleep": { "start_p50": "00:38", "start_p90": "01:42", "end_p50": "07:51", "end_p90": "08:30" },
    "typical_wake_first_action": [
      {"action":"open_instagram","prob":0.62},
      {"action":"open_whatsapp","prob":0.21}
    ],
    "work_hours": { "in_office_start_p50": "09:34", "in_office_end_p50": "18:51", "office_days":["Mon","Tue","Wed","Thu","Fri"] },
    "regular_places": [
      {"id":"home","weekly_hours":85},
      {"id":"office","weekly_hours":47},
      {"id":"gym","weekly_hours":4,"days":["Mon","Wed","Fri"],"window":"19:30–20:45"}
    ]
  },
  "habits_good": [
    {"name":"gym_3x_week","adherence_4w":0.83},
    {"name":"steps_over_7k","adherence_4w":0.71}
  ],
  "habits_bad": [
    {"name":"phone_within_2min_of_wake","adherence_4w":0.93,"primary_app":"com.instagram.android"},
    {"name":"instagram_after_22","avg_minutes":54,"days_per_week":5.2},
    {"name":"sleep_after_0030","frequency":0.6}
  ],
  "time_wasters": [
    {"pkg":"com.instagram.android","weekly_minutes":612,"trend":"+8% vs prev 4w","peak_window":"22:00–01:00"},
    {"pkg":"com.zhiliaoapp.musically","weekly_minutes":188,"trend":"-12%"}
  ],
  "productivity_windows": [
    {"window":"10:00–12:30","productive_share":0.78,"location":"office"},
    {"window":"15:30–17:30","productive_share":0.64,"location":"office"}
  ],
  "predictions": {
    "next_likely_action_now": [
      {"action":"open_instagram","prob":0.41,"basis":"23:14, home, post-dinner pattern"}
    ],
    "todays_risk_windows": [
      {"window":"22:30–00:30","risk":"instagram_binge","historical_minutes_avg":58}
    ]
  },
  "open_loops": [
    "User has been postponing 'pay rent' for 4 days; usually completes errands on Saturday morning at home."
  ]
}
```

The LLM never sees raw events. It sees `behavior_profile` (always) + the last 1–7 days of `daily_rollup` (when relevant). Token cost per chat turn ≈ 3–6 KB context.

Predictions in `behavior_profile.predictions` are produced by Claude in the nightly job from the rollups — no custom ML. **This is the "machine learning" loop without any actual training:** deterministic SQL produces facts → Claude composes the profile → profile feeds back into next-day prompts. Each night the model gets "smarter" because the input data covers more days, deviations get sharper, predictions get more grounded. No model weights, no training infra.

### 3.6 Classification (apps → productive/neutral/unproductive)
Hardcoded JSON file shipped in the APK, ~200 apps the user actually uses. User can override per-app from a Settings screen (writes to `rules` table with kind `category_override`). No TFLite. No ML. If you don't recognize a package, default `neutral` and ask the user once on the next app open.

### 3.7 Rule-based nudges (on-device, offline)
RN evaluates rules every 60s using a tiny worker that reads from `events` + today's partial rollup:

```json
{
  "name": "Late-night Instagram",
  "trigger": {
    "app": "com.instagram.android",
    "minutes_today_in_app_after": "22:00",
    "threshold_min": 30
  },
  "action": { "level": 1, "message": "It's getting late. 8 hours sleep starts now." },
  "cooldown_min": 45
}
```

Levels: 1 = silent notification, 2 = heads-up + sound, 3 = full-screen RN modal that requires a 5-second wait. (All three are RN — `expo-notifications` for L1/L2, a foreground RN Activity for L3 launched via the bridge.)

Fatigue: hard cap 6/day, 30 min cooldown after any dismissal, silent during inferred sleep window.

### 3.8 Smart nudges + chat (backend)
Two distinct Claude calls:

**Smart nudge (every 15 min via `/tick`)** — gpt-4o-mini, single short call:
- Input: `behavior_profile` + today-so-far rollup + open todos.
- Output: `{ should_nudge: bool, level: 1|2|3, message, reason }`.
- If `should_nudge`, push via Expo Push.

**Chat (`/chat`)** — Sonnet, tool-calling enabled:
- System prompt = `behavior_profile`.
- Tools: `add_todo`, `complete_todo`, `list_todos`, `query_day(date)`, `query_week()`, `set_rule`. Tools execute against the **phone's** SQLite by returning a JSON action that the RN app applies locally — backend never directly mutates phone state.
- All chat is initiated by the phone, but todo operations the user does in-app go through local SQLite first, sync to backend later. This is what keeps todo interactions <100 ms.

### 3.9 Behavior-aware todo reminders
Each todo can carry `remind_context`. Examples:
- `{ "place": "home", "after_event": "arrive_home", "not_before": "19:00" }` → fires when geofence enters Home after 7 PM.
- `{ "tied_to_routine": "morning", "before_first_app": true }` → fires on wake event before first app pickup.
- `{ "priority_window": "productivity_windows" }` → backend nightly job picks the best 30-min slot tomorrow from the profile and writes a fixed-time reminder back.

Implementation in MVP: only `place + after_event` and `fixed time` are wired. The smart "find a slot" variant is v1.1.

---

## 4. Tech Stack (final)

| Layer | Choice |
|---|---|
| App shell | React Native (Expo bare workflow), TypeScript |
| Navigation | `expo-router` |
| Local DB | `expo-sqlite` (move to `op-sqlite` if perf wall) |
| Notifications | `expo-notifications` (local) + Expo Push (remote) |
| Native bridge | Single Kotlin module `LifeOsBridge` (Foreground Service + 6 RN methods) |
| Backend | Node 20 + Express + TypeScript |
| Backend DB | `better-sqlite3` |
| LLM | `@anthropic-ai/sdk` — Sonnet for chat/nightly, gpt 4o-mini for `/tick` |
| Cron | `node-cron` in-process |
| Hosting | Hetzner CX11 €4/mo or Fly.io free tier |
| Network | Tailscale on phone + VPS, no public exposure |
| Auth | Static bearer token in APK, env var on server |

---

## 5. MVP Plan — Sunday / Monday / Tuesday

**Hard rule:** if it's not on this list it's v1.x.

### Sunday — Plumbing (the unsexy day)
1. Init Expo bare project, add Kotlin module skeleton.
2. Foreground Service + `UsageStatsManager` poller writing to SQLite directly. Verify events land while app is killed.
3. Permissions onboarding screen: Usage Access, Notification Access, Location (background), Health Connect, Battery-allowlist deep link.
4. Local schema (§3.2) + seed `places` (Home, Office, Gym + hand-entered coordinates).
5. Geofence registration via bridge. Confirm `geo_enter`/`geo_exit` events.
6. Stand up Node backend skeleton: `/sync` endpoint + better-sqlite3 schema mirror. Tailscale on both ends.

**End-of-Sunday demo:** open phone, use Instagram for 5 min, walk to door (mock geofence), confirm rows in both phone DB and backend DB.

### Monday — Loop closes + todos
1. Sleep API + ActivityRecognition + Health Connect collectors → events table.
2. NotificationListenerService → `notif` events (just `package + ts + title hash`, no content).
3. Daily rollup job — runs locally at 03:00 and on `/nightly` server-side. Pure SQL, no LLM yet.
4. Todos UI in RN: list, add, complete, swipe-snooze, priority. **All local, instant.**
5. Rules table seeded with 3 starter rules. Rule evaluator worker (every 60s).
6. Three-level notification renderer.

**End-of-Monday demo:** todo add/complete is instant; a rule fires a Level-1 notif when you cross its threshold; daily rollup for today exists.

### Tuesday — Brain online
1. `/nightly` job: pull last 30 days of rollups, ask Claude Sonnet to produce `behavior_profile` JSON. Write to backend DB. Phone pulls on next sync.
2. `/tick` job (every 15 min): gpt 4o-mini call → maybe push nudge. Wire Expo Push end-to-end.
3. Chat screen in RN: send message → `/chat` → Sonnet with `behavior_profile` system prompt + tool-calling. Implement tools: `add_todo`, `complete_todo`, `list_todos`, `query_day`, `query_week`. Tools return action JSON; RN applies locally then echoes the LLM's reply.
4. Today screen: top of day = "Yesterday's recap (1 line) + today's risk windows + 3 priority todos."
5. Build release APK, sideload, run for 24 hours.

**End-of-Tuesday demo:** ask "what did I waste time on yesterday?" — get a real answer pulled from rollups via the LLM. Add a todo by chat. Receive at least one smart nudge that matches your actual pattern.

---

## 6. Data Flow (one full loop, simplified)

```
22:47   User opens Instagram
22:48   Foreground service poll → event {kind:'app_fg', pkg:'com.instagram.android', ts}
        → SQLite events table
22:48   RN rule worker tick: today's instagram-after-22:00 minutes = 32 (>30)
        → fire Level 1 notif locally (offline path always works)
22:48   Same event flows to /sync within 5 min batch
23:00   /tick cron runs on backend
        → gpt 4o-mini sees: profile says "instagram peaks 22-01, 612 min/wk"
                      today already 47 min after 22:00, +21% above 30d avg
        → returns {should_nudge: true, level: 2,
                   message: "You're 47m in tonight, your 30-day avg by this hour is 26m."}
        → Expo Push → phone heads-up notification
23:01   User dismisses → RN logs nudges_log.user_action='dismissed'
                       → next /sync uploads it → reward signal for tomorrow's nightly
03:00   /nightly: rebuilds rollup for 26 Apr, regenerates behavior_profile
        → predictions update; tomorrow's risk window may be flagged earlier
07:55   Geofence/sleep wake event → event 'wake'
        → first_app=instagram (still) → habits_bad.adherence ticks up
```

---

## 7. Explicitly Cut (one line each)

- **AccessibilityService** — adds days of work for in-app intent the user explicitly said they don't need.
- **iOS** — out of scope, doesn't exist for this build.
- **HMM / bandit RL / anomaly Z-scoring as a system** — replaced by deterministic SQL + LLM-composed profile.
- **Vector store / episodic memory / embeddings** — daily rollup JSON + LLM context window cover all current queries.
- **Cloud sync E2EE / libsodium / Tink** — Tailscale + bearer token is the security model for one user.
- **VPN-based network blocking** — no app-blocking in MVP, only nudges. Add overlay block in v1.x if needed.
- **MediaProjection screenshots** — useless without intent-classification, which is cut.
- **Call log / music sessions** — not needed, the user said so.
- **Wear OS / multi-device** — not needed.
- **Gradle multi-module split** — one Kotlin module, one RN app, one Node service.
- **Play Store policy work / permission justifications / prominent disclosures** — sideload, irrelevant.
- **TFLite app classifier** — 200-row JSON file + user override is sufficient and faster to ship.
- **Voice input** — `expo-speech` for TTS is fine in v1.1; speech-to-text is a Tuesday-killer. Type for now.
- **Glance / home-screen widget** — RN doesn't ship this for free; v1.1.

---

## 8. v1.x Roadmap (post-Tuesday)

- **v1.1** — Voice input (`@react-native-voice/voice`), home-screen widget (native Glance, surfaced via deep link), pre-open delay overlay for one user-chosen "trap" app.
- **v1.2** — Smart todo scheduling: backend picks best slot from `productivity_windows` and writes a fixed-time reminder.
- **v1.3** — Local LLM fallback (Gemini Nano on Pixel 8+ via AICore native bridge) so chat works offline.
- **v1.4** — App-blocker overlay (`SYSTEM_ALERT_WINDOW`) tied to rules.
- **v1.5** — On-device embeddings + semantic search over old days ("show me weeks I slept badly and worked late") — only when SQL queries become insufficient.
- **v1.6** — Resume-aware coaching: drop resume into the profile, weekly Sonnet pass to suggest skill-building tasks aligned with stated goals.
- **v1.7** — Calendar read (Google Calendar API) so productivity windows compete with real meetings.
- **v2.0** — AccessibilityService opt-in for in-app intent, only if you find rule-only nudges are too coarse after a month of real use.

---

*End of document.*

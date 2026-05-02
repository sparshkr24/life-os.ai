# AI Life OS — Architecture

> One user. One phone. No server. No cloud.
> Everything lives on the device. The only outbound network calls are HTTPS to the LLM API you configure.

---

## What This App Actually Does

Most phone tracking apps show you *what* you did. This app figures out *why*.

**The core insight:** Your phone has been silently recording a detailed log of your behavior for years. Every app you open, when you sleep, where you go, how active you are. That raw signal contains the answers to the questions you can't figure out on your own — why you keep getting distracted, why some days are great and others are a write-off, what actually triggers your bad habits.

AI Life OS reads that signal, extracts the causal patterns, and tells you what's actually happening — privately, on your phone, with no data ever leaving your device.

**The goal:** Automatic, causal, private behavioral understanding.

---

## Two Real Examples

### Example 1 — "Why can't I sleep before 2am?"

Without this app, you'd blame stress, caffeine, or bad habits in general. With it:

1. The app watches your phone for 2 weeks.
2. The nightly AI pass reads your raw event log and spots: every time you hit a hard task (long coding or writing session), you open Instagram within 8 minutes. This happens at 10pm, 11pm, 12am — it keeps pushing your sleep back.
3. It creates a memory: *"Avoidance loop — hard task → Instagram → sleep delay (avg 90 min). Confidence 0.81, seen 11 times."*
4. The next night, when you open Instagram at 10:47pm, the rule engine fires: *"You're in the avoidance loop again. The task is still there — Instagram won't make it easier."*

That's not a screen time alert. That's a diagnosis.

### Example 2 — "Why was Tuesday so productive?"

You had a 94/100 day last Tuesday. You have no idea why — you just felt good.

You open Chat and ask: *"Why was Tuesday so good?"*

The AI looks up Tuesday's rollup, pulls 3 relevant memories about your productive patterns, and tells you: *"You woke at 7:12am (your earliest in 2 weeks), didn't pick up your phone for 47 minutes after waking, and your first app was Notion. On your 8 best days, that 'no phone first thing' pattern appears every time."*

Now you know what to replicate.

---

## System Overview

```
┌─────────────────────────────── YOUR PHONE ────────────────────────────────┐
│                                                                            │
│  UI (React Native)                                                         │
│  Today  │  Observe  │  Chat  │  Settings                                  │
│                                                                            │
│                         reads ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  SQLite  (lifeos.db)                                                 │  │
│  │  events · daily_rollup · memories · behavior_profile · rules        │  │
│  │  nudges_log · llm_calls · places · app_categories · schema_meta     │  │
│  └────────────────┬──────────────────────┬────────────────────────┬────┘  │
│                   │                      │                        │        │
│  Kotlin service   │    15-min aggregator │           Nightly AI   │        │
│  (24/7 collector) │    (pure SQL, no AI) │           (~3am)       │        │
│  ───────────────  │    ────────────────  │           ─────────    │        │
│  app usage        │    clean events      │           Pass 1:      │        │
│  sleep            │    classify silences │           raw events → │        │
│  activity         │    rebuild rollup    │           memories     │        │
│  location         │    score day         │                        │        │
│  steps / HR       │    run rule engine   │           Pass 2:      │        │
│  + stamps every   │    check nightly     │           memories +   │        │
│    event with     │    watchdog          │           rollups →    │        │
│    context (_ctx) │                      │           profile      │        │
│                   │                      │                        │        │
│                   │                      │           Pass 3:      │        │
│                   │                      │           memories +   │        │
│                   │                      │           profile →    │        │
│                   │                      │           AI rules     │        │
└───────────────────┴──────────────────────┴────────────────────────┴────────┘
                                                              │
                                                              ▼ HTTPS
                                                   OpenAI / Anthropic / etc.
```

---

## The Data Layer

### Tables

| Table | What it stores |
|---|---|
| `events` | Immutable raw stream. Every app open, sleep segment, step burst, location enter/exit. Each payload is stamped with ambient context at write-time (place, battery %, charging, network, audio). |
| `daily_rollup` | Pre-computed summary per day. Top apps, sleep time, steps, places visited, productivity score. Rebuilt every 15 minutes. |
| `monthly_rollup` | Rolled-up monthly view. Folded from daily rows once per day. |
| `behavior_profile` | One JSON blob. The AI's current model of who you are — causal chains, habit loops, silence patterns, rule suggestions. Rebuilt nightly. |
| `memories` | AI-extracted patterns with embeddings for search. Immutable semantic content; only feedback columns (confidence, reinforcement, contradiction) mutate. |
| `rules` | If/then nudge rules. Seed rules + AI-generated rules from the nightly pass. |
| `nudges_log` | Every nudge fired + your thumbs up/down rating + automated score delta. |
| `llm_calls` | One row per AI call. Cost cap reads `SUM(cost_usd)` from here. |
| `places` | Your named geofenced locations (home, gym, office, etc.). |
| `app_categories` | Per-package category labels. The AI enriches these nightly from observed usage. |
| `proactive_questions` | Questions the AI asked you proactively + your answers. |
| `schema_meta` | Key-value store for system state (last nightly run, task model assignments, etc.). |

### Invariants

- `events` is immutable. No code path rewrites `ts`, `kind`, or the original `payload` fields.
- `memories` semantic content (`summary`, `cause`, `effect`, `embedding`) is immutable after creation. Only feedback columns change, or the row is soft-archived.
- Everything is soft-deleted. No `DELETE FROM` anywhere for data rows.
- Truth is always `events` + `daily_rollup`. Everything else (memories, profile, rules) is derived and rebuildable.

---

## The 4 Runtime Loops

### Loop 1 — Kotlin Foreground Service (always running)

A sticky Android service that survives reboots. Collects:

| Collector | What it writes |
|---|---|
| UsageStats poller (60s) | `app_fg` — which app is in the foreground, for how long. Deduplicates session fragments. |
| ActivityRecognition | `activity` — walking, running, in vehicle, still. |
| Sleep API | `sleep` — sleep segments + classification confidence. |
| GeofenceReceiver | `geo_enter` / `geo_exit` — when you enter/leave a named place. |
| Health Connect (5 min) | `steps`, `heart_rate` — from wearables or phone sensors. |
| StepCounter fallback | `steps` — hardware sensor when Health Connect unavailable. |

Every single event gets a `_ctx` block stamped onto its payload at write-time: current place, battery %, charging, network type. This means every memory the AI extracts will know exactly what was happening around you.

### Loop 2 — 15-Minute Aggregator (background, no AI)

Runs every 15 minutes whether the app is open or not. Pure deterministic SQL — zero AI calls.

```
1. Clean noisy events
   (remove launchers, system UI, sub-1-second app flickers, merge 90-second gaps)

2. Classify silences
   (gap ≥ 60 min with no active events → label as sleep / focused / workout / unknown)

3. Rebuild today's daily_rollup
   (total app time by category, sleep segment, place hours, first pickup, transitions)

4. Compute productivity score (0–100)
   (sleep 30% + focus 25% + wake time 15% + movement 15% + nudge response 15%)

5. Once per day: fold monthly rollup

6. Run rule engine (check all enabled rules → fire notifications if triggered)

7. Check nightly watchdog (if after 3am and >20h since last run → kick nightly AI)
```

### Loop 3 — Rule Engine (every 60 seconds, fully offline)

Checks every enabled rule against current state. Fires a local notification if triggered. No internet needed.

Rules have 3 trigger shapes:
- `{ app, after_local, threshold_min_today }` — "You've used Instagram for 60+ min and it's after 10pm"
- `{ after_event: 'wake', within_sec, app_any }` — "You opened YouTube within 5 min of waking up"
- `{ between_local, category, threshold_min, location }` — "You're at the gym but have under 20 min of exercise"

Seed rules are hand-authored. AI-generated rules are created by the nightly Pass 3 and slot right into the same engine.

### Loop 4 — Nightly AI Brain (~3am, three sequential passes)

The expensive part. Runs once per day. Three AI sessions in sequence, each with its own tool-calling loop.

```
PRE-PASS (no tokens):
  Finalize yesterday's productivity score
  Compute nudge effectiveness for past 7 days

PASS 1 — Memory Pass  (up to 8 tool loops)
  Input:  Yesterday's full raw event log (up to 2,000 events with _ctx)
          + yesterday's daily_rollup
          + prior behavior_profile
          + unverified predictions + shaky memories (low confidence or contradicted)
  
  AI calls tools to:
    create_memory       → extract new patterns from yesterday
    verify_memory       → check predictions that targeted yesterday
    reinforce_memory    → confirm patterns the day validates
    contradict_memory   → lower confidence on patterns the day disproves
    consolidate_memories → merge 3+ similar specifics into an abstract parent
    set_app_category    → enrich unenriched app packages

  Output: Updated memories table. No JSON parsing — side effects are the output.

PASS 2 — Profile Pass  (up to 4 tool loops, read-only)
  Input:  Last 30 daily_rollups + last 3 monthly_rollups
          + top 25 memories by (|impact| × confidence)
          + verified facts (SQL-derived correlations)
  
  Output: New behavior_profile JSON → validated → saved to DB

PASS 3 — Nudge Pass  (up to 6 tool loops)
  Input:  Just-built profile + all AI-generated rules
          + top 30 actionable memories (high impact, high confidence)
          + 14-day nudge log (fired / acted / helpful / annoying)
  
  AI calls tools to:
    get_rule_effectiveness → evaluate how each AI rule has been performing
    update_rule / disable_rule → refine or kill underperforming rules
    create_rule → write ≤4 new rules grounded in memories

  Output: Updated rules table.

After all passes: runMemoryMaintenance()
  Pure SQL safety sweep — archives failed predictions, consistently wrong memories,
  bottom-confidence rows, and consolidation children whose parent has survived 14 days.
```

**Hard rule:** Raw events go to Pass 1 only. Chat, the profile pass, and the nudge pass all see only derived data (rollups + memories). This keeps costs low and prevents noise from contaminating higher-level reasoning.

**Cost envelope:**

| Day (event volume) | Typical total cost |
|---|---|
| Light (~600 events) | ~$0.05 |
| Normal (~1,200 events) | ~$0.09 |
| Heavy (~2,500 events, cap) | ~$0.21 |

Hard daily cap: $0.30. Enforced before every single AI call.

---

## The Memory System

The memory system is what makes the app get smarter over time instead of just replaying data.

### How a memory is born

```
Pass 1 reads yesterday's raw events
      ↓
AI calls create_memory({
  type: 'causal',
  summary: 'Late chess games push sleep past 2am',
  cause: 'Chess session ending after 11pm',
  effect: 'Sleep onset > 2am, next-day score < 55',
  impact_score: -0.7,
  confidence: 0.5,
  tags: ['chess', 'sleep', 'late-night']
})
      ↓
embedText() converts text to 1536 numbers
      ↓
Row saved to memories table
```

### How memories get smarter (or die)

| What happens | Effect |
|---|---|
| Pattern repeats on another day | `reinforce_memory` → confidence +0.05 (cap 0.99) |
| Pattern disproved by a day's evidence | `contradict_memory` → confidence -0.10 (floor 0.05) |
| Confidence < 0.10, never reinforced | Auto-archived by maintenance sweep |
| 3+ contradictions and only 1 reinforcement | Auto-archived |
| 3+ similar specific memories accumulate | Consolidated into abstract parent memory |
| Parent alive ≥ 14 days | Children auto-archived |

### How memories are retrieved (RAG)

When the AI needs context for chat, profile rebuild, or nudge generation — it doesn't read every memory. It searches:

```
Query text (e.g. "what happens when I stay up late")
      ↓
Embed query → 1536-number vector
      ↓
Compare against every active memory's vector (cosine similarity)
      ↓
Re-rank by:
  50% × similarity score
  20% × recency (how recently accessed)
  15% × |impact score|
  15% × confidence
      ↓
Return top-k as markdown → inject into AI prompt
```

In-process cosine scan. No vector database needed. Performant up to ~5,000 memories.

---

## The LLM Router

All AI calls go through `llm/router.ts`. Never directly to `fetch`.

```
runChatTask(taskKind, request)
      ↓
resolve which model handles this task (user assignment → default fallback)
      ↓
check daily cost cap ($0.30 hard wall)
      ↓
get provider API key
      ↓
call provider adapter (OpenAI / Anthropic / MiniMax / DeepSeek)
      ↓
log to llm_calls
      ↓
return { kind: 'ok' | 'skipped' | 'failed', response }
```

Never throws. Callers always get a discriminated union back and handle all three outcomes.

**Supported providers:**

| Provider | Chat | Embeddings |
|---|---|---|
| OpenAI | ✅ | ✅ (text-embedding-3-small) |
| Anthropic | ✅ | ❌ |
| MiniMax | ✅ | ❌ |
| DeepSeek | ✅ | ❌ |

Embeddings are fixed to `text-embedding-3-small` (1536-dim). Every `memories.embedding` row uses this model — switching requires a re-embed migration.

Adding a new provider: one file in `providers/`, one row in `MODELS`, add to `ProviderId` union. Nothing else changes.

---

## Chat

`brain/chat.ts` — `runChatTurn(history)` runs a tool-calling loop (max 4 turns).

The chat assistant has access to read-only views of your data and a few write tools:

**Read tools:** today's summary, daily rollups, monthly rollups, profile, recent nudges, memory search, raw event windows, app time breakdowns, places list, todos, proactive questions.

**Write tools:** create/update todos, propose a rule (inserted disabled, for your review), archive a memory, add a geofenced place, ask you a proactive question.

Every chat response is grounded in your actual data. The AI cannot invent statistics — numbers come from SQL queries.

---

## Proactive Questions

The system can interrupt you with a question when it detects a gap in its understanding.

Three triggers (checked every aggregator tick):
- **Long unknown dwell** — you've been in one place for 90+ minutes and the place isn't named in your geofences
- **Weekend late night** — it's a Saturday or Sunday between 10pm–2am and you're idle
- **No phone usage** — less than 5 minutes of app foreground time in the last 2 hours during normal hours

When triggered: one AI call drafts a question (with options matching `expected_kind`), an interactive notification fires, and the answer is materialized into a memory tagged with the trigger context.

Hard limits: max 3 questions per day, ≥6h between any two, no question if one is already pending.

---

## The UI

Four tabs. Everything else is an overlay from Settings.

```
TODAY
  Productivity score (0–100) with 7-day sparkline
  Sleep card (bedtime → wake time)
  Top 3 apps with brand icons + category labels
  Today's nudges with ▲/▼ rating
  Pending AI question (if any)

OBSERVE
  Events feed (raw stream, infinite scroll)
  Daily/monthly rollup dashboard
  LLM call log (cost per call)
  Nudges history (filter by helpful/annoying)

CHAT
  Ask anything about your patterns
  Full tool-calling against your SQLite data

SETTINGS → PROFILE
  Your current behavior_profile rendered:
    causal chains, habit loops, verified correlations, rule suggestions

SETTINGS → AI MODELS
  Configure API keys for each provider
  Assign which model handles each task

SETTINGS → PLACES
  Add/edit/delete geofenced locations
  Capture current GPS position
```

---

## Redesign Direction

The current app is built for a developer. The launch version should feel like the app already knows the user.

**What this means concretely:**

| Current | Launch |
|---|---|
| "Grant Usage Access"	 | Tell us one pattern you wish you understood
 |
| First screen is a permissions checklist | First screen is a single promise: "In 3 days, we'll show you something about yourself you didn't know." |
| Today screen leads with system status + debug buttons | Today screen leads with the insight, not the infrastructure |
| Behavior profile buried in Settings → Profile | Profile IS the home screen once data exists (>3 days) |
| Raw event tables visible by default | Hidden behind a developer toggle |
| Productivity score as the hero metric | The most surprising recent insight as the hero |
| "Run aggregator now" debug button prominent | Invisible to normal users |

The **behavior profile** and **chat** are the product. Everything else is plumbing that should be invisible.


#### **The pitch that drives the redesign:**

###### What's Actually Missing in the Market (the real opportunity)
Every productivity/tracking app today does one of two things:

1. Passive data (Screen Time, Wellbeing) — shows you numbers, no insight, no action
2. Manual input (journals, habit trackers) — only as good as your self-awareness
3. Automatic, causal, private behavioral understanding — nobody does this.

That's the white space. The pitch is:

> *"You don't need more discipline. You need to understand the actual trigger. Your phone has the data. We decode it."*

Every screen decision should be evaluated against: does this help the user understand a cause-effect relationship they didn't see before?

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React Native (Expo bare) + TypeScript strict |
| Native collectors | Kotlin (single bridge module, OS APIs only) |
| Local database | `expo-sqlite` (rollback journal — not WAL, required for Kotlin+JS dual access) |
| API key storage | `expo-secure-store` |
| Notifications | `expo-notifications` (local only, no FCM) |
| Background work | `expo-background-fetch` + `expo-task-manager` (Android WorkManager) |
| Nightly alarm | `AlarmManager` (Kotlin) |
| AI calls | Direct HTTPS `fetch` — no SDKs |

---

## How to Run

No server. Two terminals:

```bash
# Terminal 1 — Metro
cd client && npx expo start --dev-client

# Terminal 2 — install (only when Kotlin or manifest changes)
cd client/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
adb shell am force-stop com.lifeos
adb shell monkey -p com.lifeos -c android.intent.category.LAUNCHER 1
```

JS-only changes hot-reload through Metro. Only rebuild when Kotlin or `AndroidManifest.xml` changes.

### Required env

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH=$JAVA_HOME/bin:$PATH:$ANDROID_HOME/platform-tools
```

### Useful logcat

```bash
adb logcat -s 'LifeOsService:*' 'LifeOsBridge:*' 'LifeOsBoot:*' 'AndroidRuntime:E'
```

---

## Hard Rules

1. **No server, ever.** All state lives in `<filesDir>/SQLite/lifeos.db`.
2. **Raw events go to the memory pass only.** Chat, profile, rules all see derived data.
3. **Schema is JS-owned.** Kotlin only INSERTs against columns declared in `db/schema.ts`.
4. **Cost cap is a hard wall.** Every AI call checks today's spend first.
5. **Memories are append-only at the semantic level.** Soft-archive, never edit summary/cause/effect/embedding.
6. **Events are immutable.** No code path rewrites `ts`, `kind`, or original payload fields.
7. **The LLM narrates facts, never invents them.** All correlation numbers come from `verifiedFacts.ts`.

# AI Life OS — Architecture

> One user. One phone. One developer. No server. No cloud DB.
> Everything in this document describes the **current** implementation. Per-folder details live in `CLAUDE.md` files; this doc is the system-level map.

---

## Version preamble (history in 6 lines)

- **v1** (cut) — Express + Postgres backend, phone as a thin client. Deleted 2026-04-26.
- **v2** — Local-first foundation: Kotlin foreground service + `expo-sqlite` + 15-min aggregator + nightly Sonnet profile rebuild + smart-nudge tick + tool-calling chat.
- **v3** — Intelligence evolution: derived **memory store** with embeddings + RAG, single-session tool-calling **nightly** that extracts/verifies/consolidates memories and enriches app categories in one pass, multi-provider LLM router collapsed to **OpenAI + OpenRouter** only, ambient phone-state stamped onto every event payload at write time.

The shipped system is v3. v2 is the substrate underneath.

---

## 1. TL;DR

- **No backend.** The phone is the entire system. Only outbound network calls are HTTPS to the LLM provider you configured (OpenAI direct, or OpenRouter).
- **Local SQLite** (`expo-sqlite`, WAL on, schema v5) is the source of truth at `<filesDir>/SQLite/lifeos.db`.
- **Kotlin foreground service** writes raw events; every payload gets stamped with the current ambient `_ctx` (place, battery, charging, network, audio) at insert time.
- **Aggregator** (`expo-background-fetch`, every 15 min) maintains `daily_rollup` + `monthly_rollup` + `productivity_score` deterministically.
- **Rule engine** (in-process, every 60 s) handles deterministic nudges offline.
- **LLM brain** runs on-device through outbound API calls:
  - **Nightly** (~03:05 local) — one tool-calling session: extract memories → verify yesterday's predictions → reinforce/contradict → consolidate → enrich `app_categories` → emit final `behavior_profile` JSON.
  - **Chat** — on-demand, tool-calling against local SQLite (read-only views + a few user-confirmed writes).
  - **Smart-nudge tick** — Stage 7 v2 path; intended to be retired once Stage 14 LLM-generated rules ship.
- **Multi-provider LLM** through one router. Today: **OpenAI** (chat + embeddings) and **OpenRouter** (chat). Adding a third provider = one file in `client/src/llm/providers/` + one row in `MODELS`.
- **API keys** entered in app Settings, persisted via `expo-secure-store`. Editable.
- **Hard daily LLM cost cap**: $0.30, enforced before every call. Tracked in `llm_calls`.
- **Notifications** — local only (`expo-notifications`). No FCM.
- **Backups** — weekly DB export to `Documents/lifeos-backup-YYYYMMDD.db` (Stage 10).

---

## 2. Diagram

```
┌──────────────────────── PHONE (sideloaded APK) ──────────────────────────┐
│                                                                          │
│  React Native UI (TypeScript, strict)                                    │
│   ├─ Today  ├─ Observe (Events / Rollups / LLM / Nudges)                 │
│   ├─ Chat   └─ Settings ─► Profile / AI Models / Permissions             │
│                                                                          │
│            writes ▲              reads ▼                                 │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  SQLite (lifeos.db, WAL, schema v5)                                │  │
│  │  events · daily_rollup · monthly_rollup · behavior_profile         │  │
│  │  memories · todos · rules · nudges_log · llm_calls                 │  │
│  │  places · app_categories · schema_meta                             │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│            ▲                       ▲                  ▲                  │
│  Kotlin FG service        Aggregator (15 min)        Brain (TS)          │
│  ─────────────────        ───────────────────        ───────────         │
│   PhoneState (ambient)    purgeShortAppFg            llm/router          │
│    └─ stamps every        classifySilences           memory/embed        │
│       payload's _ctx      rebuild daily_rollup       memory/store        │
│   UsageStatsPoller        productivityScore          memory/rag          │
│   SleepApi / AR           monthly fold (1×/day)      brain/tools         │
│   GeofenceReceiver        nightly watchdog ───┐      brain/chat          │
│   NotificationListener                        │      brain/nightly       │
│   Health Connect (5 min)                      ▼                          │
│                                AlarmManager 03:05 ─► nightly tool session│
│                                                     ─► behavior_profile  │
└──────────────────────────────────────────────────────────────────────────┘
                                                          │
                                                          ▼
                                          OpenAI / OpenRouter (HTTPS)
```

---

## 3. Tech stack

- React Native (Expo bare) + TypeScript strict
- Kotlin (single bridge module — OS APIs only, no business logic)
- `expo-sqlite` (WAL on)
- `expo-secure-store` for API keys + cost cap
- `expo-notifications` (local only)
- `expo-task-manager` + `expo-background-fetch` for the 15-min worker
- `AlarmManager` (Kotlin) for the 03:05 nightly kick
- LLM: direct HTTPS via `fetch` — no SDKs. Two providers configured (`openai`, `openrouter`).

---

## 4. Data layer

### 4.1 Schema (v5)

Defined in [client/src/db/schema.ts](../client/src/db/schema.ts). Migrations are **additive only** through `addColumnIfMissing`. Never DROP / RENAME.

Tables:

| Table | Role |
|---|---|
| `events` | Raw events from collectors. `(ts, kind, source, payload)`. Payload is JSON; the Kotlin writer stamps an ambient `_ctx` block (`place_id`, `batt`, `charging`, `net`, `audio`) onto it at insert time. NotificationListener writes one row per ongoing notification (with `end_ts`/`duration_ms` filled in on removal) and dedupes transient notifications by `pkg|category` within 30 s. |
| `daily_rollup` | One row per local date. JSON `data` blob plus first-class `productivity_score`. |
| `monthly_rollup` | One row per month. Folded once per day from daily rollups. |
| `behavior_profile` | Single row (`id=1`). v3 JSON (causal_chains, day_attribution, rule_suggestions, silence_priors, silence_correlations). Rebuilt nightly. |
| `memories` | v3 derived store. `(id, type, summary, cause, effect, impact_score, confidence, occurrences, embedding TEXT, tags, predicted_outcome, actual_outcome, was_correct, parent_id, child_ids, archived_ts, ...)`. Embeddings = JSON-encoded `number[]` (1536-dim, `text-embedding-3-small`). Soft-delete via `archived_ts`. |
| `todos` | User todos. Created via the chat `create_todo` tool or manually. |
| `rules` | Deterministic nudge rules. Stage 14 will populate this from the LLM weekly. |
| `nudges_log` | Every nudge that fired, plus `score_delta` (LLM-computed effectiveness) and `user_helpful` (manual ▲/▼ feedback). |
| `llm_calls` | One row per LLM call. Cost cap enforcement reads `SUM(cost_usd)` for today. |
| `places` | User-named geofences. |
| `app_categories` | `(pkg, category, subcategory, source, enriched, last_categorized_ts, details)`. New pkgs auto-inserted as `('neutral','discovered',0)` by the aggregator; the nightly LLM enriches them via `set_app_category`. |
| `schema_meta` | KV store: `last_nightly_ts`, `task_assignments` JSON, etc. |

### 4.2 Invariants

- Truth lives in `events` + `daily_rollup` (+ `verifiedFacts` derived from them). `memories`, `behavior_profile`, and the LLM tool surface are all **derived** and rebuildable.
- Original event metadata (`ts`, `kind`, `payload`) is **immutable** — no code path mutates it.
- Memory semantic content (`summary`, `cause`, `effect`, `embedding`, `created_ts`, `rollup_date`) is **immutable** after `createMemory`. Only feedback columns mutate.
- Soft-delete only on memories.

---

## 5. Native (Kotlin)

Files in `client/android/app/src/main/java/com/lifeos/` — see [client/android/app/src/main/java/com/lifeos/CLAUDE.md](../client/android/app/src/main/java/com/lifeos/CLAUDE.md) for per-file details.

- **`LifeOsForegroundService`** — long-running FG service; calls `PhoneState.init(this)` first, then drives every collector.
- **`PhoneState`** — singleton holding ambient `placeId`, `batteryPct`, `isCharging`, `networkType`. Updated by passive listeners (BatteryReceiver, ConnectivityManager.NetworkCallback) and `GeofenceReceiver`. **Never** issues fresh GPS or expensive queries. `stamp(payloadJson)` merges a `_ctx` block into the payload string before insert. Idempotent.
- **`EventDb`** — three insert/update entry points; every one runs payload through `PhoneState.stamp(...)`.
- **Collectors** — `UsageStatsPoller`, `SleepReceiver`, `ActivityRecognitionReceiver`, `GeofenceReceiver`, `LifeOsNotificationListener`, `HealthConnectPoller`. Each writes to `events` via `EventDb`.
- **`LifeOsBoot`** — re-arms the FG service on `BOOT_COMPLETED`.
- **`LifeOsBridge`** — only TS-callable surface (start service, query permissions, set geofences, etc.).

Schema is JS-owned. Kotlin only does INSERT/SELECT against columns declared in `schema.ts`.

---

## 6. Aggregator (15 min)

[client/src/aggregator/](../client/src/aggregator/) — see its CLAUDE.md.

Each tick (in order):

1. `purgeShortAppFg` — drop sub-threshold `app_fg` events.
2. `classifySilences` — write `inferred_activity` events for long quiet periods.
3. Rebuild today's `daily_rollup`. (`aggApps` `INSERT OR IGNORE`s every observed pkg into `app_categories` so the nightly LLM has a backlog to enrich.)
4. Recompute `productivity_score` for today.
5. Once-per-day: monthly fold + nightly watchdog (fires `runNightlyRebuild` if local hour ≥ 3 and >20h since last success).

All deterministic SQL. No LLM.

---

## 7. Brain (LLM)

[client/src/brain/](../client/src/brain/) — see CLAUDE.md.

### 7.1 Tool surface — `brain/tools.ts`

Single registry. Every LLM-callable tool is declared once with a `scopes` field listing which call(s) may use it. `getToolsForScope(scope)` returns `{defs, run(name, args)}`.

Three scopes: `chat`, `nightly_memory`, `nightly_profile`.

| Scope | Read tools | Write tools |
|---|---|---|
| `chat` | get_today_summary, get_daily_rollup, get_recent_rollups, get_monthly_rollup, get_profile, get_recent_nudges, search_memories, get_memory, get_events_window, count_events_by_app, get_app_categories | create_todo, update_todo, propose_rule (`enabled=0`), mark_memory_archived |
| `nightly_memory` | (all chat reads) | create_memory, verify_memory, reinforce_memory, contradict_memory, mark_memory_archived, consolidate_memories, set_app_category |
| `nightly_profile` | (all chat reads) | *(none — read-only pass that emits the final profile JSON)* |

The tool surface is the **only** way the LLM mutates state. The memory pass is the *only* call that can create/mutate memories or enrich app categories; the profile pass cannot.

### 7.2 Chat — `brain/chat.ts`

`runChatTurn(history)` runs a tool-calling loop (`TOOL_LOOPS=4`) with `getToolsForScope('chat')`. RAG: `buildChatSystemPrompt` calls `retrieveContext({decisionType:'chat'})` and appends the markdown memory block. Cost = sum of per-loop usage.

### 7.3 Nightly — `brain/nightly.ts` (two-pass, raw-events-aware)

Watchdog fires once per night around 03:05 local. **Two separate model runs**, each its own tool-calling loop. Splitting them lets the memory pass eat the expensive raw-event context while the profile pass stays cheap and deterministic — and isolates failure (a malformed profile JSON cannot lose the memories already saved).

**Pre-LLM (idempotent SQL, no tokens):** finalise yesterday's `productivity_score`, run `computeNudgeEffectiveness` for the last 7 days.

**Pass 1 — Memory (`runMemoryPass(yesterday)`)**

Goal: build the most accurate possible mental model of *yesterday* from primary evidence, and reconcile it with the existing memory store.

Inputs (assembled by `brain/rawEvents.ts` + helpers):
- **Yesterday's full event timeline**, sorted by `ts`, one event per line in compact JSON. Every payload still carries the `_ctx` block stamped at insert time (place, battery, charging, network, audio). Hard cap `MAX_EVENTS_FOR_MEMORY ≈ 2000`; over the cap, low-signal `app_fg` rows below a duration threshold are dropped first.
- Yesterday's `daily_rollup` (the deterministic summary, for cross-checking).
- Date / weekday / month-day for the target date.
- PRIOR profile snapshot.
- Recent memory state: unverified predictions targeting yesterday, count of un-enriched `app_categories`, top-k similar active memories pulled by `retrieveContext`.

Loop: up to `MEMORY_TOOL_LOOPS = 8`, scope `nightly_memory`. The model is instructed to **extract** new memories (`create_memory`), **verify** predictions whose target date has passed (`verify_memory`), **reinforce / contradict / archive** memories the day confirms or refutes, **consolidate** clusters of specifics into abstract parents (`consolidate_memories`), and **enrich** unenriched `app_categories` rows (`set_app_category`). The final assistant message is free-form — we do not parse it; the side effects (memory rows + app_category rows) *are* the output.

**Pass 2 — Profile (`runProfilePass(yesterday)`)**

Goal: rebuild `behavior_profile.data` from rollups + verified correlations + the memory store the memory pass just refreshed.

Inputs:
- PRIOR profile.
- Last 30 `daily_rollup` rows + last 3 `monthly_rollup` rows.
- `buildVerifiedFacts(...)`.
- A digest of the memory store (top memories by `computeEffectiveScore`, recent verified predictions, recent contradictions).

Loop: up to `PROFILE_TOOL_LOOPS = 4`, scope `nightly_profile` (reads only). Final assistant message is the new `behavior_profile` JSON (no prose). Validate (strip ``` fences, slice to brace pair, check v3 sentinel keys) → UPSERT `behavior_profile` (id=1) → write `schema_meta.last_nightly_ts`.

**Cost envelope (gpt-5.4-mini, $0.25 / $2.00 per M tokens):**

| Day shape | Memory pass | Profile pass | Total |
|---|---|---|---|
| ~600 events | ~$0.04 | ~$0.01 | ~$0.05 |
| ~1200 events | ~$0.08 | ~$0.01 | ~$0.09 |
| ~2500 events (cap) | ~$0.20 | ~$0.01 | ~$0.21 |

Both passes go through the cost-cap wall (`llm/ledger.ts`). If the memory pass exhausts the cap, the profile pass is skipped — yesterday's memories are still saved, profile rebuild retries the next night.

**Mutation invariants (still hold):** memory mutation is restricted to feedback columns. The original `summary`/`cause`/`effect`/`embedding` of every memory is permanent (or the row gets archived and a new one is created). Original event payload/ts/kind are immutable forever.

### 7.4 Smart-nudge tick — `brain/smartNudge.ts`

Every 15 min, gated by 90-min smart cooldown. Single JSON-mode call, fires at most one notification. Will be retired once Stage 14 LLM-generated rules ship.

---

## 8. Memory store

[client/src/memory/](../client/src/memory/) — see CLAUDE.md.

- **`embed.ts`** — wraps `runEmbedTask('embed', ...)`. `text-embedding-3-small` (1536-dim). Returns `null` on cap/no-key/fail. Exports `cosineSim`.
- **`store.ts`** — CRUD + scoring. `createMemory` is the only insert path; it embeds and inserts atomically, returns `null` on embed failure. `reinforceMemory`, `contradictMemory`, `archiveMemory`, `recordPredictionOutcome`, `touchMemories`. `computeEffectiveScore(m)` blends raw impact + reinforcement vs. contradiction + recency decay.
- **`rag.ts`** — `retrieveContext(query)` embeds the query, scans active memories with `cosineSim`, re-ranks by `0.5·sim + 0.2·exp(-daysOld/30) + 0.15·|impact| + 0.15·confidence` (+ tag-overlap bonus), `touchMemories` on top-k. Returns a markdown `contextBlock` ready to drop into a prompt. On embed failure returns `{embedded:false, memories:[]}` so callers fall back gracefully.

No `sqlite-vss`. No native module. In-process cosine over `WHERE archived_ts IS NULL`.

---

## 9. LLM provider abstraction

[client/src/llm/](../client/src/llm/) — see CLAUDE.md.

- **`router.ts`** — `runChatTask(taskKind, request)` and `runEmbedTask(request)`. Both return discriminated unions (`ok` / `skipped` / `failed`); never throw. Handles cost cap, key lookup, provider dispatch, pricing, `llm_calls` insert.
- **`models.ts`** — declarative catalogue. Today: `gpt-5.4-mini` (chat + tools), `text-embedding-3-small` (embed), `openai/gpt-5.4-mini` (chat via OpenRouter), and OpenRouter's reasoning-class model. `DEFAULT_TASK_MODELS` maps each `TaskKind` to a default.
- **`providers/`** — one adapter per provider. `openai.ts` (chat + embed), `openrouter.ts` (chat, OpenAI-compat shape with `HTTP-Referer` + `X-Title`).
- **`keys.ts`** — `expo-secure-store` keyed by provider id. Settings → AI Models lets the user paste any subset of provider keys and pick which model handles each task.
- **`assignments.ts`** — persisted in `schema_meta.task_assignments`. Per-task model override.
- **`ledger.ts`** — single source of truth for cost-cap reads + `llm_calls` writes.

Adding a third provider: create one file in `providers/`, add models to `models.ts`, add `'foo'` to `ProviderId` and `ALL_PROVIDERS`. No other code changes.

---

## 10. UI (React Native)

[client/src/screens/](../client/src/screens/) — see CLAUDE.md.

Bottom tabs: **Today**, **Observe**, **Chat**, **Settings**. Settings opens **Profile**, **AI Models**, and the **Permissions** card as overlays.

All screens read directly from SQLite (no Redux, no fetcher). Manual `Run aggregator now` button on Today for debugging.

---

## 11. Hard rules (assistants must obey)

These are the same rules in [CLAUDE.md](../CLAUDE.md), repeated for visibility.

**1. Simplicity above all.** Write code a human can read top-to-bottom and understand on first pass. Prefer fewer lines, but not at the cost of clarity. Use intuitive, fully-spelled variable and function names — 1–4 word names are fine; cryptic abbreviations are not. Debuggability > extensibility.

  *Anti-pattern (don't do this):*
  ```ts
  for (const r of ranked) {
    const m = r.memory;
    const impactPct = (m.impact_score * 100).toFixed(0);
    const confPct  = (m.confidence   * 100).toFixed(0);
    // ...
  }
  ```
  *What's wrong:* `r`, `m`, `pct` force the reader to scroll up to remember what each is.

  *Better:*
  ```ts
  for (const ranked of rankedMemories) {
    const memory = ranked.memory;
    const impactPercent     = (memory.impact_score * 100).toFixed(0);
    const confidencePercent = (memory.confidence   * 100).toFixed(0);
    // ...
  }
  ```

2. No `any`. Strict TS. Fix types at the source.
3. No future-stage installs.
4. No abstractions for one call site.
5. Local-first, no server.
6. **Raw events go to ONE LLM call only: `runMemoryPass`.** That pass receives yesterday's full event timeline (ts, kind, source, payload, `_ctx` ambient block — place, battery, charging, network, audio, weekday, etc.) so memories are precise and personalised. Every other LLM surface (chat, profile pass, smart-nudge) sees only `behavior_profile` + rollups + memory context (via RAG). Memories — built from raw evidence — are the canonical bridge between primary data and the rest of the brain.
7. Schema is JS-owned. Kotlin only INSERT/SELECTs declared columns.
8. Cost cap is a hard wall. Every LLM call checks today's `llm_calls.cost_usd` sum first.
9. CLAUDE.md is read before editing and updated after.
10. The LLM narrates facts, never invents them. Correlation numbers come from `verifiedFacts.ts`.
11. **Memories are append-only at the semantic level.** The LLM can mutate feedback columns and add/archive rows, never edit `summary`/`cause`/`effect`/`embedding`.
12. **Original event metadata is immutable.** No code path rewrites `ts`/`kind`/`payload`.

---

## 12. Stage tracker pointer

The active stage list (with status + scope per stage) lives in the project root [CLAUDE.md](../CLAUDE.md). This document only describes what is **already shipped**; for what's next, look there.

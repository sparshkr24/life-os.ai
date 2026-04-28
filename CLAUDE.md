# CLAUDE.md — Project Root

> **Mandatory rule for every AI assistant working in this repo:**
> **Before modifying any file, read the `CLAUDE.md` in that file's parent folder (or nearest ancestor that has one).**
> **After modifying, update that `CLAUDE.md` to reflect new/changed/removed files, function signatures, and call flows.**
> If a folder has no `CLAUDE.md` and you add ≥2 source files there, create one.

## Project

**AI Life OS** — sideload-only personal Android assistant. Tracks behavior 24/7, learns patterns, nudges. **Local-first: no backend, no cloud DB.** One user. No Play Store. No iOS.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The architecture doc is ground truth — do not propose changes that contradict it without flagging.

## Layout

| Folder | Role | Has CLAUDE.md |
|---|---|---|
| `client/` | React Native (Expo) app — UI, local SQLite, native bridge, on-device brain | yes |
| `client/src/` | TypeScript modules used by `App.tsx` | yes |
| `client/src/db/` | Local SQLite schema, migrations, seed | covered by `client/src/CLAUDE.md` |
| `client/src/ingest/` | Post-write event cleanup pipeline (noise/merge/short) | covered by `client/src/CLAUDE.md` |
| `client/src/bridge/` | TS wrapper around the Kotlin bridge | covered by `client/src/CLAUDE.md` |
| `client/src/screens/` | Tab screens (Today, Observe = Events+Rollups+LLM+Nudges, Chat, Settings) + Profile overlay reachable from Settings | covered by `client/src/CLAUDE.md` |
| `client/src/secure/` | Secure-store keys + cost-cap helpers | covered by `client/src/CLAUDE.md` |
| `client/src/llm/` | Provider-agnostic LLM dispatch (Stage 14): router, key store, model catalogue, OpenAI/Anthropic/MiniMax/DeepSeek adapters | yes |
| `client/src/memory/` | v3 memory store: embeddings, RAG, scoring (Stage 12+) | yes |
| `client/android/app/src/main/java/com/lifeos/` | Kotlin foreground service + bridge + boot receiver | yes |
| `docs/` | Architecture + design docs | no (prose only) |

`server/` was deleted on 2026-04-26 when the system went local-first. Do not recreate it.

## Stage tracker

### v2 — Foundation (delivered)

| Stage | Status | What it delivers |
|---|---|---|
| 1 | **done** | Scaffold + schema v1 + CLAUDE.md tree |
| 2 | **done** | Foreground Service + boot receiver + bridge + custom APK build |
| 3a | **done** | UsageStatsManager collector writing `app_fg` events |
| 3b | **done** | ActivityRecognition + Sleep API (broadcast receivers + FG service registration) |
| 3c | **done** | Geofencing + NotificationListener (bridge + Settings permissions card) |
| 3d | **done** | Health Connect (5-min poll from FG service; minSdk bumped to 26) |
| 4 | **done** | Schema v3 + observability tabs + secure-store key entry + chat shell |
| 5 | **done** | Aggregator (`expo-background-fetch` 15 min). Per tick: `purgeShortAppFg` → `classifySilences` (writes `inferred_activity`) → rebuild `daily_rollup` → recompute `productivity_score` (deterministic SQL). Monthly fold once per day. Manual `Run aggregator now` button on Today. |
| 6 | **done** | Rule engine (60 s) + 3-level local notifications + `nudges_log` |
| 7 | **done** | Smart-nudge tick (gpt-4o-mini) + cost cap enforcement |
| 8 | **done** | Nightly Sonnet profile rebuild. AlarmManager kicks the FG service at 03:05 daily; the JS watchdog inside the 15-min aggregator tick checks `schema_meta.last_nightly_ts` and runs `runNightlyRebuild` (claude-sonnet-4-5) when due. Cost-capped, validates JSON before persisting. |
| 9 | **done** | Chat (Sonnet, tool-calling against local SQLite). `client/src/brain/chat.ts` runs the loop: cost-cap + key check → POST `/v1/messages` with `tools` → if `stop_reason: tool_use`, run handler locally, append `tool_result`, repeat (max 4 loops). Tools are read-only views over rollups/profile/nudges — no raw events. Logs every turn to `llm_calls` (purpose='chat'). |
| 10 |  | Backups + retention sweeps + OEM autostart helper |
| 11 |  | Today screen polish + behavior-aware todo reminders |

### v3 — Intelligence Evolution

> Goal: lift `prediction_hit_rate_7d` from ~0.62 toward 0.90+ while *cutting* monthly LLM cost.
> Source: [docs/LIFEOS_ARCHITECTURE_EVOLUTION.md](docs/LIFEOS_ARCHITECTURE_EVOLUTION.md). Architecture impact: [docs/ARCHITECTURE.md §9](docs/ARCHITECTURE.md).
> Each stage is **additive** — v2 must keep working at every step. No big-bang rewrites.

| Stage | Status | What it delivers |
|---|---|---|
| 12 | **done** | **Memory store foundation.** Schema v4 adds `memories` table (id/type/summary/cause/effect/impact_score/confidence/occurrences/embedding/tags/predicted_outcome/actual_outcome/was_correct/archived_ts). New folder `client/src/memory/`: `embed.ts` (OpenAI `text-embedding-3-small`, cost-capped, logged to `llm_calls`), `store.ts` (insert/update/archive/score), `rag.ts` (cosine top-k retrieval, recency+impact+confidence re-rank). No LLM extraction or RAG-into-prompt yet — pure scaffolding. |
| 13 | **done** | **RAG into nightly + chat + daily extraction.** New `client/src/memory/extract.ts`: once-per-day extraction (gpt-4o-mini, strict JSON, gated by `schema_meta.last_extract_date`) called from `runNightlyRebuild` for yesterday's rollup. `brain/nightly.ts` and `brain/chat.ts` both call `retrieveContext` and append the markdown memory block to their prompts; on RAG miss (no memories, embed fail, cost cap) they fall back to the v2 path unchanged. New `LlmPurpose='extract'`. |
| 14a | **done** | **Multi-provider LLM abstraction (foundation for Stage 14).** New `client/src/llm/` folder (router, key store, model catalogue, adapters for OpenAI / Anthropic / MiniMax / DeepSeek). Every chat or embedding call now flows through `runChatTask` / `runEmbedTask`; cost-cap + `llm_calls` logging consolidated in `llm/ledger.ts`. Settings → AI Models UI lets the user paste any subset of provider keys and pick which model handles each task. See `client/src/llm/CLAUDE.md`. |
| 14 | **done** | **LLM-generated rules replace smart-nudge tick.** Schema v6 adds `rules.{source, predicted_impact_score, based_on_memory_ids, disabled_reason, last_refined_ts}`. New nightly Pass 3 (`runNudgePass` in `brain/nightly.ts`, scope `'nightly_nudge'`) runs after the profile pass: lists existing `source='llm'` rules, calls `get_rule_effectiveness` on each, refines/disables based on observed `score_delta` + `user_helpful`, then creates ≤4 new rules grounded in high-impact memories (predicted_impact_score ≥ 0.15, must cite memory ids). User/seed rules are read-only from this scope. Stage 7 smart-nudge tick deleted (`brain/smartNudge.ts` removed; aggregator no longer calls it). Net: ~96 LLM calls/day → 0 between nightlies, plus one tool-loop session per night. |
| 15 |  | **Self-learning loop.** Predictions stored as memories with `predicted_outcome`. Nightly job sets `actual_outcome` + `was_correct` from rollups. Memory `confidence` updated by reinforcement/contradiction counts. |
| 16 |  | **Pattern abstraction + merging.** Weekly consolidation pass merges similar specific memories into abstract parents (`parent_id`/`child_ids`); contradicted memories archived (soft-delete). |
| 17 |  | **Optimization & polish.** RAG result caching (5-min TTL), batch embedding while charging, edge-case handling (empty memory store → fall back to pre-RAG path), perf/battery profiling. |

**Stage-12 invariants (read before touching `client/src/memory/`):**
- `memories` is *derived*, never authoritative. Truth is still `events` + `daily_rollup` + `verifiedFacts`.
- Embeddings = JSON-encoded `number[]` in TEXT column. No `sqlite-vss`, no native module. In-process cosine scan over an indexed `WHERE archived_ts IS NULL` SELECT.
- Soft-delete via `archived_ts`. Never `DELETE FROM memories`.
- Embedding calls go through `sumTodayLlmCostUsd` cost-cap, same as every LLM call.
- `text-embedding-3-small` (1536-dim) only. Persist `embed_model` per row so a future swap is a re-embed migration, not a schema bump.

## How to run

There is **no server**. Two terminals:

```bash
# Terminal 1 — Metro
cd client && npx expo start --dev-client

# Terminal 2 — adb (only when reinstalling)
cd client/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
adb shell am force-stop com.lifeos
adb shell monkey -p com.lifeos -c android.intent.category.LAUNCHER 1
```

JS-only changes hot-reload via Metro. Rebuild only when Kotlin or `AndroidManifest.xml` changes.

### Required env (zsh)

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH=$JAVA_HOME/bin:$PATH:$ANDROID_HOME/platform-tools
```

### Useful logcat

```bash
adb logcat -s 'LifeOsService:*' 'LifeOsBridge:*' 'LifeOsBoot:*' 'AndroidRuntime:E'
```

## Tech stack (locked — see ARCHITECTURE.md §4)

- React Native (Expo bare) + TypeScript strict
- Kotlin (single bridge module, OS-API-only)
- `expo-sqlite` (WAL on)
- `expo-secure-store` for API keys
- `expo-notifications` (local only — no FCM)
- `@anthropic-ai/sdk` + `openai` called direct from RN
- `expo-task-manager` + `expo-background-fetch` for 15-min worker
- `AlarmManager` (Kotlin) for nightly job

## Hard rules for assistants

1. **Simplicity above all.** Write code a human can read top-to-bottom and understand on first pass. Prefer fewer lines, fewer files, fewer layers, fewer abstractions — but not at the cost of clarity. Use intuitive, fully-spelled variable and function names; 1–4 word names are fine, cryptic abbreviations are not (`r`, `m`, `pct`, `tmp` force the reader to scroll up; `rankedMemory`, `memory`, `impactPercent` don't). Hard-code until duplication forces extraction. If a junior dev couldn't understand it in 30 seconds, it's wrong. **Debuggability > extensibility.**
2. **No `any`.** Strict TS everywhere. Fix types at the source, don't cast.
3. **No future-stage installs.** Only add deps the current stage needs.
4. **No abstractions for one call site.** Inline until the second use proves a pattern.
5. **No tutorial comments.** Comments explain *why*, not *what*.
6. **Local-first, no server.** Do not propose, recreate, or reintroduce a backend. All state lives in `<filesDir>/SQLite/lifeos.db`.
7. **Raw events go to ONE LLM call only: `runMemoryPass` inside `brain/nightly.ts`.** That pass receives yesterday's full event timeline (ts, kind, source, payload + the `_ctx` ambient block stamped at insert time — place, battery, charging, network, audio, weekday, etc.) so memories are precise and personalised. Every other LLM surface (chat, profile pass, smart-nudge) sees `behavior_profile` + rollups + memory context (via RAG) — never raw events.
8. **Schema is JS-owned.** Kotlin only does INSERT/SELECT against columns defined in `client/src/db/schema.ts`. When you change `schema.ts`, grep Kotlin for affected column names in the same commit.
9. **Cost cap is a hard wall.** Every LLM call checks today's `llm_calls.cost_usd` sum first.
10. **CLAUDE.md is read before editing and updated after.** Non-negotiable.
11. **Log enough to debug, not enough to drown.** `console.log`/`console.error` and `Log.i`/`Log.e`. No log frameworks.
12. **File size & line length.** Soft target: ≤400 LOC per JS/TS file, ≤100 chars/line.
    Single-responsibility logical units (one rebuilder, one engine, one schema) may exceed
    400 LOC if splitting them harms readability — keep cohesive logic together. Split when
    a file mixes responsibilities, not just to hit a number.
13. **Schema is at v3 (additive).** New columns: `daily_rollup.productivity_score`, `nudges_log.{next_day_score,baseline_score,score_delta,user_helpful}`. `user_helpful` is the user's manual thumbs feedback (1=▲, -1=▼, NULL=unrated), INDEPENDENT of the LLM-computed `score_delta`. New `EventKind` values: `inferred_activity`, `user_clarification`. Migrations use `addColumnIfMissing` (PRAGMA-guarded `ALTER TABLE`). Never DROP or RENAME.
14. **The LLM narrates facts, never invents them.** All correlation numbers passed to Sonnet must come from the `VERIFIED_FACTS` block built by `client/src/brain/verifiedFacts.ts`. Add a new correlation = add the SQL first; only then add a prompt slot for it.

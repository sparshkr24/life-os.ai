# CLAUDE.md — Project Root

> **Mandatory rule for every AI assistant working in this repo:**
> **Before modifying any file, read the `CLAUDE.md` in that file's parent folder (or nearest ancestor that has one).**
> **After modifying, update that `CLAUDE.md` to reflect new/changed/removed files, function signatures, and call flows.**
> If a folder has no `CLAUDE.md` and you add ≥2 source files there, create one.

## What This App Is

**AI Life OS** — a sideload-only personal Android assistant. Watches your phone behavior 24/7, extracts causal patterns, nudges you. **Local-first: no backend, no cloud DB.** One user. No Play Store. No iOS.

The core value: **automatic, causal, private behavioral understanding.** Your phone has been recording a detailed log of your behavior. This app reads it, learns why your good days happen, and tells you what's actually triggering your bad ones.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — ground truth. Do not contradict it without flagging.

## Folder Layout

| Folder | Role | Has CLAUDE.md |
|---|---|---|
| `client/` | React Native (Expo bare) — UI, local SQLite, native bridge, on-device brain | no (see `client/src/`) |
| `client/src/` | TypeScript modules used by `App.tsx` | yes |
| `client/src/db/` | Local SQLite schema, migrations, seed | covered by `client/src/CLAUDE.md` |
| `client/src/ingest/` | Post-write event cleanup pipeline | covered by `client/src/CLAUDE.md` |
| `client/src/bridge/` | TS wrapper around the Kotlin bridge | covered by `client/src/CLAUDE.md` |
| `client/src/screens/` | Tab screens (Today, Observe, Chat, Settings) + Profile/Places/AiModels overlays | covered by `client/src/CLAUDE.md` |
| `client/src/secure/` | Secure-store key helpers (legacy; new code uses `llm/keys.ts`) | covered by `client/src/CLAUDE.md` |
| `client/src/llm/` | Provider-agnostic LLM dispatch: router, key store, model catalogue, adapters | yes |
| `client/src/memory/` | Memory store: embeddings, RAG, scoring, maintenance | yes |
| `client/android/app/src/main/java/com/lifeos/` | Kotlin foreground service + bridge + boot receiver | yes |
| `docs/` | Architecture + design docs | no (prose only) |

`server/` does not exist and must not be recreated. All state lives in `<filesDir>/SQLite/lifeos.db`.

## Current Schema

Schema v7. Defined in `client/src/db/schema.ts`.

Key tables: `events`, `daily_rollup`, `monthly_rollup`, `behavior_profile`, `memories`, `todos`, `rules`, `nudges_log`, `llm_calls`, `places`, `app_categories`, `schema_meta`, `proactive_questions`.

Migrations are **additive only** via `addColumnIfMissing`. Never DROP or RENAME columns.

## What's Built

| Area | Status |
|---|---|
| Kotlin foreground service (24/7 collection) | Done |
| Boot receiver (survives reboots) | Done |
| UsageStats, ActivityRecognition, Sleep, Geofencing, Health Connect | Done |
| 15-min aggregator (clean → silence → rollup → score → rules → watchdog) | Done |
| Productivity score (deterministic SQL, 5-component) | Done |
| Rule engine (offline, 60s, cooldown-aware) | Done |
| Nightly 3-pass brain (memory → profile → nudge) | Done |
| Memory store (embeddings, reinforce/contradict, soft-archive) | Done |
| RAG retrieval (cosine, re-ranked by recency+impact+confidence) | Done |
| Self-learning loop (confidence updates + deterministic maintenance sweep) | Done |
| Pattern consolidation (abstract parent memories) | Done |
| Multi-provider LLM router (OpenAI, Anthropic, MiniMax, DeepSeek) | Done |
| AI-generated rules (nightly Pass 3, replaces per-tick smart-nudge) | Done |
| Chat (tool-calling, RAG-injected, read-only SQLite views) | Done |
| Proactive questions (3 detectors, interactive notifications, answer→memory) | Done |
| Places manager (GPS capture, radius editing, geofence sync) | Done |
| UI: Today, Observe, Chat, Settings, Profile, AiModels, Places | Done |
| **Backups + retention sweeps** | **Not started** |
| **Prediction accuracy dashboard** | **Not started** |
| **OEM autostart guide** | **Not started** |
| **RAG caching + batch embedding** | **Not started** |

## How to Run

No server. Two terminals:

```bash
# Terminal 1 — Metro
cd client && npx expo start --dev-client

# Terminal 2 — rebuild APK (only when Kotlin or AndroidManifest changes)
cd client/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
adb shell am force-stop com.lifeos
adb shell monkey -p com.lifeos -c android.intent.category.LAUNCHER 1
```

JS-only changes hot-reload via Metro.

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

## Tech Stack (locked)

- React Native (Expo bare) + TypeScript strict
- Kotlin (single bridge module, OS-API-only, no business logic)
- `expo-sqlite` (rollback journal, NOT WAL — Kotlin and JS share the same file)
- `expo-secure-store` for API keys
- `expo-notifications` (local only — no FCM)
- `expo-task-manager` + `expo-background-fetch` for 15-min worker
- `AlarmManager` (Kotlin) for nightly 3am kick
- AI: direct HTTPS `fetch` — no SDKs

## Hard Rules for Assistants

1. **Simplicity above all.** Write code a human can read top-to-bottom and understand on first pass. Prefer fewer lines, fewer files, fewer layers. Use intuitive, fully-spelled variable names — `rankedMemory` not `r`, `impactPercent` not `pct`. Hard-code until duplication forces extraction. **Debuggability > extensibility.**
2. **No `any`.** Strict TS everywhere. Fix types at the source.
3. **No deps beyond what's already installed** unless the feature explicitly requires one.
4. **No abstractions for one call site.** Inline until the second use proves a pattern.
5. **No tutorial comments.** Comments explain *why*, not *what*.
6. **Local-first, no server.** Do not propose, recreate, or reintroduce a backend.
7. **Raw events go to ONE LLM call only: `runMemoryPass` inside `brain/nightly.ts`.** Every other LLM surface sees `behavior_profile` + rollups + memory context (via RAG) — never raw events.
8. **Schema is JS-owned.** Kotlin only does INSERT/SELECT against columns defined in `client/src/db/schema.ts`. When you change `schema.ts`, grep Kotlin for affected column names.
9. **Cost cap is a hard wall.** Every LLM call checks today's `llm_calls.cost_usd` sum first.
10. **CLAUDE.md is read before editing and updated after.** Non-negotiable.
11. **Log enough to debug, not enough to drown.** `console.log`/`console.error` and `Log.i`/`Log.e`. No log frameworks.
12. **File size.** Soft target ≤400 LOC per JS/TS file. Split when a file mixes responsibilities, not just to hit a number. Single-responsibility units may exceed 400 LOC if splitting harms readability.
13. **Memories are append-only at the semantic level.** `summary`/`cause`/`effect`/`embedding` are immutable after `createMemory`. Soft-archive, never delete.
14. **The LLM narrates facts, never invents them.** All correlation numbers passed to any LLM must come from `client/src/brain/verifiedFacts.ts`. Add a new correlation = add the SQL first; only then add a prompt slot.

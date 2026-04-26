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
| `client/src/bridge/` | TS wrapper around the Kotlin bridge | covered by `client/src/CLAUDE.md` |
| `client/src/screens/` | Tab screens (Today, Events, Rollups, LLM, Nudges, Profile, Chat, Settings) | covered by `client/src/CLAUDE.md` |
| `client/src/secure/` | Secure-store keys + cost-cap helpers | covered by `client/src/CLAUDE.md` |
| `client/android/app/src/main/java/com/lifeos/` | Kotlin foreground service + bridge + boot receiver | yes |
| `docs/` | Architecture + design docs | no (prose only) |

`server/` was deleted on 2026-04-26 when the system went local-first. Do not recreate it.

## Stage tracker

| Stage | Status | What it delivers |
|---|---|---|
| 1 | **done** | Scaffold + schema v1 + CLAUDE.md tree |
| 2 | **done** | Foreground Service + boot receiver + bridge + custom APK build |
| 3a | **done** | UsageStatsManager collector writing `app_fg` events |
| 3b |  | ActivityRecognition + Sleep API |
| 3c |  | Geofencing + NotificationListener |
| 3d |  | Health Connect |
| **4** | **now** | **Schema v2 + observability tabs + secure-store key entry + chat shell** |
| 5 |  | Aggregator (WorkManager 15 min) — builds `daily_rollup` + monthly fold |
| 6 |  | Rule engine (60 s) + 3-level local notifications + `nudges_log` |
| 7 |  | Smart-nudge tick (gpt-4o-mini) + cost cap enforcement |
| 8 |  | Nightly Sonnet profile rebuild + AlarmManager + watchdog |
| 9 |  | Chat (Sonnet, tool-calling against local SQLite) |
| 10 |  | Backups + retention sweeps + OEM autostart helper |
| 11 |  | Today screen polish + behavior-aware todo reminders |

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

1. **Simplicity above all.** Clean, minimal, readable code beats clever code. Prefer fewer files, fewer layers, fewer abstractions. Hard-code until duplication forces extraction. If a junior dev couldn't understand it in 30 seconds, it's wrong. **Debuggability > extensibility.**
2. **No `any`.** Strict TS everywhere. Fix types at the source, don't cast.
3. **No future-stage installs.** Only add deps the current stage needs.
4. **No abstractions for one call site.** Inline until the second use proves a pattern.
5. **No tutorial comments.** Comments explain *why*, not *what*.
6. **Local-first, no server.** Do not propose, recreate, or reintroduce a backend. All state lives in `<filesDir>/SQLite/lifeos.db`.
7. **No raw events to LLMs.** LLM calls receive `behavior_profile` + rollups only.
8. **Schema is JS-owned.** Kotlin only does INSERT/SELECT against columns defined in `client/src/db/schema.ts`. When you change `schema.ts`, grep Kotlin for affected column names in the same commit.
9. **Cost cap is a hard wall.** Every LLM call checks today's `llm_calls.cost_usd` sum first.
10. **CLAUDE.md is read before editing and updated after.** Non-negotiable.
11. **Log enough to debug, not enough to drown.** `console.log`/`console.error` and `Log.i`/`Log.e`. No log frameworks.

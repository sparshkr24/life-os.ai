# CLAUDE.md — `client/src/`

## Responsibility

All TypeScript application code for the Expo app. UI shell lives in `client/App.tsx`; per-tab screens are in `screens/`. This folder owns: local SQLite (`db/`), the native-bridge wrapper (`bridge/`), read-only repos (`repos/`), secure-store helpers (`secure/`), and screen components (`screens/`).

## Files

| File | Purpose |
|---|---|
| `db/schema.ts` | Phone SQLite DDL (`PHONE_SCHEMA_SQL`), `SCHEMA_VERSION = 7`, row types: `EventRow`, `DailyRollupRow`, `MonthlyRollupRow`, `BehaviorProfileRow`, `RuleRow`, `NudgeRow`, `LlmCallRow`, `AppCategoryRow`, `PlaceRow`, `MemoryRow`, `MemoryType`, `ProactiveQuestionRow`, `ProactiveTriggerKind`, `ProactiveQuestionStatus`, `ProactiveExpectedKind`. `EventKind` includes `inferred_activity`, `user_clarification`, `ai_question`, `ai_question_response`. `LlmPurpose` includes `'embed'`, `'proactive_question'`. `nudges_log.user_helpful` (1=▲, -1=▼, NULL=unrated) is the user's manual feedback, independent of `score_delta`. |
| `db/seed.ts` | First-launch reference data: `SEED_APP_CATEGORIES`, `SEED_RULES`. |
| `db/repair.ts` | `attemptRepair()` — best-effort recovery when `SQLITE_CORRUPT` surfaces mid-session. Opens a fresh read-only connection, page-scans every table (LIMIT/OFFSET, skip bad pages), wipes the file, runs `migrate()` on fresh file, re-INSERTs each rescued row with `INSERT OR IGNORE`. Returns `RepairReport` with per-table `rescued`/`failed` counts. UI calls `LifeOsBridge.stopService()` before and `startService()` after. |
| `db/index.ts` | DB lifecycle: `getDb`, `withDb`, `migrate`, `describeDb`, `reopenDb`, `purgeShortAppFg`, plus internal `addColumnIfMissing`. **Journal mode = DELETE (not WAL):** both expo-sqlite (JS) and Kotlin's SQLiteDatabase open the same file; WAL's `-shm` shared-memory layouts conflict → corruption. Rollback journal + `PRAGMA busy_timeout = 5000` on both sides. Exports `isDbCorrupt()` / `clearDbCorrupt()`. `withDb(fn)` auto-recovers from stale-SharedRef NPEs by reopening once. |
| `ingest/cleanup.ts` | `cleanupRawEvents()` — JS-side post-write event cleanup. Runs at the start of every aggregator tick. Three rules: (1) drop `app_fg` rows for noise packages; (2) merge same-pkg `app_fg` sessions within 90s in the last 24h; (3) `purgeShortAppFg(1000)`. Idempotent, bounded. Also exports `WAKE_NOISE_PKGS`. |
| `aggregator/silence.ts` | `classifySilences(db, date, tz)` — finds gaps ≥60 min in the active-event stream and writes `events.kind='inferred_activity'` with `label` ∈ {sleep_or_rest, focused_work, workout, unknown}. Uses last `geo_enter`/`geo_exit` for place context. Idempotent per day; preserves rows with `user_confirmed: true`. |
| `aggregator/time.ts` | Shared time helpers: `localHour`, `localDateStr`, `localMonthStr`, `localDayStartMs`, `prevDate`, `nextDate`, `deviceTz`. Hermes `Intl.DateTimeFormat` based — no Luxon. |
| `aggregator/rollup.ts` | `rebuildDailyRollup(db, date, tz)` — daily-rollup orchestrator. UPSERTs `daily_rollup`. Owns the entire pipeline: `aggApps` (joins `app_categories`), `sumByCategory`, `aggByHour`, `aggLateNight`, `aggSleep`, `aggWakeFirstApp`, `aggPlaces`, `aggTransitions`, `aggSteps`, `aggActiveMinutes`, `aggTodos`, `aggNudges`, `aggSilences`. Exports `DailyRollupData`, `AppAgg`, `SleepAgg`. |
| `aggregator/monthlyFold.ts` | `foldMonth(db, month)` — rolls all `daily_rollup` rows for `'YYYY-MM'` into a `monthly_rollup` row (top apps, sleep p50/p90, place hours, totals, avg productivity score). Idempotent. |
| `aggregator/index.ts` | `runAggregatorTick()` — public entry point. Per tick: `cleanupRawEvents()` → `classifySilences(today, yest)` → `rebuildDailyRollup(today, yest)` → `computeProductivityScore(today, yest)` → `maybeRebuildPredictiveInsights(today)` (90-min throttle) → `expireOldProactiveQuestions()` + `maybeRunProactiveQuestion()` (≥6h throttle, ≤3/day, no-pending) → once-per-day `foldMonth(prevMonth)` → `runRulesOnceFromBackground()` → `maybeRunNightlyWatchdog()` (03:00 local + 20h cooldown). Records `last_aggregator_ts`. Returns `TickReport`. |
| `rules/notify.ts` | `expo-notifications` wrapper. Three Android channels (`lifeos.silent`/`headsup`/`modal`) match levels 1/2/3. `ensureNotificationChannels()` is idempotent; `fireNudgeNotification({level,title,body,data})` schedules a 1s-delayed local notification. |
| `rules/engine.ts` | `evaluateRules({tz?})` — pure rule evaluator. Loads enabled rules, parses `trigger`/`action` JSON, gates by `cooldown_min`, matches one of 3 trigger shapes, fires notification + INSERTs `nudges_log` row (`source='rule'`). |
| `rules/worker.ts` | Worker plumbing. `startRulesForegroundLoop()` — 60s `setInterval` + AppState `'active'` re-fire. `runRulesOnceFromBackground()` — called from the aggregator tick. `lastRulesTickTs()` powers the Today screen status row. |
| `aggregator/worker.ts` | Background-worker plumbing. `TaskManager.defineTask(AGGREGATOR_TASK)` runs at module import; `registerAggregatorTask()` registers a 15-min `expo-background-fetch` periodic task. `aggregatorTaskStatus()` powers the Today screen status row. |
| `brain/productivityScore.ts` | `computeProductivityScore(db, date)` — pure SQL UPDATE. 5-component weighted score in [0,1] (sleep 30, focus 25, wake 15, move 15, nudge 15). No LLM. |
| `brain/predictiveInsights.ts` | `maybeRebuildPredictiveInsights(db, date)` — pure-RAG (one embed call, no generation). Builds a query from today's rollup, retrieves top-5 similar memories, writes `data.predictive_insights` into the rollup. Throttled to once per ~90 min. |
| `brain/nudgeEffectiveness.ts` | `computeNudgeEffectiveness(db, forDate)` — nightly pre-pass. For each nudge with a `user_action` on `forDate`, fills `next_day_score` / `baseline_score` / `score_delta` on `nudges_log`. Pure SQL. |
| `brain/verifiedFacts.ts` | `buildVerifiedFacts(db)` — produces the `VERIFIED_FACTS` block for the nightly profile call. Only emits correlations where ≥5 data points exist on each side. New correlations = new SQL first, then a new prompt slot. |
| `brain/behaviorProfile.types.ts` | Type defs: `BehaviorProfileV3`, `CausalChain`, `DayAttribution`, `RuleSuggestion*`, `SilencePriors`, `SilenceCorrelation`. Used to validate nightly profile output before persistence. |
| `brain/nightly.ts` | `runNightlyRebuild()` + `maybeRunNightlyWatchdog()` + `lastNightlyTs()`. Pre-LLM idempotent SQL: finalise yesterday's score + 7-day `computeNudgeEffectiveness`. Then three sequential tool-calling sessions: **(1) `runMemoryPass`** — reads full raw event timeline (capped at 2000 events), extracts memories, verifies predictions, reinforces/contradicts/archives/consolidates, enriches `app_categories`. After loop: `runMemoryMaintenance()`. **(2) `runProfilePass`** — read-only, rebuilds `behavior_profile` JSON from rollups + memories + verified facts. **(3) `runNudgePass`** — refines AI-generated rules using effectiveness data + high-impact memories. Pass cascade: cap-skip in any pass blocks the next. |
| `brain/rawEvents.ts` | `loadRawEventsForDate(date) → RawEventTimeline`. Loads yesterday's events sorted ascending, formatted as `HH:MM:SS [kind] <payload-json>`. Cap at 2000 events; drops lowest-signal `app_fg` rows first when over cap. Used exclusively by `runMemoryPass`. |
| `bridge/lifeOsBridge.ts` | Typed wrapper around `NativeModules.LifeOsBridge` (Kotlin). Methods: `startService`, `hasUsageAccess`, `openUsageAccessSettings`, `getStats`, permission helpers (`hasActivityRecognitionPermission`, `requestActivityRecognitionPermission`, `hasLocationPermissions`, `requestForegroundLocation`, `requestBackgroundLocation`, `setGeofences`, `removeAllGeofences`, `isHealthConnectAvailable`, `openHealthConnect`), `getCurrentLocation()` (one-shot GPS fix via FusedLocationProvider). Exports `LifeOsPlace`. |
| `secure/keys.ts` | Legacy `expo-secure-store` helpers for backwards compat. New code uses `llm/keys.ts`, which auto-migrates legacy keys on first read. |
| `llm/` | Provider-agnostic LLM abstraction. See `llm/CLAUDE.md`. Public surface: `runChatTask` / `runEmbedTask` from `router.ts`; key management from `keys.ts`; task routing from `assignments.ts`; model catalogue from `models.ts`. |
| `repos/observability.ts` | Read-only queries powering Observe tabs: `listEvents`, `eventCounts`, `listDailyRollups`, `listMonthlyRollups`, `listLlmCalls`, `todayLlmSpendUsd`, `listNudges`, `getProfile`, `setNudgeUserHelpful`, `getLatestDailyRollup`, `recentProductivityScores`. All via `withDb`. |
| `theme.tsx` | 3 themes (`dark`/`light`/`modern`) with `ThemeTokens`. `monoFont = 'JetBrainsMono_400Regular'`. Persisted via `expo-secure-store` under `UI_THEME`. |
| `toast.tsx` | `ToastProvider` + `useToast()`. Non-blocking toast surface (`info`/`error`/`ok`). Wrapped around `<Shell>` in `App.tsx`. |
| `screens/index.ts` | Barrel re-exporting all screen components and `TabId`. |
| `screens/shared.tsx` | Shared helpers + styles: `fmtTime`, `fmtDur`, `parseEvent`, `prettyPkg`, `safeJson`, `truncate`, `useAsyncRunner`, `makeStyles(theme)`, `NAV_CLEAR`, `TabId`. |
| `screens/widgets.tsx` | Reusable UI atoms: `AppIcon` (brand glyph with letter fallback), `ScoreBar`, `Sparkline`, `SectionHeader`, `StatusDot`, `PressableScale`, `kindTint`. |
| `screens/Today.tsx` | Hero screen. Productivity score, 7-day sparkline, sleep card, top-3 apps, today's nudges with thumbs ▲/▼, pending proactive question card. System debug card (collapsible). |
| `screens/Observability.tsx` | 4-tab segmented strip (Events / Rollups / LLM / Nudges). |
| `screens/EventsTable.tsx` | Infinite-scroll FlatList of raw events. Offset-based pagination with Set dedup. Calls `reopenDb()` on initial load. |
| `screens/RollupsScreen.tsx` | Daily/Monthly rollup dashboard. Compact list tiles; tap opens `RollupDetailSheet` (bottom sheet, slide-up animation, drag-to-dismiss). Hero score with deltas, sleep, steps, top apps, time-split stacked bar, predictive insights. |
| `screens/LlmTable.tsx` | LLM call log filtered by purpose; today's spend; per-row request/response/error expander. |
| `screens/NudgesTable.tsx` | Nudges feed. Filter chips (All / Rule / Helpful / Annoying), grouped by day. Each card: level-tinted dot, message, `score_delta` label, thumbs ▲/▼, expandable reasoning. |
| `screens/Chat.tsx` | Chat screen. `KeyboardAvoidingView` + bubble list. Calls `runChatTurn(history)`; surfaces `skipped` states as toasts; shows today's LLM spend in footer. |
| `brain/chat.ts` | `runChatTurn(history)` — tool-calling loop (max 4 turns). RAG-injected context via `buildChatSystemPrompt`. Cost = sum of per-loop usage. |
| `brain/tools.ts` | Single registry of every LLM-callable tool. Scoped via `ToolScope = 'chat' \| 'nightly_memory' \| 'nightly_profile' \| 'nightly_nudge'`. Read tools available to all scopes. Write tools restricted by scope. Chat writes: `create_todo`, `update_todo`, `propose_rule`, `mark_memory_archived`, `add_geofence_place`, `mark_pattern_memory`, `ask_user_question`. Memory-pass writes: `create_memory`, `verify_memory`, `reinforce_memory`, `contradict_memory`, `consolidate_memories`, `set_app_category`. Nudge-pass writes: `list_rules`, `get_rule_effectiveness`, `create_rule`, `update_rule`, `disable_rule`. |
| `memory/embed.ts` | Wraps `runEmbedTask`. Returns `{vector, model, inTokens, costUsd}` or `null`. Re-exports `EMBED_DIM=1536`, `EMBED_MODEL`, `cosineSim`. |
| `memory/store.ts` | CRUD + scoring. `createMemory` embeds + inserts (returns null on embed failure — never persists without embedding). `listActiveMemories`, `getMemoryById`, `touchMemories`, `reinforceMemory` (+0.05 confidence), `contradictMemory` (−0.10 confidence), `archiveMemory`, `recordPredictionOutcome`, `getMemoryStats`. `computeEffectiveScore(Memory)` = impact + reinforcement·0.3·impact − contradiction·0.5·sign(impact) with exponential recency decay after 7 days idle. |
| `memory/maintenance.ts` | `runMemoryMaintenance() → MaintenanceReport` — deterministic SQL sweep after the nightly memory pass. Soft-archives in 4 buckets: failed predictions never reinforced, consistently disproven (contradiction≥3 AND ≥2×reinforcement), confidence<0.10 with no reinforcement, consolidation children whose parent is ≥14d old. Idempotent. |
| `memory/rag.ts` | `retrieveContext(RagQuery) → RagResult`. Embeds query, scans active memories, re-ranks by `0.5·sim + 0.2·recency + 0.15·|impact| + 0.15·confidence` (+ tag-overlap bonus), touches top-k. Returns `{embedded:false, memories:[]}` on embed failure. Builds a markdown `contextBlock` for prompt injection. |
| `screens/Profile.tsx` | Behavior profile viewer. Reads `behavior_profile.data` and renders: identity blurb + confidence, observed habits, verified correlations, causal chains, suggested rules. Reachable from Settings. |
| `screens/Settings.tsx` | Sectioned layout. Sections: PROFILE entry, THEME, TRACKING PERMISSIONS, PLACES & GEOFENCES, AI MODELS, COST & LIMITS (spend bar), SYSTEM DEBUG. |
| `screens/AiModels.tsx` | Provider key + task routing screen. Two sections: (1) Providers — key input + status dot per provider. (2) Routing — per-task model radio selection. Embedding model is fixed and not user-assignable. |
| `screens/PermissionsCard.tsx` | Five permission rows (usage / activity / fg loc / bg loc / Health Connect) with status dots + one-tap actions. Re-polls 500ms after every action. |
| `screens/Places.tsx` | Geofenced-location manager. Capture current GPS, name it, save. Tap to edit radius (chips 25/50/100/200 + custom 15–500m) or delete. |
| `repos/places.ts` | `listPlaces`, `addPlace`, `updatePlaceRadius`, `deletePlace`, `syncGeofences()`. Every mutation re-pushes the full `places` table to the bridge. `PLACES_DEFAULT_RADIUS_M = 25`. |
| `brain/proactive.ts` | `maybeRunProactiveQuestion(db, now, tz)` — runs at end of every aggregator tick. Throttle (≥6h), daily cap (3), no-pending check, 3 detectors (`long_dwell_unknown` / `weekend_late_night` / `no_phone_usage`). RAG context fetched; LLM call drafts question; on accept: INSERT `proactive_questions` + `events.kind='ai_question'` + interactive notification. Also exports `expireOldProactiveQuestions` and `applyProactiveAnswer`. |
| `brain/proactiveResponse.ts` | Notification action listener wired in `App.tsx`. Forwards Yes/No taps to `applyProactiveAnswer`. Other/Reply/Open actions open the app — the in-app card finishes the flow. |
| `rules/proactiveNotify.ts` | Three notification categories (`lifeos.proactive.yesno` / `…place` / `…freetext`). `fireProactiveQuestionNotification` + `dismissProactiveNotification`. |
| `components/PendingQuestionCard.tsx` | Self-fetching banner at the top of Today. Polls `proactive_questions WHERE status='pending'` every 10s. Renders Yes/No, place chips, or multiline reply based on `expected_kind`. Submit calls `applyProactiveAnswer`. |

## Schema bump policy

1. Bump `SCHEMA_VERSION` in `db/schema.ts`.
2. Update affected row types in same file.
3. `grep` Kotlin for any column you renamed/dropped.
4. On phone: `adb uninstall com.lifeos` then reinstall — wipes the old DB.

## LLM cost cap

Hard wall: $0.30/day. Every LLM call must:
1. `SELECT SUM(cost_usd) FROM llm_calls WHERE ts >= start_of_day` first.
2. Compare against `loadSnapshot().dailyCapUsd`.
3. Refuse and write a row with `ok=0, error='cap_exceeded'` if over.

## App boot call flow

```
App.tsx mount
  → migrate()                     // db/index.ts — schema + backfills
  → if android: LifeOsBridge.hasUsageAccess() / startService()
  → registerAggregatorTask()
  → startRulesForegroundLoop()
  → render TabShell

User taps tab
  → screens/index.tsx <Tab>Screen
      → repos/observability.ts query via withDb
      → render
```

## Top-level tabs (locked)

Bottom nav: **Today / Observe / Chat / Settings**. No other top-level tabs.
Profile, Places, AiModels are overlays reachable from Settings.

## Hard rules (inherited from root CLAUDE.md)

- No `any`. No tutorial comments. No abstractions for one call site.
- Local-first: never reintroduce a server.
- Raw events never go to an LLM other than `runMemoryPass`.
- Schema is JS-owned. Kotlin only INSERTs against columns defined here.

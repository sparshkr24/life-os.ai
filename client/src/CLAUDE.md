# CLAUDE.md — `client/src/`

## Responsibility

All TypeScript application code for the Expo app. UI shell lives in
`client/App.tsx`; per-tab screens are in `screens/`. This folder owns:
local SQLite (`db/`), the native-bridge wrapper (`bridge/`), read-only repos
(`repos/`), secure-store helpers (`secure/`), and screen components (`screens/`).

Stage 4 lands schema v2 + observability tabs. Aggregation, rule engine, brain,
and chat wiring arrive in later stages.

## Files

| File | Purpose |
|---|---|
| `db/schema.ts` | Phone SQLite DDL (`PHONE_SCHEMA_SQL`), `SCHEMA_VERSION = 3`, row types: `EventRow`, `DailyRollupRow` (now incl. `productivity_score`), `MonthlyRollupRow`, `BehaviorProfileRow`, `RuleRow`, `NudgeRow` (now incl. `next_day_score`/`baseline_score`/`score_delta`), `LlmCallRow`, `AppCategoryRow`, `PlaceRow`. `EventKind` includes v3 values `inferred_activity` and `user_clarification`. |
| `db/seed.ts` | First-launch reference data: `SEED_APP_CATEGORIES`, `SEED_RULES`. |
| `db/index.ts` | DB lifecycle: `getDb`, `withDb`, `migrate`, `describeDb`, `reopenDb`, `purgeShortAppFg`, plus internal `addColumnIfMissing` for v3 additive columns. Single open connection (`useNewConnection: true` to bypass the native zombie cache), WAL on. `withDb(fn)` is the canonical entry point for queries — auto-recovers from stale-SharedRef NPEs by reopening once. `migrate()` runs `purgeShortAppFg(db, 1000)` on every boot to delete `app_fg` rows with `duration_ms < 1 s` (sub-activity transition noise). The Stage-5 aggregator MUST also call `purgeShortAppFg` before building any rollup so rollups never see this junk. |
| `aggregator/silence.ts` | `classifySilences(db, date, tz)` — finds gaps ≥60 min in the active-event stream and writes `events.kind='inferred_activity'` with `label` ∈ {sleep_or_rest, focused_work, workout, unknown}. Uses last `geo_enter`/`geo_exit` for place context. Idempotent per day; preserves rows with `user_confirmed: true`. Will be called from the Stage-5 aggregator worker every 15 min for today + yesterday. |
| `brain/productivityScore.ts` | `computeProductivityScore(db, date)` — pure SQL UPDATE. 5-component weighted score in [0,1] (sleep 30, focus 25, wake 15, move 15, nudge 15). No LLM. Called by aggregator after every `daily_rollup` rebuild. |
| `brain/nudgeEffectiveness.ts` | `computeNudgeEffectiveness(db, forDate)` — nightly job step. For each nudge with a `user_action` on `forDate`, fills `next_day_score` / `baseline_score` (7-day median) / `score_delta` on `nudges_log`. Pure SQL, no LLM. |
| `brain/verifiedFacts.ts` | `buildVerifiedFacts(db)` — produces the `VERIFIED_FACTS` block for the nightly Sonnet call. Currently emits `low_phone_night` correlation when ≥5 days exist on each side; null otherwise. Add new correlations as new fns and append to the array. |
| `brain/behaviorProfile.types.ts` | v3 type defs: `BehaviorProfileV3`, `CausalChain`, `DayAttribution`, `RuleSuggestion*`, `SilencePriors`, `SilenceCorrelation`. Used to validate Sonnet output before persistence. |
| `brain/nightly.prompt.ts` | `NIGHTLY_SYSTEM_PROMPT` constant + `buildNightlyUserPrompt({prior, days, months, verifiedFacts})`. The Stage-8 runner imports these — no other file holds nightly prompt text. |
| `bridge/lifeOsBridge.ts` | Typed wrapper around `NativeModules.LifeOsBridge` (Kotlin). Methods: `startService`, `hasUsageAccess`, `openUsageAccessSettings`, `getStats`, plus Stage 3b/3c/3d permission helpers (`hasActivityRecognitionPermission`, `requestActivityRecognitionPermission`, `hasLocationPermissions`, `requestForegroundLocation`, `requestBackgroundLocation`, `setGeofences`, `removeAllGeofences`, `hasNotificationListenerAccess`, `openNotificationListenerSettings`, `isHealthConnectAvailable`, `openHealthConnect`). Exports `LifeOsPlace`. |
| `secure/keys.ts` | `expo-secure-store` helpers: `loadSnapshot`, `setAnthropicKey`, `setOpenAiKey`, `setDailyCap`, `getAnthropicKey`, `getOpenAiKey`. Default cap = $0.30/day. Snapshot only exposes the last 4 chars of stored keys. |
| `repos/observability.ts` | Read-only queries powering tabs: `listEvents` (default limit 1000), `eventCounts`, `eventTotalCount`, `listDailyRollups`, `listMonthlyRollups`, `listLlmCalls`, `todayLlmSpendUsd`, `listNudges`, `getProfile`. All routed through `withDb` for stale-ref safety. |
| `theme.tsx` | 3 themes (`dark` / `light` / `modern`) with extended `ThemeTokens` (primary/secondary/tertiary `accent`/`accent2`/`accent3`, per-event-kind `kindColors`, segmented-strip tokens `segBg`/`segActiveBg`/`segText`/`segActiveText`, `glass*`/`headerGrad*`). `monoFont = 'JetBrainsMono_400Regular'` (loaded in `App.tsx` via `@expo-google-fonts/jetbrains-mono`). Persisted via `expo-secure-store` under `UI_THEME`. |
| `toast.tsx` | `ToastProvider` + `useToast()`. Tiny non-blocking toast surface (`info`/`error`/`ok`). Wrapped around `<Shell>` in `App.tsx`. Used by every async repo call to surface failures so the UI never appears silently broken. |
| `screens/index.ts` | Barrel re-exporting `TodayScreen`, `ObservabilityScreen`, `ChatScreen`, `SettingsScreen`, `TabId`. |
| `screens/shared.tsx` | Helpers + styles + `ActionButton` shared by every screen: `fmtTime/fmtTimeShort/fmtClock`, `fmtDur`, `parseEvent`, `prettyPkg`, `safeJson`, `truncate`, `useAsyncRunner` (try/catch + toast + loading), `makeStyles(theme)` factory, `NAV_CLEAR`, type `TabId`. |
| `screens/Today.tsx` | `TodayScreen` — counts, collector-service health, LLM spend, profile summary. |
| `screens/Observability.tsx` | `ObservabilityScreen` — 4-tab segmented strip (Events / Rollups / LLM / Nudges). |
| `screens/EventsTable.tsx` | Infinite-scroll FlatList. Uses `offsetRef` + Set-based dedup; calls `reopenDb()` on initial load to dodge stale WAL snapshots from the Kotlin writer; defers initial fetch via `InteractionManager.runAfterInteractions`. |
| `screens/RollupsScreen.tsx` | Daily+monthly rollup browser with inner `All/Daily/Monthly` segmented filter, search, date range, and asc/desc sort. |
| `screens/LlmTable.tsx` | LLM-calls log filtered by purpose; shows today's spend; per-row request/response/error expander. |
| `screens/NudgesTable.tsx` | Nudges log (rule + smart sources). |
| `screens/Chat.tsx` | Shell only — Stage 9 wires Sonnet with tools. |
| `screens/Settings.tsx` | Theme selector, `<PermissionsCard />`, API keys, daily cap, profile summary with `ProfileSection`. |
| `screens/PermissionsCard.tsx` | Stage 3b/3c/3d native-permissions surface inside Settings. Six rows (usage / activity recognition / fg loc / bg loc / notif listener / Health Connect) with status dots + one-tap grant or open-settings actions; re-polls 500 ms after every action and on mount. |

## Schema bump policy

When `SCHEMA_VERSION` changes:
1. Bump in `db/schema.ts`.
2. Update affected row types in same file.
3. `grep` Kotlin for any column you renamed/dropped (`client/android/app/src/main/java/com/lifeos`).
4. On phone: `adb uninstall com.lifeos` then reinstall — wipes the v(N-1) DB.

## LLM cost cap

Hard wall: $0.30/day default. Every LLM call (Stages 7–9) **must**:
1. `SELECT SUM(cost_usd) FROM llm_calls WHERE ts >= start_of_day` first.
2. Compare against `loadSnapshot().dailyCapUsd`.
3. Refuse and write a row with `ok=0, error='cap_exceeded'` if over.

## Call flow — app boot (Stage 4)

```
App.tsx mount
  → migrate()                          // db/index.ts
      → getDb() (lifeos.db, WAL)
      → exec all PHONE_SCHEMA_SQL stmts in tx
      → if schema_meta.version < 2: seedReference() + bump
  → if android: LifeOsBridge.hasUsageAccess() / startService()
  → render TabShell

User taps tab
  → App.tsx bottom-nav switches `tab` state
  → screens/index.tsx <Tab>Screen
      → repos/observability.ts query
      → render rows (tables in Observability)
```

## Top-level tabs (locked)

Bottom nav: **Today / Observe / Chat / Settings**. No other top-level tabs.
Deeper views live inside one of those four (e.g. Profile is a section inside Settings; raw event/rollup/llm/nudge tables are sub-sections of Observe).

## Hard rules (inherited from root CLAUDE.md)

- No `any`. No tutorial comments. No abstractions for one call site.
- Local-first: never reintroduce a server.
- Raw events never go to an LLM. Only `behavior_profile` + rollups.
- Schema is JS-owned. Kotlin only INSERTs against columns defined here.

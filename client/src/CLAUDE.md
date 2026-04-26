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
| `db/schema.ts` | Phone SQLite DDL (`PHONE_SCHEMA_SQL`), `SCHEMA_VERSION = 2`, row types: `EventRow`, `DailyRollupRow`, `MonthlyRollupRow`, `BehaviorProfileRow`, `RuleRow`, `NudgeRow`, `LlmCallRow`, `AppCategoryRow`, `PlaceRow`. |
| `db/seed.ts` | First-launch reference data: `SEED_APP_CATEGORIES`, `SEED_RULES`. |
| `db/index.ts` | DB lifecycle: `getDb`, `migrate`, `describeDb`. Single open connection, WAL on. |
| `bridge/lifeOsBridge.ts` | Typed wrapper around `NativeModules.LifeOsBridge` (Kotlin). Methods: `startService`, `hasUsageAccess`, `openUsageAccessSettings`, `getStats`. |
| `secure/keys.ts` | `expo-secure-store` helpers: `loadSnapshot`, `setAnthropicKey`, `setOpenAiKey`, `setDailyCap`, `getAnthropicKey`, `getOpenAiKey`. Default cap = $0.30/day. Snapshot only exposes the last 4 chars of stored keys. |
| `repos/observability.ts` | Read-only queries powering tabs: `listEvents`, `eventCounts`, `listDailyRollups`, `listMonthlyRollups`, `listLlmCalls`, `todayLlmSpendUsd`, `listNudges`, `getProfile`. |
| `theme.tsx` | 3 themes (`dark` / `light` / `modern`) with token interface `ThemeTokens` (includes `glassBg`/`glassBorder`/`glassShadow`/`headerGradTop`/`headerGradBottom` for the floating nav + layered header). Exports `ThemeProvider`, `useTheme()`, `THEMES`, `THEME_NAMES`. Active theme persisted via `expo-secure-store` under `UI_THEME` (non-secret reuse — avoids adding AsyncStorage dep). |
| `toast.tsx` | `ToastProvider` + `useToast()`. Tiny non-blocking toast surface (`info`/`error`/`ok`). Wrapped around `<Shell>` in `App.tsx`. Used by every async repo call to surface failures so the UI never appears silently broken. |
| `screens/index.tsx` | 4 top-level screens: `TodayScreen`, `ObservabilityScreen`, `ChatScreen`, `SettingsScreen`. `ObservabilityScreen` holds an internal segmented control over Events / Daily / Monthly / LLM / Nudges sub-tables. Profile summary lives inside Settings. Exports `TabId`, plus `makeStyles(theme)` factory. Every fetch uses `useAsyncRunner()` (try/catch + toast + loading flag) and a `reqIdRef` to discard stale responses when filters change. |

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

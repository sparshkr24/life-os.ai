# CLAUDE.md — `docs/`

> This document is the **product + engineering plan** for the next phase of AI Life OS.
> Read it before touching the collector, ingest, or rollup layers.
> When the plan is implemented, mark sections **DONE** rather than deleting them.
>
> Companion docs in this folder:
> - [ARCHITECTURE.md](ARCHITECTURE.md) — system architecture (ground truth, do not contradict)
> - [docs_LIFEOS_ARCHITECTURE_EVOLUTION.md](docs_LIFEOS_ARCHITECTURE_EVOLUTION.md) — how the design evolved

---

## 0. Why this doc exists

The pitch of AI Life OS is *"the first app that reads your phone's behavioral log and tells you why your good days happen."* For that to be true, the **raw event log must be accurate enough to reconstruct your day as a timeline a human would recognise**. Right now it isn't — there are blind spots that make the downstream brain narrate inaccurate things, and accuracy is the entire moat.

This doc is the locked-in plan to fix the source-of-truth layer **without** ballooning LLM cost or adding intrusive permissions.

---

## 1. The MVP Goal: an Always-On Life Logger

### The bar

The app should be able to reconstruct the user's day as a human-readable timeline, with **zero user input** beyond initial permission grants and (occasionally) one-tap clarifications.

### Target output (the example we're building toward)

```
8:14am  — woke (screen on, unplugged)
8:17am  — opened Instagram for 22 min
9:05am  — arrived at [Costa Coffee, Sector 18] (stayed 47 min)
10:03am — at Office (arrived)
1:45pm  — walked 2,400 steps (14 min walk, bt headphones)
6:31pm  — left Office
7:12pm  — arrived at [Spar Supermarket, Sector 22] (stayed 11 min)
10:02pm — screen off (bedtime)
         sleep: 6h44m
```

Every line above must be derivable from on-device signals. Where this doc's plan lands, every line *is* derivable.

### What "good enough" means

- 90%+ of "stays" of >10 minutes correctly logged with a label (named place, geocoded POI, or "unknown — confirm?").
- Wake and bedtime detected within ±10 minutes of reality.
- App sessions accurate to ±60 seconds per session.
- < 50 raw events per day reach the LLM (cost ceiling). Other high-frequency signals are aggregated locally first.

---

## 2. Real-World Use Cases (the product vision in detail)

These are not "future ideas" — they are the use cases the architecture must support. Every implementation choice is graded against these.

### 2.1 Friday Night Bike Ride

**Pattern**: User rides their motorcycle every Friday night, ~9–11pm, ~2 hours, returns home.

**Signals that prove it**:
- `activity` events: STILL/exit → IN_VEHICLE/enter at ~9pm, transitions back to STILL/enter ~11pm.
- `geo_exit(home)` at 9pm, `geo_enter(home)` at 11pm.
- No `app_fg` activity (or only minimal — nav app, music) during the IN_VEHICLE window.
- `_ctx.audio = bt` if helmet headset is paired.

**What the app should do**:
1. After the second occurrence (week 2), pattern detector flags "Friday 9–11pm IN_VEHICLE recurrence".
2. Proactive question fires once: *"Looks like you've travelled by vehicle on Friday nights for two weeks now (around 9–11pm, ~50 km from home). What's this?"*
3. User answers "motorcycle ride" → memory created with `cause: friday_night_routine`, `tags: [motorcycle, recreation]`.
4. All future Friday-night IN_VEHICLE events get auto-tagged via that memory's pattern matcher.
5. If user **skips** a Friday: brain detects deviation. Next morning's score card can show: *"You skipped the ride last night. Sleep was 22 minutes shorter than your average post-ride Saturday."*

### 2.2 Saturday Liquor Shop / Restaurant Visit

**Pattern**: User stops at a liquor store every Saturday around 8pm for ~10 minutes.

**Signals**:
- `activity` STILL/enter at unknown coordinates (place_id=null).
- Dwell ≥ 15 min threshold may be too high here (10-min visits common). See §6 for tiered thresholds.

**What the app should do**:
1. Dwell 10+ min at unknown coords → reverse geocode (Nominatim).
2. Result: `name=Wine Cellar`, `shop=alcohol`, `lat/lng/category` stored.
3. `place_visit` event written with type `shop_alcohol`.
4. After 3 Saturdays, brain identifies pattern. Next Sunday:
   - *"You visited a liquor store yesterday, similar to last 3 Saturdays. On those Sundays you slept 6h12m on average vs. your 7h18m baseline."*
   - No moralising. Just data.

### 2.3 Restaurant / Café Recognition

**Pattern**: User goes to a café Tuesday/Thursday mornings before work.

**What the app should do**:
- Detect 30+ min dwell at unknown coords between 8–10am on weekdays.
- Reverse geocode → `amenity=cafe`, `cuisine=*`, `name=*`.
- Auto-create `place_visit` events with `kind=cafe`.
- After 4 occurrences: pattern memory *"morning cafe before office"*. The app can then ask: *"Want me to call this 'Morning Cafe'?"* and create a real geofence — moving the place from "auto-detected" to "named place" status.

### 2.4 Doom-Scroll Entry Detection

**Pattern**: User opens email → closes → opens Reddit → 45 minutes evaporate.

**Signals**: rapid `app_fg` ping-pong followed by long single-app session on a known time-sink.

**What the app should do**: *(downstream of the timeline — already partially supported via app_categories. Mentioned here for completeness.)*

### 2.5 Compulsive Phone Checking

**Pattern**: User unlocks phone, looks at clock or notification, locks again. Many times per day.

**Signals**: `screen_on` event with NO subsequent `app_fg` event within 5 seconds, then `screen_off`.

**What the app should do**: count these per day → "phantom checks". Surface in Today: *"You glanced at your phone 47 times today without opening anything."*

### 2.6 Workout Detection

**Pattern**: User goes to a known gym geofence, or walks 20+ min with bt headphones connected.

**Signals**: `geo_enter(gym)` OR (WALKING/RUNNING for 20+ min with `_ctx.audio = bt`).

**What the app should do**: classify as workout. Track frequency. Detect drift: *"Gym visits dropped from 4×/week to 1×/week over the last month."*

---

## 3. Current Event Inventory (audit)

| Kind | Source | Frequency | LLM-relevant | Status |
|---|---|---|---|---|
| `app_fg` | UsageStatsManager | 60s poll | Yes | Working |
| `activity` | ActivityRecognition | event-driven (~10–30 min lag) | Yes | Working |
| `sleep` | Sleep API | 1/day, ~12 h after waking | Yes | Working but late |
| `geo_enter` / `geo_exit` | Geofence API | event-driven | Yes | Working (only for user-defined places) |
| `steps` | Health Connect + sensor fallback | every 5 min | Aggregate-only | Working |
| `heart_rate` | Health Connect | every 5 min | Aggregate-only | Collected but unused |
| `inferred_activity` | aggregator post-hoc | every 15 min | Yes | Working |
| `ai_question` / `ai_question_response` | Proactive detector | ≤1/24 h | Yes | Working |

**Ambient `_ctx`** stamped on every event: `place_id`, `batt`, `charging`, `net`, `audio`.

---

## 4. New Events to Add (this plan)

### 4.1 `screen_on` / `screen_off` — **MUST-ADD, zero permissions**

**Why critical**:
- Real wake time (Sleep API fires 12h late and is unreliable).
- Real bedtime (`screen_off` with no subsequent `screen_on` for >2h → bedtime).
- Compulsive-check count (`screen_on` without `app_fg` within 5s).

**Source**: `ACTION_SCREEN_ON` / `ACTION_SCREEN_OFF` broadcasts. These cannot be received via manifest declaration on modern Android — the foreground service must register a `BroadcastReceiver` at runtime in `onCreate` and unregister in `onDestroy`.

**Frequency**: 50–250/day for heavy users.

**Payload**: `{ "source": "system_broadcast" }` — all info is in `kind` + `ts`.

**LLM strategy** (critical — see §5): these events are **aggregate-only**. They are written to `events` for the rollup pipeline, but **excluded from the Pass-1 raw-event read** in `brain/nightly.ts`. The rollup distills them into:
- `wake_ts` (first `screen_on` after a long off-period)
- `bedtime_ts` (last `screen_on` before a long off-period that ends at wake_ts)
- `screen_on_count` (total/day, useful as fidget proxy)
- `phantom_check_count` (screen_on with no app_fg within 5s)

Only those numeric summaries reach the LLM. This is the key cost-control discipline: **high-frequency raw events must always be summarised before reaching the brain**.

### 4.2 `place_visit` — **MUST-ADD, no new permissions**

The cornerstone of the timeline. One event per visit to a place — known or auto-discovered.

**Source**: see §6 (the trigger pipeline).

**Payload**:
```json
{
  "place_id": "home" | null,
  "lat": 28.4595,
  "lng": 77.0266,
  "accuracy_m": 18,
  "arrival_ts": 1234567890000,
  "departure_ts": 1234567990000,
  "duration_ms": 100000,
  "name": "Costa Coffee",
  "category": "cafe",
  "subcategory": "coffee",
  "address": "Sector 18, Noida",
  "source": "geofence" | "auto_geocode" | "user_confirmed",
  "geocode_provider": "nominatim",
  "confidence": 0.82
}
```

**Frequency**: 5–15/day typical.

**LLM-relevant**: yes — these are the gold events. The exact data we want patterns extracted from.

### 4.3 `wake` — **DERIVED, free, MUST-ADD**

Not a new sensor. Computed by the aggregator from the `screen_on` + `charging` + sleep cluster:

> The first `screen_on` event of a calendar morning that is preceded by ≥4 h of no screen activity, AND followed by a transition to `charging=false` (unplugging) within ±10 min.

Written as a synthetic event with `source: "derived"`. Costs nothing in collection. Provides a real-time wake event the brain can correlate with first-app-after-wake patterns.

### 4.4 What we are NOT adding (and why)

| Not adding | Reason |
|---|---|
| Power connected/disconnected events | `_ctx.charging` already captures this passively. A discrete event isn't worth the table churn. |
| DND / Focus mode in `_ctx` | User explicitly deprioritised. Re-evaluate when we have rule-engine signals. |
| NotificationListenerService | Volume too high (200–500/day). Token cost > insight value at MVP. Re-evaluate with a separate `notif_summary` table that's daily-aggregated only — but not yet. |
| READ_PHONE_STATE (call detection) | `app_fg` on dialer apps is good enough for V1. Real call duration / direction needs runtime permission and a `PhoneStateListener`. Defer. |
| Storage / photos | Privacy-sensitive, would not be granted, irrelevant to behavioral patterns. |
| Mic / voice input | Same. |
| Reading message content (WhatsApp, Insta, etc.) | Same. |

---

## 5. The LLM Cost Discipline (event class system)

Events fall into **two classes**. This distinction must be enforced at the read site.

### 5.1 Class A — "Brain-fed" events

Read directly by `runMemoryPass()` in `client/src/brain/nightly.ts`. Low volume, high semantic value.

- `app_fg` (after dedup; ≤ 200/day typical)
- `activity` (~30/day)
- `sleep` (1/day)
- `geo_enter` / `geo_exit` (a few/day)
- `place_visit` (5–15/day)
- `wake` (1/day)
- `ai_question` / `ai_question_response` (≤1/day)

**Cap**: targeting < 300 events/day reaching Pass 1. Current spend at this volume: $0.05–0.21/night.

### 5.2 Class B — "Aggregate-only" events

Written to `events` (so the aggregator can derive things from them) but **excluded by `kind` from the Pass-1 query**. The brain only ever sees the numeric summaries computed from these in `daily_rollup`.

- `screen_on` / `screen_off` (50–250/day)
- `steps` records (12–40/day; aggregator just sums)
- `heart_rate` records (when present)
- (Future) `notif_event` if NotificationListener ever ships

**Implementation rule**: every Class B event kind goes into a constant `BRAIN_EXCLUDED_KINDS` exported from `client/src/brain/rawEvents.ts`. The Pass-1 SQL `WHERE kind NOT IN (...)`. This is a one-line guard but it's the dam holding back token-cost flooding.

### 5.3 Retention policy by class

| Class | Retention | Rationale |
|---|---|---|
| Class A | 30 days | Brain re-reads them up to 30 days back for verification |
| Class B | 7 days | Once aggregated into `daily_rollup`, the raw rows have no further value |

A new field is **not** needed in `events`. A retention sweep keyed on `kind` is sufficient.

---

## 6. The Auto-Geocoded Place Visit Pipeline (the real meat)

This section answers: *how do we know the user has been at a place ≥X minutes, and how do we identify the place?*

### 6.1 The trigger

**Single source of truth: ActivityRecognition `STILL/enter` events, combined with geofence state.**

A "candidate dwell" begins when ALL of the following are true:

1. `ActivityTransitionResult` reports `STILL` + `ENTER`.
2. `PhoneState.placeId` is `null` (i.e., the user is **outside all configured geofences**). If they're at home/office/gym, we already know the place — no geocode needed.
3. No competing transition event has fired since.

**Why STILL**: the OS already runs ActivityRecognition; we're free-riding. STILL/enter is the Android-blessed signal for "user has stopped". Lag is ~1–3 minutes typical, which is acceptable because we're not in a hurry — we wait 15 min anyway.

### 6.2 The dwell timer

When a candidate dwell starts, we set a `Handler.postDelayed(geocodeRunnable, DWELL_THRESHOLD_MS)`.

**Cancellation triggers** (any of these cancels the timer):
- `STILL/exit` (user started moving)
- `WALKING/RUNNING/IN_VEHICLE/ON_BICYCLE/enter`
- `geo_enter` for any configured place (user crossed into a known geofence)
- Service stop / restart

If the timer fires uncancelled, we have confirmed: **15 minutes of continuous stillness outside any known place**.

### 6.3 Tiered thresholds (so liquor shops aren't missed)

A single 15-min threshold misses common 8–12 min visits (liquor store, pickup, ATM). Solution: two-stage detection.

| Stage | Trigger | Action | LLM-visible |
|---|---|---|---|
| **Provisional** | 8 min STILL outside known places | Capture **lat/lng only** (no geocode call) | No, until upgraded |
| **Confirmed** | 15 min STILL outside known places | Reverse-geocode the captured coords | Yes (writes `place_visit` row) |
| **Deferred** | User moves at 8–14 min mark | If lat/lng captured: still reverse-geocode and write `place_visit` with `source: deferred_geocode` and shorter `duration_ms` | Yes |

This means: even a 10-minute liquor-shop stop becomes a `place_visit` row, but the geocode HTTP call is only made once we're confident the user actually stayed (8 min minimum). Net: ~5–15 geocode calls/day at most.

### 6.4 The geocode call

```
GET https://nominatim.openstreetmap.org/reverse
  ?format=jsonv2
  &lat={lat}
  &lon={lng}
  &zoom=18
  &addressdetails=1
  &extratags=1
  &namedetails=1
```

**Headers required**: `User-Agent: AILifeOS/1.0 (sideload personal use)` — Nominatim's TOS requires identifiable UA.

**Rate limit**: 1 req/sec (we'll do ≤50/day; trivial). No API key.

**Attribution**: must show "© OpenStreetMap contributors" once in the app — we'll put it in Settings.

**Parsing strategy** (`category` field on the event):

The Nominatim response has a `class`/`type` pair (e.g. `class=amenity, type=cafe`) and an optional `extratags` map. We map to our own controlled vocabulary:

| Nominatim signal | Our `category` |
|---|---|
| `amenity=cafe` / `coffee_shop` | `cafe` |
| `amenity=restaurant`, `fast_food`, `bar`, `pub`, `food_court` | `restaurant` |
| `shop=alcohol`, `wine`, `beverages` | `shop_alcohol` |
| `shop=supermarket`, `convenience`, `grocery` | `shop_grocery` |
| `shop=*` (any other) | `shop_other` |
| `leisure=fitness_centre`, `sports_centre`, `gym` | `gym` |
| `amenity=hospital`, `clinic`, `pharmacy` | `health` |
| `tourism=*`, `leisure=park` | `leisure` |
| `office=*` | `office_other` |
| (no match within 50m) | `unknown` |

**Confidence scoring**:
- Single distinct POI within 50m → `confidence = 0.9`
- 2–3 POIs → `confidence = 0.5`, write the closest, optionally fire a "is this Costa or Starbucks?" question.
- No POIs within 50m, only address → `confidence = 0.3`, category `unknown`.

### 6.5 The `place_visit` lifecycle

Mirrors the `app_fg` mutable-row pattern:

1. On confirmed dwell (15 min) → INSERT `place_visit` row with `arrival_ts`, `lat/lng/name/category`, `departure_ts = arrival_ts` (open).
2. On dwell-end (any motion / geofence enter): UPDATE row with `departure_ts` and `duration_ms`.
3. If departure_ts never arrives (service killed): a sweep in `ingest/cleanup.ts` closes any open `place_visit` rows older than 24 h with `departure_ts = arrival_ts + 24h`, marking `truncated: true`.

### 6.6 Battery + privacy budget

- ActivityRecognition: already running, **no extra cost**.
- One-shot GPS fix per dwell: `FusedLocationProvider.getCurrentLocation(PRIORITY_BALANCED_POWER_ACCURACY)`. Typical 1–3 sec GPS warm-up. **<10 such calls/day → battery cost is in noise.**
- Single HTTPS call to Nominatim per dwell. Trivial.
- **No background tracking, no route capture.** We never log "the user took 23rd street to get there" — only "they ended up here for 47 minutes".
- Lat/lng are written into the events table on-device only. Nothing leaves the phone except the one outbound `GET` to Nominatim per dwell.

**Privacy disclosure** (must show in Settings): *"When you stay still in an unknown spot for 15 min, the app sends those coordinates to OpenStreetMap to find out what's there. The result (e.g. 'Costa Coffee') is saved on your phone. The coordinates leave your phone but are not associated with your identity. You can disable auto-place-detection in Settings."*

A toggle `auto_geocode_enabled` in `schema_meta` (default `true`) gates the whole pipeline.

---

## 7. Accuracy Realism

**What will work well (urban / suburban)**:
- Dwells at distinct standalone businesses (corner café, neighbourhood liquor store, gym in a building).
- Recurring patterns (we ask once when ambiguous, and lock in the answer for future).

**What will be ambiguous (and require user clarification)**:
- Multi-tenant buildings (mall, office park, food court).
- Indoor venues with poor GPS (basement bars, underground metros — these often won't even fire STILL accurately).
- Friend's house in a residential block (no POI; will geocode to a road/address).

**The escape hatch**: when confidence < 0.6 OR category = `unknown`, fire a low-priority proactive question: *"You stayed 23 minutes at [address]. What is this place?"* User taps → memory created → place auto-geofenced for next time.

**Realistic accuracy target**: 75% of 10+ min dwells correctly auto-labelled in urban India (where OSM coverage is decent). Remaining 25% surfaces as questions or "unknown" entries.

---

## 8. Implementation Order (the only valid sequence)

This must be done in order — earlier steps validate the data layer that later steps depend on.

### Phase A — `screen_on` / `screen_off` (1 PR)
1. New `ScreenStateReceiver` registered at runtime in `LifeOsForegroundService.onCreate`, unregistered in `onDestroy`. Writes `screen_on` / `screen_off` events.
2. `BRAIN_EXCLUDED_KINDS` constant in `client/src/brain/rawEvents.ts`. Pass-1 query excludes them.
3. Aggregator extension: compute `wake_ts`, `bedtime_ts`, `screen_on_count`, `phantom_check_count`. Add to `daily_rollup.data` JSON.
4. Retention sweep: delete `screen_on/off` rows older than 7 days.
5. Today screen: show `wake_ts` and `bedtime_ts` derived values in the sleep card.

### Phase B — `wake` derived event (½ PR)
6. Aggregator emits `kind='wake'` event when the wake heuristic triggers (so brain can use it as a Class A event without recomputing).

### Phase C — Auto-place pipeline (the big one, ~2 PRs)
7. Add `place_visit` to `EventKind` schema enum.
8. New Kotlin file `PlaceDetector.kt`. Singleton-ish state: `currentDwellStart`, `currentDwellLat/Lng`, `currentRowId`. Hooked into `ActivityTransitionReceiver.onReceive` and `GeofenceReceiver.onReceive` to start/cancel dwells. Uses `FusedLocationProvider` for the one-shot fix.
9. New file `client/src/services/geocoder.ts`. Wraps the Nominatim call. Maps response → our category vocabulary. Includes a 24-hour SQLite cache by `(round(lat,4), round(lng,4))` so we never geocode the same coords twice in a day.
10. Bridge method `LifeOsBridge.geocodeReverse(lat, lng)` so the JS-side caller can be invoked from Kotlin via `HeadlessJsTaskService` if we want to keep the HTTP call in JS (preferred — easier to log, retry, swap providers).
    - Alternative: do it in Kotlin with OkHttp. Slightly less code churn but harder to debug.
    - **Decision**: start in JS. The Kotlin side writes the row with `name=null, category='pending'`, and a 60-second JS-side worker polls for pending rows and fills them in.
11. Settings: privacy disclosure + `auto_geocode_enabled` toggle.

### Phase D — Today timeline UI (1 PR)
12. New `Timeline` component on Today screen, rendering the example output above from `events` joined with `place_visit` and `daily_rollup`.

### Phase E — Pattern-based ask (1 PR, optional V1.1)
13. Recurring-vehicle detector (the Friday bike example) → proactive question.
14. Recurring-place detector → "want to name this place?" → auto-geofence creation.

---

## 9. Schema Additions (additive only, per project rules)

```sql
-- v8 additions (planned). All idempotent via addColumnIfMissing.
ALTER TABLE events ADD COLUMN -- (none needed; payload JSON carries everything)

-- New EventKind values: 'screen_on', 'screen_off', 'wake', 'place_visit'
-- (TypeScript union update only; SQLite kind column is already TEXT.)

-- daily_rollup.data JSON gains the following keys (additive in code only):
--   wake_ts, bedtime_ts, screen_on_count, phantom_check_count, place_visits[]
```

No schema migration is strictly required (events.kind is TEXT, payload is TEXT JSON, daily_rollup.data is TEXT JSON). Code-level migration only.

---

## 10. What "DONE" looks like for this plan

When all of the following are true, the MVP timeline goal is met:

- [ ] `screen_on` / `screen_off` events flowing reliably; aggregator computes wake/bedtime within ±10 min of reality on a test phone.
- [ ] `place_visit` events appearing for 75%+ of urban dwells ≥10 min, with named POIs.
- [ ] Today screen shows the daily timeline like the example in §1.
- [ ] LLM Pass-1 token cost stays within current envelope (verify with `llm_calls.cost_usd` after a week).
- [ ] Privacy disclosure shown; `auto_geocode_enabled` toggle works.

Then we move to the next phase: pattern detection / nudges built on top of this clean event stream.

---

## 11. Things to NOT do during this plan

- Don't add a backend "for syncing places". Local-first.
- Don't switch to Google Places API. Free → paid is a one-way door.
- Don't increase LLM cadence. Same nightly 3-pass. Volume of input is what we control.
- Don't add `notif_event` ingestion until §6 is shipped and validated.
- Don't add real-time location streaming. One-shot fix per confirmed dwell, period.
- Don't store HTTP responses verbatim in events — extract our schema fields and discard the rest.

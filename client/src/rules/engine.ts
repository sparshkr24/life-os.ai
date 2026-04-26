/**
 * Rule engine. One pure entry point: `evaluateRules({tz?})`.
 *
 *   1. SELECT enabled rules.
 *   2. For each rule:
 *      a. parse `trigger` JSON → match against today's events / state.
 *      b. cooldown gate: skip if a `nudges_log` row for this rule_id exists
 *         within the last `cooldown_min` minutes.
 *      c. fire local notification + INSERT nudges_log row.
 *
 * Trigger shapes (matching seed.ts) — extend here as new rules are seeded:
 *
 *   { app, after_local: 'HH:MM', threshold_min_today }
 *      "Today's foreground time on `app` ≥ threshold AND wall-clock ≥ after_local"
 *
 *   { after_event: 'wake', within_sec, app_any: [pkg…] }
 *      "An app from app_any opened within `within_sec` of today's wake_ts"
 *
 *   { between_local: ['HH:MM','HH:MM'], category, threshold_min_today, location }
 *      "Wall-clock in window AND today's `category` minutes ≥ threshold AND
 *       user currently inside the place whose `label` == location"
 *
 * Anything we don't recognise is logged + skipped (forward-compat for rules
 * authored by the nightly LLM in Stage 8).
 */
import type * as SQLite from 'expo-sqlite';
import { withDb } from '../db';
import type { RuleRow } from '../db/schema';
import { localDayStartMs, localHour, localDateStr, deviceTz } from '../aggregator/time';
import { fireNudgeNotification, type NudgeLevel } from './notify';

interface RuleAction {
  level: NudgeLevel;
  message: string;
}

interface FireRecord {
  ruleId: string;
  ruleName: string;
  level: NudgeLevel;
  message: string;
  reasoning: string;
}

export interface RuleTickReport {
  evaluated: number;
  fired: FireRecord[];
  skippedCooldown: number;
  errors: string[];
  durationMs: number;
}

export async function evaluateRules(opts: { tz?: string } = {}): Promise<RuleTickReport> {
  const t0 = Date.now();
  const tz = opts.tz ?? deviceTz();
  const today = localDateStr(t0, tz);
  const dayStart = localDayStartMs(today, tz);
  const fired: FireRecord[] = [];
  const errors: string[] = [];
  let evaluated = 0;
  let skippedCooldown = 0;

  try {
    await withDb(async (db) => {
      const rules = await db.getAllAsync<RuleRow>(
        `SELECT * FROM rules WHERE enabled = 1`,
      );
      for (const r of rules) {
        evaluated += 1;
        try {
          const action = JSON.parse(r.action) as RuleAction;
          const trigger = JSON.parse(r.trigger) as Record<string, unknown>;
          const inCooldown = await isInCooldown(db, r.id, r.cooldown_min, t0);
          if (inCooldown) {
            skippedCooldown += 1;
            continue;
          }
          const reasoning = await matchTrigger(db, trigger, dayStart, t0, tz);
          if (!reasoning) continue;

          await fireNudgeNotification({
            level: action.level,
            title: r.name,
            body: action.message,
            data: { ruleId: r.id, source: 'rule' },
          });
          await db.runAsync(
            `INSERT INTO nudges_log
              (ts, source, rule_id, llm_call_id, reasoning, message, level)
             VALUES (?, 'rule', ?, NULL, ?, ?, ?)`,
            [t0, r.id, reasoning, action.message, action.level],
          );
          fired.push({
            ruleId: r.id,
            ruleName: r.name,
            level: action.level,
            message: action.message,
            reasoning,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${r.id}: ${msg}`);
          console.error(`[rules] ${r.id} failed:`, msg);
        }
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push('outer: ' + msg);
    console.error('[rules] tick failed:', msg);
  }

  const dt = Date.now() - t0;
  if (fired.length > 0 || errors.length > 0) {
    console.log(
      `[rules] tick evaluated=${evaluated} fired=${fired.length} ` +
        `cooldown=${skippedCooldown} errors=${errors.length} in ${dt}ms`,
    );
  }
  return { evaluated, fired, skippedCooldown, errors, durationMs: dt };
}

async function isInCooldown(
  db: SQLite.SQLiteDatabase,
  ruleId: string,
  cooldownMin: number,
  now: number,
): Promise<boolean> {
  const since = now - cooldownMin * 60_000;
  const r = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM nudges_log
     WHERE source = 'rule' AND rule_id = ? AND ts >= ?`,
    [ruleId, since],
  );
  return (r?.n ?? 0) > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Trigger matcher
// ────────────────────────────────────────────────────────────────────────────

async function matchTrigger(
  db: SQLite.SQLiteDatabase,
  trig: Record<string, unknown>,
  dayStart: number,
  now: number,
  tz: string,
): Promise<string | null> {
  // Shape A: { app, after_local, threshold_min_today }
  if (typeof trig.app === 'string' && typeof trig.after_local === 'string') {
    if (!afterLocal(now, tz, trig.after_local)) return null;
    const threshold = toNum(trig.threshold_min_today, 0);
    const minutes = await appMinutesToday(db, trig.app, dayStart, now);
    if (minutes < threshold) return null;
    return `today's ${trig.app} use is ${minutes} min (≥${threshold}) and clock is past ${trig.after_local}`;
  }

  // Shape B: { after_event:'wake', within_sec, app_any }
  if (trig.after_event === 'wake' && Array.isArray(trig.app_any)) {
    const within = toNum(trig.within_sec, 0);
    const wake = await todayWakeTs(db, dayStart);
    if (!wake) return null;
    const cutoff = wake + within * 1000;
    if (now < wake || now > cutoff + 60_000) return null;
    // Did any of app_any open in [wake, cutoff]?
    const apps = trig.app_any.filter((p): p is string => typeof p === 'string');
    if (apps.length === 0) return null;
    const placeholders = apps.map(() => '?').join(',');
    const r = await db.getFirstAsync<{ pkg: string; ts: number } | null>(
      `SELECT json_extract(payload, '$.pkg') AS pkg,
              CAST(json_extract(payload, '$.start_ts') AS INTEGER) AS ts
       FROM events
       WHERE kind = 'app_fg'
         AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) BETWEEN ? AND ?
         AND json_extract(payload, '$.pkg') IN (${placeholders})
       ORDER BY ts ASC LIMIT 1`,
      [wake, cutoff, ...apps],
    );
    if (!r) return null;
    return `${r.pkg} opened ${(r.ts - wake) / 1000 | 0}s after wake (within ${within}s)`;
  }

  // Shape C: { between_local, category, threshold_min_today, location }
  if (Array.isArray(trig.between_local) && typeof trig.category === 'string') {
    const [from, to] = trig.between_local;
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    if (!betweenLocal(now, tz, from, to)) return null;
    const threshold = toNum(trig.threshold_min_today, 0);
    const minutes = await categoryMinutesToday(db, trig.category, dayStart, now);
    if (minutes < threshold) return null;
    if (typeof trig.location === 'string') {
      const here = await currentPlaceLabel(db);
      if (here?.toLowerCase() !== trig.location.toLowerCase()) return null;
    }
    return `${minutes} min of ${trig.category} apps in ${from}–${to} window` +
      (trig.location ? ` at ${trig.location}` : '');
  }

  console.warn('[rules] unknown trigger shape:', JSON.stringify(trig));
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Trigger helpers
// ────────────────────────────────────────────────────────────────────────────

function toNum(v: unknown, dflt: number): number {
  return typeof v === 'number' && isFinite(v) ? v : dflt;
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map((s) => parseInt(s, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

function nowLocalMin(now: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

function afterLocal(now: number, tz: string, hm: string): boolean {
  return nowLocalMin(now, tz) >= parseHm(hm);
}

function betweenLocal(now: number, tz: string, from: string, to: string): boolean {
  const cur = nowLocalMin(now, tz);
  const a = parseHm(from);
  const b = parseHm(to);
  return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
}

async function appMinutesToday(
  db: SQLite.SQLiteDatabase,
  pkg: string,
  dayStart: number,
  now: number,
): Promise<number> {
  // Sum closed sessions + open session (no end_ts written yet).
  const r = await db.getFirstAsync<{ ms: number | null }>(
    `SELECT SUM(MAX(0,
        MIN(?, COALESCE(CAST(json_extract(payload, '$.end_ts') AS INTEGER), ?))
        - MAX(?, CAST(json_extract(payload, '$.start_ts') AS INTEGER))
     )) AS ms
     FROM events
     WHERE kind = 'app_fg'
       AND json_extract(payload, '$.pkg') = ?
       AND CAST(json_extract(payload, '$.start_ts') AS INTEGER) < ?`,
    [now, now, dayStart, pkg, now],
  );
  return Math.round(((r?.ms ?? 0) as number) / 60_000);
}

async function categoryMinutesToday(
  db: SQLite.SQLiteDatabase,
  category: string,
  dayStart: number,
  now: number,
): Promise<number> {
  const r = await db.getFirstAsync<{ ms: number | null }>(
    `SELECT SUM(MAX(0,
        MIN(?, COALESCE(CAST(json_extract(e.payload, '$.end_ts') AS INTEGER), ?))
        - MAX(?, CAST(json_extract(e.payload, '$.start_ts') AS INTEGER))
     )) AS ms
     FROM events e
     JOIN app_categories c ON c.pkg = json_extract(e.payload, '$.pkg')
     WHERE e.kind = 'app_fg'
       AND c.category = ?
       AND CAST(json_extract(e.payload, '$.start_ts') AS INTEGER) < ?`,
    [now, now, dayStart, category, now],
  );
  return Math.round(((r?.ms ?? 0) as number) / 60_000);
}

async function todayWakeTs(
  db: SQLite.SQLiteDatabase,
  dayStart: number,
): Promise<number | null> {
  // Pull longest sleep segment whose end is in [dayStart-12h, dayStart+14h].
  const winStart = dayStart - 12 * 3600_000;
  const winEnd = dayStart + 14 * 3600_000;
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM events
     WHERE kind = 'sleep' AND ts >= ? AND ts < ?
       AND json_extract(payload, '$.kind') = 'segment'`,
    [winStart, winEnd],
  );
  let bestDur = 0;
  let bestEnd: number | null = null;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { start_ts?: number; end_ts?: number };
      if (typeof p.start_ts !== 'number' || typeof p.end_ts !== 'number') continue;
      const dur = p.end_ts - p.start_ts;
      if (dur > bestDur) {
        bestDur = dur;
        bestEnd = p.end_ts;
      }
    } catch {
      /* ignore */
    }
  }
  return bestEnd;
}

async function currentPlaceLabel(
  db: SQLite.SQLiteDatabase,
): Promise<string | null> {
  // Last geo event determines current state. If it's an enter, look up label.
  const last = await db.getFirstAsync<{ kind: string; payload: string } | null>(
    `SELECT kind, payload FROM events
     WHERE kind IN ('geo_enter','geo_exit')
     ORDER BY ts DESC LIMIT 1`,
    [],
  );
  if (!last || last.kind !== 'geo_enter') return null;
  let placeId: string | null = null;
  try {
    const p = JSON.parse(last.payload) as { place_id?: unknown };
    if (typeof p.place_id === 'string') placeId = p.place_id;
  } catch {
    /* ignore */
  }
  if (!placeId) return null;
  const row = await db.getFirstAsync<{ label: string } | null>(
    `SELECT label FROM places WHERE id = ?`,
    [placeId],
  );
  return row?.label ?? placeId;
}

// Used by the App.tsx 60s interval to suppress redundant logs.
export { localHour };

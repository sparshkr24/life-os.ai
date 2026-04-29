/**
 * Brain toolbox. Single registry of every tool the LLM can call.
 *
 * Each tool declares which **scopes** it's allowed in:
 *   - `chat`    — user-facing chat turn (read-mostly; can create todos /
 *                 propose rules / archive memories the user explicitly OKs).
 *   - `nightly` — single tool-calling session at 03:05 (read-mostly; can
 *                 mutate **memories** and **app_categories** as part of
 *                 verification + consolidation + enrichment).
 *
 * **Hard rules (do not relax without updating CLAUDE.md):**
 *   1. No tool may modify *original* event metadata: `events.ts`, `events.kind`,
 *      original `payload` fields written by the Kotlin collectors. Only the
 *      derived columns (memories, app_categories, rules, todos) are mutable
 *      from here.
 *   2. No tool may DELETE rows. Soft-delete via archived_ts / status only.
 *   3. Raw-event reads are bounded — every `get_events_window` call is hard-
 *      capped at 500 rows so the LLM cannot accidentally pull the full table.
 *   4. Nightly mutations on memories touch ONLY feedback columns
 *      (`actual_outcome`, `was_correct`, `reinforcement`, `contradiction`,
 *      `confidence`, `archived_ts`, `parent_id`, `child_ids`, `last_accessed`,
 *      `updated_ts`). Never `summary`, `cause`, `effect`, `embedding`,
 *      `created_ts`, `rollup_date`. New memories go through `createMemory`
 *      which always allocates a fresh embedding.
 */
import { withDb } from '../db';
import { deviceTz, localDateStr, prevDate } from '../aggregator/time';
import { embedText, cosineSim } from '../memory/embed';
import {
  archiveMemory,
  contradictMemory,
  createMemory,
  getMemoryById,
  reinforceMemory,
  recordPredictionOutcome,
  type MemoryInput,
} from '../memory/store';
import type { EventKind, MemoryType } from '../db/schema';
import type { ToolDefinition } from '../llm/types';

// ─────────────────────────────────────────────────────────────────────────
// Scopes & registry
// ─────────────────────────────────────────────────────────────────────────

export type ToolScope = 'chat' | 'nightly_memory' | 'nightly_profile' | 'nightly_nudge';

interface ToolEntry {
  def: ToolDefinition;
  scopes: ToolScope[];
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const REGISTRY: ToolEntry[] = [];

export interface ToolRunner {
  defs: ToolDefinition[];
  run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function getToolsForScope(scope: ToolScope): ToolRunner {
  const allowed = REGISTRY.filter((t) => t.scopes.includes(scope));
  const byName = new Map(allowed.map((t) => [t.def.name, t.handler]));
  return {
    defs: allowed.map((t) => t.def),
    run: async (name, args) => {
      const h = byName.get(name);
      if (!h) return { error: `tool not allowed in scope '${scope}': ${name}` };
      try {
        return await h(args);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

function add(entry: ToolEntry): void {
  REGISTRY.push(entry);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function clampNum(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function asString(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return def;
}

function isDateStr(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isMonthStr(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
}

function uuid(): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0');
  hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

const ALLOWED_EVENT_KINDS: EventKind[] = [
  'app_fg',
  'app_bg',
  'screen_on',
  'screen_off',
  'sleep',
  'wake',
  'geo_enter',
  'geo_exit',
  'activity',
  'steps',
  'notif',
  'heart_rate',
  'inferred_activity',
  'user_clarification',
];

// ─────────────────────────────────────────────────────────────────────────
// READ tools (allowed in every scope)
// ─────────────────────────────────────────────────────────────────────────

add({
  def: {
    name: 'get_today_summary',
    description:
      "Today's daily rollup + productivity score, sleep, top apps, screen time, nudges fired.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async () => loadDailyRollup(localDateStr(Date.now(), deviceTz())),
});

add({
  def: {
    name: 'get_daily_rollup',
    description: 'Daily rollup for a specific date (YYYY-MM-DD).',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    if (!isDateStr(args.date)) return { error: 'date must be YYYY-MM-DD' };
    return loadDailyRollup(args.date);
  },
});

add({
  def: {
    name: 'get_recent_rollups',
    description:
      'Compact rollup summary for the last N days (productivity score, sleep, screen time, top app). Default 7, max 30.',
    parameters: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 30 } },
      required: [],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    const n = clampInt(args.days, 1, 30, 7);
    const tz = deviceTz();
    const out: unknown[] = [];
    let d = localDateStr(Date.now(), tz);
    for (let i = 0; i < n; i += 1) {
      out.push(await loadDailyRollupCompact(d));
      d = prevDate(d);
    }
    return out;
  },
});

add({
  def: {
    name: 'get_monthly_rollup',
    description: 'Monthly rollup for YYYY-MM (computed by aggregator).',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM' } },
      required: ['month'],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    if (!isMonthStr(args.month)) return { error: 'month must be YYYY-MM' };
    return withDb(async (db) => {
      const r = await db.getFirstAsync<{ data: string; updated_ts: number }>(
        `SELECT data, updated_ts FROM monthly_rollup WHERE month = ?`,
        [args.month as string],
      );
      if (!r) return { month: args.month, note: 'no rollup for that month' };
      try {
        return { month: args.month, updated_ts: r.updated_ts, ...JSON.parse(r.data) };
      } catch {
        return { month: args.month, raw: r.data };
      }
    });
  },
});

add({
  def: {
    name: 'get_profile',
    description:
      "The user's behavior profile (good habits, time-wasters, suggested rules). Built nightly.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async () => {
    return withDb(async (db) => {
      const r = await db.getFirstAsync<{ data: string; built_ts: number; based_on_days: number }>(
        `SELECT data, built_ts, based_on_days FROM behavior_profile
         ORDER BY built_ts DESC LIMIT 1`,
      );
      if (!r) return { note: 'no profile yet — nightly job has not run' };
      try {
        return { built_ts: r.built_ts, based_on_days: r.based_on_days, ...JSON.parse(r.data) };
      } catch {
        return { built_ts: r.built_ts, based_on_days: r.based_on_days, raw: r.data };
      }
    });
  },
});

add({
  def: {
    name: 'get_recent_nudges',
    description:
      'Nudges fired in the last N days (default 7, max 30) with helpfulness feedback and score deltas.',
    parameters: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 30 } },
      required: [],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    const n = clampInt(args.days, 1, 30, 7);
    const since = Date.now() - n * 24 * 3600_000;
    return withDb(async (db) => {
      const rows = await db.getAllAsync<{
        ts: number;
        source: string;
        level: number;
        message: string;
        user_helpful: number | null;
        score_delta: number | null;
      }>(
        `SELECT ts, source, level, message, user_helpful, score_delta
         FROM nudges_log WHERE ts >= ? ORDER BY ts DESC LIMIT 100`,
        [since],
      );
      return rows.map((r) => ({
        ago_minutes: Math.round((Date.now() - r.ts) / 60_000),
        source: r.source,
        level: r.level,
        message: r.message,
        user_helpful: r.user_helpful,
        score_delta: r.score_delta,
      }));
    });
  },
});

add({
  def: {
    name: 'search_memories',
    description:
      'Semantic search over the memory store. Returns top-k memories matching `query`. Filters out archived.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k: { type: 'integer', minimum: 1, maximum: 20 },
        type: {
          type: 'string',
          enum: ['pattern', 'causal', 'prediction', 'habit'],
        },
      },
      required: ['query'],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    const query = asString(args.query, 1000);
    if (!query) return { error: 'query required' };
    const k = clampInt(args.k, 1, 20, 6);
    const typeFilter = typeof args.type === 'string' ? (args.type as MemoryType) : null;
    const qVec = await embedText(query);
    if (!qVec) return { error: 'embed failed (cost cap or no key)' };
    return withDb(async (db) => {
      const rows = await db.getAllAsync<{
        id: string; type: string; summary: string; impact_score: number;
        confidence: number; tags: string; embedding: string;
        rollup_date: string | null; predicted_outcome: string | null;
        actual_outcome: string | null; was_correct: number | null;
      }>(
        `SELECT id, type, summary, impact_score, confidence, tags, embedding,
                rollup_date, predicted_outcome, actual_outcome, was_correct
         FROM memories
         WHERE archived_ts IS NULL ${typeFilter ? 'AND type = ?' : ''}
         ORDER BY last_accessed DESC LIMIT 1000`,
        typeFilter ? [typeFilter] : [],
      );
      const scored = rows
        .map((r) => {
          let vec: number[] = [];
          try { vec = JSON.parse(r.embedding) as number[]; } catch { /* skip */ }
          const sim = vec.length === qVec.vector.length ? cosineSim(vec, qVec.vector) : 0;
          return { row: r, sim };
        })
        .filter((s) => s.sim > 0)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k);
      return scored.map(({ row, sim }) => ({
        id: row.id,
        type: row.type,
        summary: row.summary,
        impact_score: row.impact_score,
        confidence: row.confidence,
        similarity: Number(sim.toFixed(3)),
        tags: safeArr(row.tags),
        rollup_date: row.rollup_date,
        predicted_outcome: row.predicted_outcome,
        actual_outcome: row.actual_outcome,
        was_correct: row.was_correct,
      }));
    });
  },
});

add({
  def: {
    name: 'get_memory',
    description: 'Fetch a single memory by id, including cause / effect / outcome detail.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    if (!id) return { error: 'id required' };
    const m = await getMemoryById(id);
    if (!m) return { error: 'not found' };
    // Strip the embedding — too big and never useful in-prompt.
    const { embedding: _e, ...rest } = m;
    return rest;
  },
});

add({
  def: {
    name: 'get_events_window',
    description:
      "Bounded raw-event read. Returns up to `limit` events (max 1000) between `start_ts` and `end_ts` (epoch ms), optionally filtered by `kinds`. PREFERRED for precise timing/duration questions ('how long in office today?', 'when did I leave gym?'). Pair kinds=['geo_enter','geo_exit'] with list_places to compute place dwell.",
    parameters: {
      type: 'object',
      properties: {
        start_ts: { type: 'integer' },
        end_ts: { type: 'integer' },
        kinds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      required: ['start_ts', 'end_ts'],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    const startTs = Number(args.start_ts);
    const endTs = Number(args.end_ts);
    if (!isFinite(startTs) || !isFinite(endTs) || endTs <= startTs) {
      return { error: 'invalid range' };
    }
    const limit = clampInt(args.limit, 1, 1000, 300);
    const kinds = Array.isArray(args.kinds)
      ? (args.kinds as unknown[])
          .filter((k): k is EventKind =>
            typeof k === 'string' && (ALLOWED_EVENT_KINDS as string[]).includes(k),
          )
      : [];
    return withDb(async (db) => {
      const where: string[] = ['ts >= ?', 'ts < ?'];
      const params: (string | number | null)[] = [startTs, endTs];
      if (kinds.length > 0) {
        where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
        params.push(...kinds);
      }
      params.push(limit);
      const rows = await db.getAllAsync<{ id: number; ts: number; kind: string; payload: string }>(
        `SELECT id, ts, kind, payload FROM events
         WHERE ${where.join(' AND ')}
         ORDER BY ts ASC LIMIT ?`,
        params,
      );
      return rows.map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, payload: safeJson(r.payload) }));
    });
  },
});

add({
  def: {
    name: 'count_events_by_app',
    description:
      'For a given date (YYYY-MM-DD), return per-pkg counts and total foreground minutes from app_fg events. Top N (default 20, max 100).',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        top_n: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['date'],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    if (!isDateStr(args.date)) return { error: 'date must be YYYY-MM-DD' };
    const topN = clampInt(args.top_n, 1, 100, 20);
    const dayStart = Date.parse(args.date + 'T00:00:00');
    const dayEnd = dayStart + 24 * 3600_000;
    return withDb(async (db) => {
      const rows = await db.getAllAsync<{ pkg: string; minutes: number; sessions: number }>(
        `SELECT
            json_extract(payload,'$.pkg') AS pkg,
            SUM(MAX(0,CAST(json_extract(payload,'$.duration_ms') AS INTEGER)))/60000.0 AS minutes,
            COUNT(*) AS sessions
         FROM events
         WHERE kind='app_fg'
           AND CAST(json_extract(payload,'$.start_ts') AS INTEGER) >= ?
           AND CAST(json_extract(payload,'$.start_ts') AS INTEGER) <  ?
         GROUP BY pkg ORDER BY minutes DESC LIMIT ?`,
        [dayStart, dayEnd, topN],
      );
      return rows.map((r) => ({
        pkg: r.pkg,
        minutes: Math.round(r.minutes),
        sessions: r.sessions,
      }));
    });
  },
});

add({
  def: {
    name: 'get_app_categories',
    description:
      'Read app_categories rows. Useful for nightly enrichment to find pkgs lacking subcategory/details. Set `only_unenriched=true` to filter to enriched=0.',
    parameters: {
      type: 'object',
      properties: {
        only_unenriched: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: [],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile', 'nightly_nudge'],
  handler: async (args) => {
    const onlyUn = asBool(args.only_unenriched, false);
    const limit = clampInt(args.limit, 1, 200, 100);
    return withDb(async (db) => {
      const rows = await db.getAllAsync<{
        pkg: string; category: string; subcategory: string | null;
        source: string; enriched: number; details: string | null;
      }>(
        `SELECT pkg, category, subcategory, source, enriched, details
         FROM app_categories
         ${onlyUn ? 'WHERE enriched = 0' : ''}
         ORDER BY pkg LIMIT ?`,
        [limit],
      );
      return rows.map((r) => ({
        pkg: r.pkg,
        category: r.category,
        subcategory: r.subcategory,
        source: r.source,
        enriched: r.enriched === 1,
        details: r.details ? safeJson(r.details) : null,
      }));
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────
// CHAT-only writes
// ─────────────────────────────────────────────────────────────────────────

add({
  def: {
    name: 'create_todo',
    description:
      'Create a todo for the user. Use ONLY when the user explicitly asks to schedule / remember / be reminded of something.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
        due_ts: { type: 'integer', description: 'Epoch ms; optional' },
        priority: { type: 'integer', minimum: 1, maximum: 3 },
      },
      required: ['title'],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const title = asString(args.title, 200);
    if (!title) return { error: 'title required' };
    const notes = asString(args.notes, 1000);
    const dueTs = isFinite(Number(args.due_ts)) ? Number(args.due_ts) : null;
    const priority = clampInt(args.priority, 1, 3, 2);
    const id = uuid();
    const now = Date.now();
    await withDb(async (db) => {
      await db.runAsync(
        `INSERT INTO todos (id,title,notes,due_ts,priority,remind_strategy,status,created_ts,updated_ts)
         VALUES (?,?,?,?,?,'none','open',?,?)`,
        [id, title, notes, dueTs, priority, now, now],
      );
    });
    return { id, title, due_ts: dueTs, priority };
  },
});

add({
  def: {
    name: 'update_todo',
    description: 'Update an existing todo. Status can be open / done / snoozed / dropped.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'snoozed', 'dropped'] },
        notes: { type: 'string' },
        due_ts: { type: 'integer' },
      },
      required: ['id'],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    if (!id) return { error: 'id required' };
    const sets: string[] = ['updated_ts = ?'];
    const vals: (string | number | null)[] = [Date.now()];
    if (typeof args.status === 'string') {
      sets.push('status = ?');
      vals.push(args.status);
      if (args.status === 'done') {
        sets.push('done_ts = ?');
        vals.push(Date.now());
      }
    }
    if (typeof args.notes === 'string') { sets.push('notes = ?'); vals.push(args.notes); }
    if (isFinite(Number(args.due_ts))) { sets.push('due_ts = ?'); vals.push(Number(args.due_ts)); }
    vals.push(id);
    return withDb(async (db) => {
      const r = await db.runAsync(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, vals);
      return { id, changed: r.changes };
    });
  },
});

add({
  def: {
    name: 'propose_rule',
    description:
      'Propose a new nudge rule for the user to review. Inserted with enabled=0; user must enable in Settings.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        trigger: { type: 'string', description: 'JSON-encoded trigger condition' },
        action: { type: 'string', description: 'JSON-encoded action' },
        cooldown_min: { type: 'integer', minimum: 1, maximum: 1440 },
      },
      required: ['name', 'trigger', 'action'],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const name = asString(args.name, 200);
    const trigger = asString(args.trigger, 4000);
    const action = asString(args.action, 4000);
    if (!name || !trigger || !action) return { error: 'name/trigger/action required' };
    const id = uuid();
    const cd = clampInt(args.cooldown_min, 1, 1440, 30);
    await withDb(async (db) => {
      await db.runAsync(
        `INSERT INTO rules (id,name,enabled,trigger,action,cooldown_min) VALUES (?,?,0,?,?,?)`,
        [id, name, trigger, action, cd],
      );
    });
    return { id, name, enabled: false };
  },
});

add({
  def: {
    name: 'mark_memory_archived',
    description:
      'Archive (soft-delete) a memory. Use when the user explicitly says a learned pattern is wrong.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, reason: { type: 'string' } },
      required: ['id'],
    },
  },
  scopes: ['chat', 'nightly_memory', 'nightly_profile'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    if (!id) return { error: 'id required' };
    await archiveMemory(id);
    return { id, archived: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// CHAT writes (v7 — places, memory, proactive question)
// ─────────────────────────────────────────────────────────────────────────

add({
  def: {
    name: 'add_geofence_place',
    description:
      'Save a new geofenced place (Home/Office/Gym/etc) so the phone can fire geo_enter / geo_exit events for it. Default radius is 25 m. Use when the user names a location during chat or after answering a proactive question.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name shown to the user (max 64 chars).' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        radius_m: {
          type: 'integer',
          minimum: 15,
          maximum: 500,
          description: 'Default 25; raise for large venues (gym, campus).',
        },
      },
      required: ['label', 'lat', 'lng'],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const label = asString(args.label, 64);
    const lat = Number(args.lat);
    const lng = Number(args.lng);
    if (!label) return { error: 'label required' };
    if (!isFinite(lat) || !isFinite(lng)) return { error: 'lat/lng must be numbers' };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { error: 'lat/lng out of range' };
    }
    const radius = clampInt(args.radius_m, 15, 500, 25);
    const { addPlace } = await import('../repos/places');
    const row = await addPlace({ label, lat, lng, radiusM: radius });
    return {
      id: row.id,
      label: row.label,
      lat: row.lat,
      lng: row.lng,
      radius_m: row.radius_m,
    };
  },
});

add({
  def: {
    name: 'ask_user_question',
    description:
      "Queue a single short proactive question for the user. Use sparingly — only when answering would clearly improve future suggestions and you don't already know. Hard caps still apply (≤3/day, ≥120 min between, no pending). The question is shown both as an interactive notification AND as a card on the Today screen.",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'One short sentence ≤ 18 words.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2–4 short choices. For yes/no, use ["Yes","No"].',
        },
        expected_kind: { type: 'string', enum: ['yes_no', 'place_name', 'free_text'] },
        trigger_kind: { type: 'string', enum: ['ad_hoc'], description: 'Always "ad_hoc" from chat.' },
      },
      required: ['prompt', 'options', 'expected_kind'],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const prompt = asString(args.prompt, 280);
    if (!prompt) return { error: 'prompt required' };
    const options = Array.isArray(args.options)
      ? (args.options as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 4)
      : [];
    if (options.length < 2) return { error: 'need ≥2 options' };
    const ek = args.expected_kind;
    if (ek !== 'yes_no' && ek !== 'place_name' && ek !== 'free_text') {
      return { error: 'invalid expected_kind' };
    }
    return withDb(async (db) => {
      const pending = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proactive_questions WHERE status='pending'`,
      );
      if ((pending?.n ?? 0) > 0) return { error: 'pending question exists' };
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const today = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proactive_questions WHERE ts >= ?`,
        [startOfDay.getTime()],
      );
      if ((today?.n ?? 0) >= 3) return { error: 'daily cap (3) reached' };

      const id = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const ts = Date.now();
      await db.runAsync(
        `INSERT INTO proactive_questions
           (id, ts, trigger_kind, trigger_payload, prompt, options, expected_kind, status)
         VALUES (?, ?, 'ad_hoc', '{}', ?, ?, ?, 'pending')`,
        [id, ts, prompt, JSON.stringify(options), ek],
      );
      await db.runAsync(
        `INSERT INTO events (ts, kind, payload) VALUES (?, 'ai_question', ?)`,
        [ts, JSON.stringify({ question_id: id, trigger_kind: 'ad_hoc', prompt })],
      );
      try {
        const { fireProactiveQuestionNotification } = await import('../rules/proactiveNotify');
        const notifId = await fireProactiveQuestionNotification({
          id,
          prompt,
          options,
          expectedKind: ek,
        });
        if (notifId) {
          await db.runAsync(
            `UPDATE proactive_questions SET notification_id = ? WHERE id = ?`,
            [notifId, id],
          );
        }
      } catch (e) {
        console.error(
          '[ask_user_question] notify failed:',
          e instanceof Error ? e.message : String(e),
        );
      }
      return { id, prompt, expected_kind: ek };
    });
  },
});

add({
  def: {
    name: 'mark_pattern_memory',
    description:
      "Record an observation the user just confirmed in chat as a typed memory (pattern/habit/causal/prediction). The created memory is identical to one extracted nightly, just authored in real time. Tags should include weekday, hour, and place when applicable so RAG retrieval works later.",
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['pattern', 'causal', 'prediction', 'habit'] },
        summary: { type: 'string' },
        cause: { type: 'string' },
        effect: { type: 'string' },
        impact_score: { type: 'number', minimum: -1, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'summary', 'impact_score', 'confidence', 'tags'],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const summary = asString(args.summary, 1000);
    if (!summary) return { error: 'summary required' };
    const type = args.type as MemoryType;
    if (!['pattern', 'causal', 'prediction', 'habit'].includes(type)) {
      return { error: 'invalid type' };
    }
    const tags = Array.isArray(args.tags)
      ? (args.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 16)
      : [];
    const input: MemoryInput = {
      type,
      summary,
      cause: asString(args.cause, 500) ?? undefined,
      effect: asString(args.effect, 500) ?? undefined,
      impact_score: clampNum(args.impact_score, -1, 1, 0),
      confidence: clampNum(args.confidence, 0, 1, 0.6),
      tags,
      source_ref: 'chat',
    };
    const id = await createMemory(input);
    if (!id) return { error: 'embedding failed (cost cap or no key)' };
    return { id, type, summary };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// CHAT read-only inventories (v7+)
// These are bounded list/range queries the chat LLM can use to answer
// concrete factual questions ("how long was I in office today?",
// "what time did I leave the gym last Tuesday?"). The system prompt tells
// chat to PREFER these raw-event lookups over rollup summaries when the
// user asks for precise timing.
// ─────────────────────────────────────────────────────────────────────────

add({
  def: {
    name: 'list_places',
    description:
      'List every geofenced place the user has saved (Home, Office, Gym, etc) with id/label/lat/lng/radius_m. Use for any query that mentions a named location so you can pair it with geo_enter / geo_exit events.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  scopes: ['chat'],
  handler: async () => {
    const { listPlaces } = await import('../repos/places');
    const rows = await listPlaces();
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      lat: r.lat,
      lng: r.lng,
      radius_m: r.radius_m,
    }));
  },
});

add({
  def: {
    name: 'list_todos',
    description:
      "List todos. Default: open + in-progress (not done/cancelled). Pass status='all' for everything, or 'done' for completed only.",
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: [],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const status = args.status === 'done' || args.status === 'all' ? args.status : 'open';
    const limit = clampInt(args.limit, 1, 100, 50);
    return withDb(async (db) => {
      let where = '';
      if (status === 'open') where = "WHERE status NOT IN ('done','cancelled')";
      else if (status === 'done') where = "WHERE status = 'done'";
      const rows = await db.getAllAsync<{
        id: string; title: string; notes: string | null; due_ts: number | null;
        priority: number; status: string; created_ts: number; done_ts: number | null;
      }>(
        `SELECT id, title, notes, due_ts, priority, status, created_ts, done_ts
         FROM todos ${where} ORDER BY COALESCE(due_ts, created_ts) ASC LIMIT ?`,
        [limit],
      );
      return rows;
    });
  },
});

add({
  def: {
    name: 'list_recent_memories',
    description:
      'Newest-first chronological list of memories (no semantic search). Useful when the user asks "what have you noticed recently?" Pass `type` to filter (pattern/causal/prediction/habit). For semantic lookup, use search_memories instead.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['pattern', 'causal', 'prediction', 'habit'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const limit = clampInt(args.limit, 1, 50, 20);
    const type = typeof args.type === 'string' ? args.type : null;
    return withDb(async (db) => {
      const rows = await db.getAllAsync<{
        id: string; type: string; summary: string; cause: string | null; effect: string | null;
        impact_score: number; confidence: number; occurrences: number;
        tags: string; created_ts: number; was_correct: number | null;
      }>(
        `SELECT id, type, summary, cause, effect, impact_score, confidence, occurrences,
                tags, created_ts, was_correct
         FROM memories
         WHERE archived_ts IS NULL ${type ? 'AND type = ?' : ''}
         ORDER BY created_ts DESC LIMIT ?`,
        type ? [type, limit] : [limit],
      );
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        summary: r.summary,
        cause: r.cause,
        effect: r.effect,
        impact_score: r.impact_score,
        confidence: r.confidence,
        occurrences: r.occurrences,
        tags: safeJson(r.tags),
        created_ts: r.created_ts,
        was_correct: r.was_correct,
      }));
    });
  },
});

add({
  def: {
    name: 'list_proactive_questions',
    description:
      "List the AI's own past proactive questions and how the user answered. Useful when the user says 'what did you ask me yesterday?' or you want to avoid asking the same thing twice in chat. Newest-first.",
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'answered', 'dismissed', 'expired', 'all'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  scopes: ['chat'],
  handler: async (args) => {
    const limit = clampInt(args.limit, 1, 50, 20);
    const statuses = ['pending', 'answered', 'dismissed', 'expired'];
    const status =
      typeof args.status === 'string' && statuses.includes(args.status) ? args.status : 'all';
    return withDb(async (db) => {
      const where = status === 'all' ? '' : 'WHERE status = ?';
      const params: (string | number)[] = status === 'all' ? [limit] : [status, limit];
      const rows = await db.getAllAsync<{
        id: string; ts: number; trigger_kind: string; prompt: string;
        options: string; expected_kind: string; status: string;
        answered_text: string | null; answered_ts: number | null;
      }>(
        `SELECT id, ts, trigger_kind, prompt, options, expected_kind, status,
                answered_text, answered_ts
         FROM proactive_questions ${where} ORDER BY ts DESC LIMIT ?`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        trigger_kind: r.trigger_kind,
        prompt: r.prompt,
        options: safeJson(r.options),
        expected_kind: r.expected_kind,
        status: r.status,
        answered_text: r.answered_text,
        answered_ts: r.answered_ts,
      }));
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────
// NIGHTLY-only writes
// ─────────────────────────────────────────────────────────────────────────

add({
  def: {
    name: 'create_memory',
    description:
      'Create a new memory from observed behavior. Allocates a fresh embedding. Use during nightly extraction from yesterday rollup.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['pattern', 'causal', 'prediction', 'habit'] },
        summary: { type: 'string' },
        cause: { type: 'string' },
        effect: { type: 'string' },
        impact_score: { type: 'number', minimum: -1, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string' } },
        rollup_date: { type: 'string', description: 'YYYY-MM-DD' },
        predicted_outcome: { type: 'string' },
      },
      required: ['type', 'summary', 'impact_score', 'confidence', 'tags'],
    },
  },
  scopes: ['nightly_memory'],
  handler: async (args) => {
    const summary = asString(args.summary, 1000);
    if (!summary) return { error: 'summary required' };
    const type = args.type as MemoryType;
    if (!['pattern', 'causal', 'prediction', 'habit'].includes(type)) {
      return { error: 'invalid type' };
    }
    const tags = Array.isArray(args.tags)
      ? (args.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 12)
      : [];
    const input: MemoryInput = {
      type,
      summary,
      cause: asString(args.cause, 500) ?? undefined,
      effect: asString(args.effect, 500) ?? undefined,
      impact_score: clampNum(args.impact_score, -1, 1, 0),
      confidence: clampNum(args.confidence, 0, 1, 0.5),
      tags,
      rollup_date: isDateStr(args.rollup_date) ? args.rollup_date : undefined,
      predicted_outcome: asString(args.predicted_outcome, 500) ?? undefined,
    };
    const id = await createMemory(input);
    if (!id) return { error: 'embed failed (cost cap, no key, or http error)' };
    return { id, type, summary };
  },
});

add({
  def: {
    name: 'verify_memory',
    description:
      'Record the actual outcome of a memory that previously had a predicted_outcome. ' +
      'Sets actual_outcome + was_correct, then internally calls reinforce_memory or ' +
      'contradict_memory (so confidence shifts ±0.05/−0.10 automatically). The post-pass ' +
      'sweep auto-archives predictions verified false that have never been reinforced — ' +
      "don't bother manually archiving a one-off wrong call.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        actual_outcome: { type: 'string' },
        was_correct: { type: 'boolean' },
      },
      required: ['id', 'actual_outcome', 'was_correct'],
    },
  },
  scopes: ['nightly_memory'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    const actual = asString(args.actual_outcome, 1000);
    if (!id || !actual) return { error: 'id and actual_outcome required' };
    const was = asBool(args.was_correct, false);
    await recordPredictionOutcome(id, actual, was);
    if (was) await reinforceMemory(id);
    else await contradictMemory(id);
    return { id, was_correct: was };
  },
});

add({
  def: {
    name: 'reinforce_memory',
    description:
      'Bump reinforcement count + nudge confidence up (+0.05, capped at 0.99) on a memory ' +
      'observed again today.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  scopes: ['nightly_memory'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    if (!id) return { error: 'id required' };
    await reinforceMemory(id);
    return { id, reinforced: true };
  },
});

add({
  def: {
    name: 'contradict_memory',
    description:
      'Bump contradiction count + drop confidence (−0.10, floor 0.05) on a memory disproven ' +
      "by today's evidence. The post-pass sweep auto-archives memories with ≥3 contradictions " +
      'AND ratio ≥2:1 vs reinforcement — you do not need to manually archive routine misses.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  scopes: ['nightly_memory'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    if (!id) return { error: 'id required' };
    await contradictMemory(id);
    return { id, contradicted: true };
  },
});

add({
  def: {
    name: 'consolidate_memories',
    description:
      'Merge similar specific memories into an abstract parent. Creates a new parent memory and links the children via parent_id/child_ids. Children are NOT archived automatically — call mark_memory_archived for any that should be retired.',
    parameters: {
      type: 'object',
      properties: {
        parent_summary: { type: 'string' },
        parent_cause: { type: 'string' },
        parent_effect: { type: 'string' },
        impact_score: { type: 'number', minimum: -1, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string' } },
        child_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['parent_summary', 'impact_score', 'confidence', 'tags', 'child_ids'],
    },
  },
  scopes: ['nightly_memory'],
  handler: async (args) => {
    const summary = asString(args.parent_summary, 1000);
    if (!summary) return { error: 'parent_summary required' };
    const childIds = Array.isArray(args.child_ids)
      ? (args.child_ids as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 24)
      : [];
    if (childIds.length < 2) return { error: 'need at least 2 child_ids' };
    const tags = Array.isArray(args.tags)
      ? (args.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 12)
      : [];
    const parentId = await createMemory({
      type: 'pattern',
      summary,
      cause: asString(args.parent_cause, 500) ?? undefined,
      effect: asString(args.parent_effect, 500) ?? undefined,
      impact_score: clampNum(args.impact_score, -1, 1, 0),
      confidence: clampNum(args.confidence, 0, 1, 0.5),
      tags,
    });
    if (!parentId) return { error: 'parent embed failed' };
    const now = Date.now();
    await withDb(async (db) => {
      await db.runAsync(
        `UPDATE memories SET child_ids = ?, updated_ts = ? WHERE id = ?`,
        [JSON.stringify(childIds), now, parentId],
      );
      for (const cid of childIds) {
        await db.runAsync(
          `UPDATE memories SET parent_id = ?, updated_ts = ? WHERE id = ?`,
          [parentId, now, cid],
        );
      }
    });
    return { parent_id: parentId, child_ids: childIds };
  },
});

add({
  def: {
    name: 'set_app_category',
    description:
      'Update enrichment fields for a package: category, subcategory, details JSON. Skips if existing source=user (user manual override). Sets enriched=1.',
    parameters: {
      type: 'object',
      properties: {
        pkg: { type: 'string' },
        category: { type: 'string', enum: ['productive', 'neutral', 'unproductive'] },
        subcategory: { type: 'string' },
        details: {
          type: 'object',
          description: 'Free-form metadata: {publisher?, description?, official_site?, ...}',
        },
      },
      required: ['pkg', 'category', 'subcategory'],
    },
  },
  scopes: ['nightly_memory'],
  handler: async (args) => {
    const pkg = asString(args.pkg, 200);
    if (!pkg) return { error: 'pkg required' };
    const category = args.category;
    if (typeof category !== 'string' ||
        !['productive', 'neutral', 'unproductive'].includes(category)) {
      return { error: 'invalid category' };
    }
    const subcategory = asString(args.subcategory, 80);
    const detailsJson = typeof args.details === 'object' && args.details !== null
      ? JSON.stringify(args.details).slice(0, 4000)
      : null;
    const now = Date.now();
    return withDb(async (db) => {
      const existing = await db.getFirstAsync<{ source: string }>(
        `SELECT source FROM app_categories WHERE pkg = ?`, [pkg],
      );
      if (existing?.source === 'user') {
        return { pkg, skipped: 'user override' };
      }
      await db.runAsync(
        `INSERT INTO app_categories
          (pkg, category, source, subcategory, enriched, last_categorized_ts, details)
         VALUES (?, ?, 'llm', ?, 1, ?, ?)
         ON CONFLICT(pkg) DO UPDATE SET
           category = excluded.category,
           source = 'llm',
           subcategory = excluded.subcategory,
           enriched = 1,
           last_categorized_ts = excluded.last_categorized_ts,
           details = excluded.details`,
        [pkg, category, subcategory, now, detailsJson],
      );
      return { pkg, category, subcategory, enriched: true };
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────
// NIGHTLY-NUDGE writes (Stage 14 — LLM-generated rules)
// Write tools below operate ONLY on rules with source='llm'. Existing
// 'user' / 'seed' rules are read-only here — the user owns those.
// ─────────────────────────────────────────────────────────────────────────

add({
  def: {
    name: 'list_rules',
    description:
      "List rules. Use to see what's already in place before creating new ones. Filter by source (\"llm\"|\"seed\"|\"user\") and/or enabled (true|false).",
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['llm', 'seed', 'user'] },
        enabled: { type: 'boolean' },
      },
    },
  },
  scopes: ['nightly_nudge'],
  handler: async (args) => {
    const source = asString(args.source, 16);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (source === 'llm' || source === 'seed' || source === 'user') {
      where.push('source = ?');
      params.push(source);
    }
    if (typeof args.enabled === 'boolean') {
      where.push('enabled = ?');
      params.push(args.enabled ? 1 : 0);
    }
    const sql =
      `SELECT id, name, enabled, trigger, action, cooldown_min, source,
              predicted_impact_score, based_on_memory_ids, disabled_reason,
              last_refined_ts
       FROM rules` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    return withDb(async (db) => {
      const rows = await db.getAllAsync<{
        id: string;
        name: string;
        enabled: number;
        trigger: string;
        action: string;
        cooldown_min: number;
        source: string;
        predicted_impact_score: number | null;
        based_on_memory_ids: string | null;
        disabled_reason: string | null;
        last_refined_ts: number | null;
      }>(sql, params);
      return rows.map((r) => ({
        ...r,
        enabled: r.enabled === 1,
        trigger: safeJson(r.trigger),
        action: safeJson(r.action),
        based_on_memory_ids: r.based_on_memory_ids
          ? safeArr(r.based_on_memory_ids)
          : [],
      }));
    });
  },
});

add({
  def: {
    name: 'get_rule_effectiveness',
    description:
      'For a given rule, return how well it has performed recently: number of times fired, ' +
      'average score_delta on next-day productivity, and user thumbs (helpful=1, unhelpful=-1) counts. ' +
      'Use to decide whether to keep, refine, or disable a rule.',
    parameters: {
      type: 'object',
      properties: {
        rule_id: { type: 'string' },
        days: { type: 'integer', minimum: 1, maximum: 60 },
      },
      required: ['rule_id'],
    },
  },
  scopes: ['nightly_nudge'],
  handler: async (args) => {
    const ruleId = asString(args.rule_id, 100);
    if (!ruleId) return { error: 'rule_id required' };
    const days = clampInt(args.days, 1, 60, 14);
    const since = Date.now() - days * 86_400_000;
    return withDb(async (db) => {
      const r = await db.getFirstAsync<{
        fired: number;
        acted: number;
        dismissed: number;
        avg_score_delta: number | null;
        helpful_up: number;
        helpful_down: number;
      }>(
        `SELECT
            COUNT(*) AS fired,
            SUM(CASE WHEN user_action='acted'     THEN 1 ELSE 0 END) AS acted,
            SUM(CASE WHEN user_action='dismissed' THEN 1 ELSE 0 END) AS dismissed,
            AVG(score_delta) AS avg_score_delta,
            SUM(CASE WHEN user_helpful= 1 THEN 1 ELSE 0 END) AS helpful_up,
            SUM(CASE WHEN user_helpful=-1 THEN 1 ELSE 0 END) AS helpful_down
         FROM nudges_log
         WHERE rule_id = ? AND ts >= ?`,
        [ruleId, since],
      );
      return {
        rule_id: ruleId,
        window_days: days,
        fired: r?.fired ?? 0,
        acted: r?.acted ?? 0,
        dismissed: r?.dismissed ?? 0,
        avg_score_delta: r?.avg_score_delta ?? null,
        helpful_up: r?.helpful_up ?? 0,
        helpful_down: r?.helpful_down ?? 0,
      };
    });
  },
});

add({
  def: {
    name: 'create_rule',
    description:
      'Create a new LLM-generated rule (source="llm", enabled=1). Only call if the predicted ' +
      'impact is meaningful (score >= 0.15) and the rule is grounded in one or more memories ' +
      '(pass their ids in based_on_memory_ids). trigger and action must be valid JSON strings ' +
      'matching one of the shapes documented in rules/engine.ts.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human-readable label' },
        trigger: { type: 'string', description: 'JSON-encoded trigger condition' },
        action: { type: 'string', description: 'JSON-encoded action {level, message}' },
        cooldown_min: { type: 'integer', minimum: 5, maximum: 1440 },
        predicted_impact_score: { type: 'number', minimum: 0, maximum: 1 },
        based_on_memory_ids: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'name',
        'trigger',
        'action',
        'cooldown_min',
        'predicted_impact_score',
        'based_on_memory_ids',
      ],
    },
  },
  scopes: ['nightly_nudge'],
  handler: async (args) => {
    const name = asString(args.name, 200);
    const trigger = asString(args.trigger, 4000);
    const action = asString(args.action, 4000);
    if (!name || !trigger || !action) {
      return { error: 'name/trigger/action required' };
    }
    try {
      JSON.parse(trigger);
      JSON.parse(action);
    } catch {
      return { error: 'trigger and action must be valid JSON' };
    }
    const impact = clampNum(args.predicted_impact_score, 0, 1, 0);
    if (impact < 0.15) {
      return { error: `predicted_impact_score=${impact} below threshold 0.15` };
    }
    const memIds = Array.isArray(args.based_on_memory_ids)
      ? args.based_on_memory_ids.filter((x): x is string => typeof x === 'string').slice(0, 20)
      : [];
    if (memIds.length === 0) {
      return { error: 'based_on_memory_ids must have at least one memory id' };
    }
    const cd = clampInt(args.cooldown_min, 5, 1440, 60);
    const id = uuid();
    const now = Date.now();
    await withDb(async (db) => {
      await db.runAsync(
        `INSERT INTO rules
           (id, name, enabled, trigger, action, cooldown_min, source,
            predicted_impact_score, based_on_memory_ids, last_refined_ts)
         VALUES (?, ?, 1, ?, ?, ?, 'llm', ?, ?, ?)`,
        [id, name, trigger, action, cd, impact, JSON.stringify(memIds), now],
      );
    });
    return { id, name, enabled: true, source: 'llm', predicted_impact_score: impact };
  },
});

add({
  def: {
    name: 'update_rule',
    description:
      'Patch an existing LLM-generated rule (source="llm" only). Use to loosen/tighten ' +
      'cooldown, change trigger or action JSON, or update predicted_impact_score. ' +
      'Stamps last_refined_ts. Will refuse on user/seed rules.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        trigger: { type: 'string', description: 'JSON-encoded trigger' },
        action: { type: 'string', description: 'JSON-encoded action' },
        cooldown_min: { type: 'integer', minimum: 5, maximum: 1440 },
        predicted_impact_score: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['id'],
    },
  },
  scopes: ['nightly_nudge'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    if (!id) return { error: 'id required' };
    return withDb(async (db) => {
      const row = await db.getFirstAsync<{ source: string }>(
        `SELECT source FROM rules WHERE id = ?`,
        [id],
      );
      if (!row) return { error: 'rule not found' };
      if (row.source !== 'llm') {
        return { error: `cannot edit ${row.source} rules; only source='llm' is editable here` };
      }
      const sets: string[] = [];
      const vals: (string | number)[] = [];
      const name = asString(args.name, 200);
      if (name) {
        sets.push('name = ?');
        vals.push(name);
      }
      const trigger = asString(args.trigger, 4000);
      if (trigger) {
        try {
          JSON.parse(trigger);
        } catch {
          return { error: 'trigger must be valid JSON' };
        }
        sets.push('trigger = ?');
        vals.push(trigger);
      }
      const action = asString(args.action, 4000);
      if (action) {
        try {
          JSON.parse(action);
        } catch {
          return { error: 'action must be valid JSON' };
        }
        sets.push('action = ?');
        vals.push(action);
      }
      if (typeof args.cooldown_min === 'number' || typeof args.cooldown_min === 'string') {
        sets.push('cooldown_min = ?');
        vals.push(clampInt(args.cooldown_min, 5, 1440, 60));
      }
      if (typeof args.predicted_impact_score === 'number') {
        sets.push('predicted_impact_score = ?');
        vals.push(clampNum(args.predicted_impact_score, 0, 1, 0));
      }
      if (sets.length === 0) return { error: 'no fields to update' };
      sets.push('last_refined_ts = ?');
      vals.push(Date.now());
      vals.push(id);
      const r = await db.runAsync(
        `UPDATE rules SET ${sets.join(', ')} WHERE id = ?`,
        vals,
      );
      return { id, changed: r.changes };
    });
  },
});

add({
  def: {
    name: 'disable_rule',
    description:
      'Soft-disable an LLM-generated rule (source="llm" only). Sets enabled=0 and stores a ' +
      'short reason (e.g. "negative score_delta over 14d"). Will refuse on user/seed rules.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id', 'reason'],
    },
  },
  scopes: ['nightly_nudge'],
  handler: async (args) => {
    const id = asString(args.id, 100);
    const reason = asString(args.reason, 500);
    if (!id || !reason) return { error: 'id and reason required' };
    return withDb(async (db) => {
      const row = await db.getFirstAsync<{ source: string }>(
        `SELECT source FROM rules WHERE id = ?`,
        [id],
      );
      if (!row) return { error: 'rule not found' };
      if (row.source !== 'llm') {
        return { error: `cannot disable ${row.source} rules from this scope` };
      }
      await db.runAsync(
        `UPDATE rules SET enabled = 0, disabled_reason = ?, last_refined_ts = ? WHERE id = ?`,
        [reason, Date.now(), id],
      );
      return { id, disabled: true, reason };
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

async function loadDailyRollup(date: string): Promise<unknown> {
  return withDb(async (db) => {
    const r = await db.getFirstAsync<{ data: string; productivity_score: number | null }>(
      `SELECT data, productivity_score FROM daily_rollup WHERE date = ?`,
      [date],
    );
    if (!r) return { date, note: 'no rollup for that date' };
    try {
      return { date, productivity_score: r.productivity_score, ...JSON.parse(r.data) };
    } catch {
      return { date, productivity_score: r.productivity_score, raw: r.data };
    }
  });
}

async function loadDailyRollupCompact(date: string): Promise<unknown> {
  return withDb(async (db) => {
    const r = await db.getFirstAsync<{ data: string; productivity_score: number | null }>(
      `SELECT data, productivity_score FROM daily_rollup WHERE date = ?`,
      [date],
    );
    if (!r) return { date, note: 'no rollup' };
    try {
      const p = JSON.parse(r.data) as {
        by_app?: { pkg: string; minutes: number }[];
        sleep?: { duration_min?: number };
        screen_on_minutes?: number;
      };
      const a = p.by_app?.[0];
      return {
        date,
        productivity_score: r.productivity_score,
        sleep_min: p.sleep?.duration_min,
        screen_on_min: p.screen_on_minutes,
        top_app: a?.pkg,
        top_app_min: a?.minutes,
      };
    } catch {
      return { date, productivity_score: r.productivity_score };
    }
  });
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function safeArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

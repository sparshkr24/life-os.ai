/**
 * Memory store: CRUD + scoring. Stage 12 scaffolding.
 *
 * Design invariants (enforced here, not by callers):
 *   - Every persisted memory has a non-empty embedding vector. If `embedText`
 *     returns null (cost-cap, no key, http error), `createMemory` returns null
 *     and writes nothing.
 *   - Soft-delete only. `archiveMemory` sets `archived_ts`; we never DELETE.
 *   - `last_accessed` is bumped whenever rag.ts retrieves a memory; that drives
 *     the recency component of the effective score.
 *
 * No LLM extraction here — that lands in Stage 13 (`memory/extract.ts`). This
 * file only owns persistence and the deterministic scoring formula.
 */
import type * as SQLite from 'expo-sqlite';
import { withDb } from '../db';
import type { MemoryRow, MemoryType } from '../db/schema';
import { embedText, EMBED_DIM } from './embed';

/** Lightweight uuid-v4 (no native crypto dep). Sufficient for local primary keys. */
function uuidv4(): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0');
  hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export interface MemoryInput {
  type: MemoryType;
  summary: string;
  cause?: string;
  effect?: string;
  /** [-1, 1]. */
  impact_score: number;
  /** [0, 1]. */
  confidence: number;
  tags: string[];
  source_ref?: string;
  rollup_date?: string;
  predicted_outcome?: string;
}

/** Hydrated form: embedding decoded + tags parsed. Used by rag.ts. */
export interface Memory {
  id: string;
  created_ts: number;
  updated_ts: number;
  type: MemoryType;
  summary: string;
  cause: string | null;
  effect: string | null;
  impact_score: number;
  confidence: number;
  occurrences: number;
  reinforcement: number;
  contradiction: number;
  last_accessed: number;
  decay_factor: number;
  tags: string[];
  source_ref: string | null;
  rollup_date: string | null;
  embedding: number[];
  embed_model: string;
  predicted_outcome: string | null;
  actual_outcome: string | null;
  was_correct: boolean | null;
  archived_ts: number | null;
  parent_id: string | null;
  child_ids: string[] | null;
}

/**
 * Create a new memory. Returns the memory id, or null if embedding failed
 * (cost cap, no key, http error). Caller is responsible for clamping
 * impact_score/confidence to valid ranges before calling.
 */
export async function createMemory(input: MemoryInput): Promise<string | null> {
  const summary = input.summary.trim();
  if (!summary) return null;

  // Build the embedding input: summary + cause/effect if present. Tags too,
  // so retrieval queries can hit on tag overlap even without summary match.
  const embedInput = [
    summary,
    input.cause ? `cause: ${input.cause}` : '',
    input.effect ? `effect: ${input.effect}` : '',
    input.tags.length ? `tags: ${input.tags.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const embed = await embedText(embedInput);
  if (!embed) return null;

  const id = uuidv4();
  const now = Date.now();
  const impact = clamp(input.impact_score, -1, 1);
  const confidence = clamp(input.confidence, 0, 1);

  await withDb(async (db) => {
    await db.runAsync(
      `INSERT INTO memories
        (id, created_ts, updated_ts, type, summary, cause, effect,
         impact_score, confidence, occurrences, reinforcement, contradiction,
         last_accessed, decay_factor, tags, source_ref, rollup_date,
         embedding, embed_model, predicted_outcome, actual_outcome, was_correct,
         archived_ts, parent_id, child_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?,
               ?, ?, 1, 0, 0,
               ?, 0.05, ?, ?, ?,
               ?, ?, ?, NULL, NULL,
               NULL, NULL, NULL)`,
      [
        id,
        now,
        now,
        input.type,
        summary,
        input.cause ?? null,
        input.effect ?? null,
        impact,
        confidence,
        now,
        JSON.stringify(input.tags),
        input.source_ref ?? null,
        input.rollup_date ?? null,
        JSON.stringify(embed.vector),
        embed.model,
        input.predicted_outcome ?? null,
      ],
    );
  });
  return id;
}

/** Returns active (non-archived) memories. Used by rag.ts for the cosine scan. */
export async function listActiveMemories(): Promise<Memory[]> {
  const rows = await withDb<MemoryRow[]>(async (db) => {
    return db.getAllAsync<MemoryRow>(
      `SELECT * FROM memories WHERE archived_ts IS NULL ORDER BY last_accessed DESC`,
    );
  });
  return rows.map(hydrate).filter((m): m is Memory => m !== null);
}

export async function getMemoryById(id: string): Promise<Memory | null> {
  const row = await withDb<MemoryRow | null>(async (db) => {
    return db.getFirstAsync<MemoryRow>(`SELECT * FROM memories WHERE id = ?`, [id]);
  });
  if (!row) return null;
  return hydrate(row);
}

/** Bump last_accessed on retrieved rows so recency reflects actual usage. */
export async function touchMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  await withDb(async (db) => {
    const placeholders = ids.map(() => '?').join(',');
    await db.runAsync(
      `UPDATE memories SET last_accessed = ? WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
  });
}

/** Reinforce a memory: same pattern observed again, outcome matches. */
export async function reinforceMemory(id: string): Promise<void> {
  const now = Date.now();
  await withDb(async (db) => {
    await db.runAsync(
      `UPDATE memories
         SET reinforcement = reinforcement + 1,
             occurrences   = occurrences + 1,
             confidence    = MIN(0.99, confidence + 0.05),
             updated_ts    = ?,
             last_accessed = ?
       WHERE id = ?`,
      [now, now, id],
    );
  });
}

/** Contradict a memory: outcome did not match. Confidence drops; computeEffectiveScore drops further via penalty. */
export async function contradictMemory(id: string): Promise<void> {
  const now = Date.now();
  await withDb(async (db) => {
    await db.runAsync(
      `UPDATE memories
         SET contradiction = contradiction + 1,
             confidence    = MAX(0.05, confidence - 0.10),
             updated_ts    = ?,
             last_accessed = ?
       WHERE id = ?`,
      [now, now, id],
    );
  });
}

/** Soft-delete. Reversible by setting archived_ts back to NULL if needed. */
export async function archiveMemory(id: string): Promise<void> {
  const now = Date.now();
  await withDb(async (db) => {
    await db.runAsync(
      `UPDATE memories SET archived_ts = ?, updated_ts = ? WHERE id = ?`,
      [now, now, id],
    );
  });
}

/** Set the actual outcome for a stored prediction. Used by Stage-15 self-learning. */
export async function recordPredictionOutcome(
  id: string,
  actualOutcome: string,
  wasCorrect: boolean,
): Promise<void> {
  const now = Date.now();
  await withDb(async (db) => {
    await db.runAsync(
      `UPDATE memories
         SET actual_outcome = ?,
             was_correct    = ?,
             updated_ts     = ?,
             last_accessed  = ?
       WHERE id = ?`,
      [actualOutcome, wasCorrect ? 1 : 0, now, now, id],
    );
  });
}

/**
 * Effective score: combines raw impact, reinforcement reward, contradiction
 * penalty, and a recency decay that kicks in after 7 days of disuse.
 *
 * Returns a value in [-1, 1]. Used by rag.ts re-ranking and by
 * consolidation passes (Stage 16) to flag low-score memories for archival.
 */
export function computeEffectiveScore(m: Memory): number {
  const REINFORCE_WEIGHT = 0.3;
  const CONTRADICT_PENALTY = 0.5;
  const DECAY_GRACE_DAYS = 7;

  let score = m.impact_score;
  // Reinforcement amplifies the original impact in its sign direction.
  score += m.reinforcement * REINFORCE_WEIGHT * m.impact_score;
  // Contradictions push toward zero regardless of original sign.
  score -= m.contradiction * CONTRADICT_PENALTY * Math.sign(m.impact_score || 1);

  const daysSinceAccess = (Date.now() - m.last_accessed) / 86_400_000;
  if (daysSinceAccess > DECAY_GRACE_DAYS) {
    score *= Math.exp(-m.decay_factor * (daysSinceAccess - DECAY_GRACE_DAYS));
  }
  return clamp(score, -1, 1);
}

/** Quick stats for the Profile/Settings observability surface. */
export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  byType: Record<MemoryType, number>;
  avgConfidence: number;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  return withDb(async (db) => {
    const total = (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM memories`))?.n ?? 0;
    const archived =
      (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE archived_ts IS NOT NULL`))
        ?.n ?? 0;
    const conf =
      (
        await db.getFirstAsync<{ a: number | null }>(
          `SELECT AVG(confidence) AS a FROM memories WHERE archived_ts IS NULL`,
        )
      )?.a ?? 0;
    const typeRows = await db.getAllAsync<{ type: MemoryType; n: number }>(
      `SELECT type, COUNT(*) AS n FROM memories WHERE archived_ts IS NULL GROUP BY type`,
    );
    const byType: Record<MemoryType, number> = {
      pattern: 0,
      causal: 0,
      prediction: 0,
      habit: 0,
    };
    for (const r of typeRows) byType[r.type] = r.n;
    return {
      total,
      active: total - archived,
      archived,
      byType,
      avgConfidence: conf,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────────────

function hydrate(row: MemoryRow): Memory | null {
  let embedding: number[];
  let tags: string[];
  let childIds: string[] | null;
  try {
    embedding = JSON.parse(row.embedding) as number[];
    tags = JSON.parse(row.tags) as string[];
    childIds = row.child_ids ? (JSON.parse(row.child_ids) as string[]) : null;
  } catch (e) {
    console.warn(`[memory] hydrate failed for ${row.id}:`, (e as Error).message);
    return null;
  }
  if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
    console.warn(`[memory] hydrate: bad embedding shape for ${row.id}`);
    return null;
  }
  return {
    id: row.id,
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
    type: row.type,
    summary: row.summary,
    cause: row.cause,
    effect: row.effect,
    impact_score: row.impact_score,
    confidence: row.confidence,
    occurrences: row.occurrences,
    reinforcement: row.reinforcement,
    contradiction: row.contradiction,
    last_accessed: row.last_accessed,
    decay_factor: row.decay_factor,
    tags,
    source_ref: row.source_ref,
    rollup_date: row.rollup_date,
    embedding,
    embed_model: row.embed_model,
    predicted_outcome: row.predicted_outcome,
    actual_outcome: row.actual_outcome,
    was_correct: row.was_correct === null ? null : row.was_correct === 1,
    archived_ts: row.archived_ts,
    parent_id: row.parent_id,
    child_ids: childIds,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Suppress unused-import lint for SQLite type used only via withDb generic.
type _Unused = SQLite.SQLiteDatabase;

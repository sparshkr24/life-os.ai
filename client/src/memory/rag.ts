/**
 * RAG retrieval. Stage 12 scaffolding.
 *
 * Pipeline (stateless, callable from any LLM stage):
 *   1. Build a query string from the decision context.
 *   2. Embed it via `embedText` (cost-capped, can return null).
 *   3. Scan all active memories, compute cosine similarity in-process.
 *   4. Re-rank with similarity·0.5 + recency·0.2 + |impact|·0.15 + confidence·0.15.
 *   5. Touch the top-k (bumps last_accessed → drives recency next time).
 *
 * `retrieveContext` returns null on embed failure so callers can fall back to
 * the pre-RAG path (Stage 13 wiring will respect this — RAG augments, never
 * gates, the existing nightly/chat flows).
 *
 * Performance budget: ≤30 ms for top-5 over 1 K active memories on Pixel-class
 * hardware. Re-evaluate when active count crosses 5 K.
 */
import { cosineSim, embedText } from './embed';
import { listActiveMemories, touchMemories, type Memory } from './store';

export type DecisionType =
  | 'nightly_consolidation'
  | 'smart_nudge'
  | 'chat'
  | 'rule_generation'
  | 'prediction_update';

export interface RagQuery {
  decisionType: DecisionType;
  /** Natural-language seed for the query embedding. Required. */
  queryText: string;
  /** Tag overlap is part of re-ranking but never a hard filter. */
  preferredTags?: string[];
  /** Default 5. Per-decision-type targets in DEFAULT_K below. */
  k?: number;
  /** If true, only memories with confidence ≥ 0.5 are eligible. */
  highConfidenceOnly?: boolean;
}

export interface RetrievedMemory {
  memory: Memory;
  similarity: number;
  rerankScore: number;
}

export interface RagResult {
  decisionType: DecisionType;
  query: string;
  memories: RetrievedMemory[];
  /** Markdown block ready to drop into a system/user prompt. Empty if no hits. */
  contextBlock: string;
  /** Total active memories scanned. */
  scanned: number;
  /** Wall-clock ms for the cosine pass + re-rank (excludes embedding fetch). */
  rankMs: number;
  /** True if the embedding call succeeded. False ⇒ caller should fall back. */
  embedded: boolean;
}

const DEFAULT_K: Record<DecisionType, number> = {
  nightly_consolidation: 12,
  rule_generation: 18,
  chat: 6,
  smart_nudge: 4,
  prediction_update: 6,
};

export async function retrieveContext(query: RagQuery): Promise<RagResult> {
  const k = query.k ?? DEFAULT_K[query.decisionType];
  const queryText = query.queryText.trim();

  if (!queryText) {
    return emptyResult(query.decisionType, queryText, 0, 0, false);
  }

  const embed = await embedText(queryText);
  if (!embed) {
    // Caller falls back to non-RAG path. We do NOT throw.
    return emptyResult(query.decisionType, queryText, 0, 0, false);
  }

  const memories = await listActiveMemories();
  const filtered = query.highConfidenceOnly
    ? memories.filter((m) => m.confidence >= 0.5)
    : memories;

  const t0 = Date.now();
  const ranked = filtered
    .map((m) => {
      const sim = cosineSim(embed.vector, m.embedding);
      const rerank = computeRerankScore(m, sim, query.preferredTags ?? []);
      return { memory: m, similarity: sim, rerankScore: rerank };
    })
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, k);
  const rankMs = Date.now() - t0;

  // Bump last_accessed so the recency component reflects real usage.
  if (ranked.length > 0) {
    await touchMemories(ranked.map((r) => r.memory.id));
  }

  return {
    decisionType: query.decisionType,
    query: queryText,
    memories: ranked,
    contextBlock: assembleContextBlock(ranked),
    scanned: filtered.length,
    rankMs,
    embedded: true,
  };
}

/**
 * Re-rank: similarity dominates, then recency, magnitude of impact, and
 * confidence. Tag overlap (when caller supplied `preferredTags`) is a small
 * additive bonus — never a hard filter, since semantic similarity already
 * surfaces tag-related memories via embedding.
 */
function computeRerankScore(m: Memory, similarity: number, preferredTags: string[]): number {
  const SIM_W = 0.5;
  const RECENCY_W = 0.2;
  const IMPACT_W = 0.15;
  const CONF_W = 0.15;
  const TAG_BONUS = 0.05;

  const daysOld = (Date.now() - m.last_accessed) / 86_400_000;
  const recency = Math.exp(-daysOld / 30); // half-life ~21 days

  let score =
    similarity * SIM_W +
    recency * RECENCY_W +
    Math.abs(m.impact_score) * IMPACT_W +
    m.confidence * CONF_W;

  if (preferredTags.length > 0 && m.tags.length > 0) {
    const overlap = m.tags.filter((t) => preferredTags.includes(t)).length;
    if (overlap > 0) {
      score += (overlap / preferredTags.length) * TAG_BONUS;
    }
  }
  return score;
}

/** Markdown block. Empty string when no memories — callers can branch on length. */
function assembleContextBlock(ranked: RetrievedMemory[]): string {
  if (ranked.length === 0) return '';
  const lines: string[] = ['## Relevant Memories'];
  for (const r of ranked) {
    const m = r.memory;
    const impactPct = (m.impact_score * 100).toFixed(0);
    const confPct = (m.confidence * 100).toFixed(0);
    const sign = m.impact_score >= 0 ? '+' : '';
    lines.push('');
    lines.push(`### ${m.type}: ${m.summary}`);
    lines.push(`- impact ${sign}${impactPct}% · confidence ${confPct}% · seen ${m.occurrences}× · sim ${r.similarity.toFixed(2)}`);
    if (m.cause && m.effect) lines.push(`- chain: ${m.cause} → ${m.effect}`);
    if (m.tags.length > 0) lines.push(`- tags: ${m.tags.join(', ')}`);
    if (m.predicted_outcome && m.was_correct !== null) {
      lines.push(
        `- prediction: "${m.predicted_outcome}" → ${m.was_correct ? 'correct' : 'incorrect'}`,
      );
    }
  }
  return lines.join('\n');
}

function emptyResult(
  decisionType: DecisionType,
  query: string,
  scanned: number,
  rankMs: number,
  embedded: boolean,
): RagResult {
  return {
    decisionType,
    query,
    memories: [],
    contextBlock: '',
    scanned,
    rankMs,
    embedded,
  };
}

/**
 * Thin wrapper that turns text into a vector via the LLM router. The router
 * handles cost cap, key check, provider dispatch, and `llm_calls` logging.
 *
 * Callers see one of two outcomes:
 *   - `EmbedResult` — success, persist alongside the memory row
 *   - `null`        — skipped or failed (already logged by router)
 *
 * Returning null forces callers to skip the memory write — never persist a
 * row without an embedding (the cosine scan in rag.ts requires it).
 */
import { runEmbedTask } from '../llm/router';
import { DEFAULT_TASK_MODELS, findModel } from '../llm/models';

const embedModelId = DEFAULT_TASK_MODELS.embed;
const embedModel = findModel(embedModelId);

export const EMBED_MODEL = embedModelId;
export const EMBED_DIM = embedModel?.embedDim ?? 1536;

export interface EmbedResult {
  vector: number[];
  model: string;
  inTokens: number;
  costUsd: number;
}

export async function embedText(text: string): Promise<EmbedResult | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const r = await runEmbedTask(trimmed);
  if (r.kind !== 'ok') {
    console.log(
      `[embed] skip: ${r.kind === 'skipped' ? r.reason : `failed: ${r.reason}`}`,
    );
    return null;
  }
  return {
    vector: r.response.vector,
    model: r.response.modelId,
    inTokens: r.response.inTokens,
    costUsd: r.response.costUsd,
  };
}

/** Cosine similarity. Both vectors must be the same length, non-zero. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

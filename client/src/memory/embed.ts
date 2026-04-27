/**
 * OpenAI embeddings for the memory store. text-embedding-3-small (1536-dim).
 *
 * Every call:
 *   1. checks the daily LLM cost cap (same wall as smartNudge / nightly / chat),
 *   2. requires an OpenAI API key in secure store,
 *   3. logs the call to `llm_calls` with purpose='embed' (ok or error path).
 *
 * Returns `null` on cost-cap-hit, missing-key, or HTTP error. Callers must
 * handle null and skip the memory write — never persist a row without an
 * embedding (the cosine scan in rag.ts requires it).
 */
import { withDb } from '../db';
import { getOpenAiKey, loadSnapshot } from '../secure/keys';
import { sumTodayLlmCostUsd } from '../brain/smartNudge';

export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIM = 1536;

// $0.02 per 1M tokens (April 2026). One embedding ≈ 10–500 tokens depending on
// summary length; treat as input tokens, no output.
const PRICE_INPUT_PER_M = 0.02;

const URL = 'https://api.openai.com/v1/embeddings';

export interface EmbedResult {
  vector: number[];
  model: string;
  inTokens: number;
  costUsd: number;
}

export async function embedText(text: string): Promise<EmbedResult | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const snapshot = await loadSnapshot();
  const todayCost = await sumTodayLlmCostUsd();
  if (todayCost >= snapshot.dailyCapUsd) {
    console.log(`[embed] skip: cost_cap ($${todayCost.toFixed(4)})`);
    return null;
  }

  const apiKey = await getOpenAiKey();
  if (!apiKey) {
    console.log('[embed] skip: no OPENAI_API_KEY');
    return null;
  }

  const startedAt = Date.now();
  const body = JSON.stringify({ model: EMBED_MODEL, input: trimmed });

  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      await logEmbedCall(startedAt, null, 0, false, errText.slice(0, 500), trimmed, '');
      console.warn(`[embed] http ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
      model: string;
    };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
      await logEmbedCall(startedAt, null, 0, false, 'bad shape', trimmed, JSON.stringify(json).slice(0, 500));
      return null;
    }
    const inTok = json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0;
    const costUsd = (inTok * PRICE_INPUT_PER_M) / 1_000_000;
    await logEmbedCall(startedAt, inTok, costUsd, true, null, trimmed, `dim=${vec.length}`);
    return { vector: vec, model: json.model || EMBED_MODEL, inTokens: inTok, costUsd };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logEmbedCall(startedAt, null, 0, false, msg.slice(0, 500), trimmed, '');
    console.warn('[embed] fetch failed:', msg);
    return null;
  }
}

async function logEmbedCall(
  ts: number,
  inTokens: number | null,
  costUsd: number,
  ok: boolean,
  error: string | null,
  request: string,
  response: string,
): Promise<void> {
  try {
    await withDb(async (db) => {
      await db.runAsync(
        `INSERT INTO llm_calls
          (ts, purpose, model, in_tokens, out_tokens, cost_usd, ok, error, request, response)
         VALUES (?, 'embed', ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          ts,
          EMBED_MODEL,
          inTokens,
          costUsd,
          ok ? 1 : 0,
          error,
          request.slice(0, 1000),
          response.slice(0, 500),
        ],
      );
    });
  } catch (e) {
    // Never let logging failure break the embedding path.
    console.warn('[embed] logLlmCall failed:', (e as Error).message);
  }
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

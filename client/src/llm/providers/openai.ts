/**
 * OpenAI direct provider — chat (via OpenAiCompatChatProvider) + embeddings.
 *
 * Embeddings are the only reason to keep OpenAI as a separate ProviderId once
 * the user moves chat to OpenRouter. OpenRouter doesn't proxy embeddings.
 */
import { findModel } from '../models';
import type { EmbedRequest, EmbedResponse, ProviderId } from '../types';
import type { EmbeddingProvider } from './base';
import { OpenAiCompatChatProvider } from './openaiCompat';

export const openaiChat = new OpenAiCompatChatProvider({
  id: 'openai',
  url: 'https://api.openai.com/v1/chat/completions',
});

interface OpenAiEmbedWire {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string };
}

class OpenAiEmbedProvider implements EmbeddingProvider {
  readonly id: ProviderId = 'openai';

  async embed(model: string, apiKey: string, req: EmbedRequest): Promise<EmbedResponse> {
    const text = req.text.trim();
    if (text.length === 0) throw new Error('empty embed input');
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`http ${res.status}: ${body.slice(0, 300)}`);
    let parsed: OpenAiEmbedWire;
    try {
      parsed = JSON.parse(body) as OpenAiEmbedWire;
    } catch {
      throw new Error('malformed embed response');
    }
    if (parsed.error?.message) throw new Error(parsed.error.message);
    const vec = parsed.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) throw new Error('embed: empty vector');
    const m = findModel(model);
    if (m?.embedDim && vec.length !== m.embedDim) {
      throw new Error(`embed: dim mismatch ${vec.length} vs ${m.embedDim}`);
    }
    const inTok = parsed.usage?.prompt_tokens ?? parsed.usage?.total_tokens ?? 0;
    const costUsd = m ? (inTok * m.pricePerMInput) / 1_000_000 : 0;
    return {
      vector: vec,
      inTokens: inTok,
      costUsd,
      modelId: parsed.model ?? model,
    };
  }
}

export const openaiEmbed = new OpenAiEmbedProvider();

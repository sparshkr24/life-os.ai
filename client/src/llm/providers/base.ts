/**
 * Provider interfaces. SOLID's Interface Segregation:
 *  - `ChatProvider`     — talks the chat completions / messages API
 *  - `EmbeddingProvider`— talks the embeddings API
 * A vendor implementation can satisfy one or both.
 *
 * The router and callers depend on these interfaces, never on a concrete
 * provider class. New vendors plug in via `providers/registry.ts`.
 */
import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderId,
} from '../types';

export interface ChatProvider {
  readonly id: ProviderId;
  /** Send a chat request. `model` is the canonical id from MODELS. */
  chat(model: string, apiKey: string, req: ChatRequest): Promise<ChatResponse>;
}

export interface EmbeddingProvider {
  readonly id: ProviderId;
  embed(model: string, apiKey: string, req: EmbedRequest): Promise<EmbedResponse>;
}

/**
 * LLM abstraction layer — common types.
 *
 * Design (SOLID):
 *  - **S**ingle responsibility: each `Provider` implementation talks to ONE
 *    vendor's HTTP API. No business logic.
 *  - **O**pen/closed: adding a 5th vendor is a new file in `providers/` +
 *    one line in `providers/registry.ts`. No edits to the router or callers.
 *  - **L**iskov: every chat provider returns the same `ChatResponse` shape
 *    regardless of vendor. Tool calls normalize to a single `ToolCall` type.
 *  - **I**nterface segregation: chat and embedding are separate interfaces.
 *    A provider may implement one, the other, or both.
 *  - **D**ependency inversion: callers depend on `runChatTask(taskKind, …)`
 *    not on a concrete provider. The router resolves provider+model+key at
 *    call time from the user's `task_assignments` config.
 */

/** Provider IDs. Add new providers here AND in `providers/registry.ts`. */
export type ProviderId = 'openai' | 'openrouter';

/**
 * Every place the app calls an LLM is one of these task kinds. Adding a new
 * task = add a literal here + a default in `assignments.ts`. Callers reference
 * their task by kind, never by provider/model.
 */
export type TaskKind =
  | 'nightly'         // Stage 8 / v3 Phase E — nightly tool-calling session: extract+verify+consolidate+app-cat+profile
  | 'chat'            // Stage 9 — user-facing chat with tool calls
  | 'smart_nudge'     // Stage 7 — 15-min decision to nudge or stay silent
  | 'consolidation'   // Reserved — weekly memory merge (future)
  | 'rule_generation' // Stage 14 — weekly LLM-generated rules (future)
  | 'proactive_question' // v7 — 90-min proactive question pass (gpt-4o-mini class)
  | 'embed';          // Stage 12 — text → vector for memory store

/** Capability flags a model declares so the router can validate assignments. */
export interface ModelCapabilities {
  /** Supports OpenAI-style function calling / Anthropic tool_use. */
  toolCalls: boolean;
  /** Reliably honours a JSON-only output instruction. */
  jsonMode: boolean;
  /** Long-context useful for nightly rebuilds (>= 100k tokens). */
  longContext: boolean;
}

export interface ModelDescriptor {
  id: string;                  // canonical model id, e.g. 'gpt-4o-mini'
  label: string;               // UI label, e.g. 'GPT-4o Mini'
  provider: ProviderId;
  /** USD per 1M input tokens. */
  pricePerMInput: number;
  /** USD per 1M output tokens. 0 for embed-only models. */
  pricePerMOutput: number;
  capabilities: ModelCapabilities;
  /** True for embedding models (separate router path). */
  isEmbedding?: boolean;
  /** Output dim for embedding models. */
  embedDim?: number;
}

// ────────────────────────────────────────────────────────────── chat shapes

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  /** Text content. For tool_calls / tool results, see `toolCalls` / `toolResults`. */
  content: string;
  /** Assistant-emitted tool calls (round-tripped back unchanged). */
  toolCalls?: ToolCall[];
  /** When role='tool', the result of a previously-emitted tool call. */
  toolResultFor?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Already JSON-parsed input. */
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  /** System instruction prepended before the message list. */
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Hard cap on output tokens. Defaults to 1024. */
  maxOutputTokens?: number;
  /** Optional sampling temperature. Defaults to provider default. */
  temperature?: number;
  /** When true, instruct the model to return a single JSON object. */
  jsonMode?: boolean;
}

export interface ChatUsage {
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

export type StopReason = 'end' | 'tool_use' | 'length' | 'error';

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: ChatUsage;
  /** Raw model id the vendor reported (may differ from request.model). */
  modelId: string;
  /** Raw response body, truncated, for debug logs. */
  rawForLog: string;
}

// ───────────────────────────────────────────────────────── embedding shapes

export interface EmbedRequest {
  text: string;
}

export interface EmbedResponse {
  vector: number[];
  inTokens: number;
  costUsd: number;
  modelId: string;
}

// ──────────────────────────────────────────────────────── caller-side types

/**
 * Result of `runChatTask` — discriminated union so the type system forces
 * callers to handle skip and failure cases. No exceptions thrown from the
 * router.
 */
export type ChatTaskResult =
  | { kind: 'ok'; response: ChatResponse }
  | { kind: 'skipped'; reason: 'cap_exceeded' | 'no_key' | 'no_assignment' }
  | { kind: 'failed'; reason: string };

export type EmbedTaskResult =
  | { kind: 'ok'; response: EmbedResponse }
  | { kind: 'skipped'; reason: 'cap_exceeded' | 'no_key' | 'no_assignment' }
  | { kind: 'failed'; reason: string };

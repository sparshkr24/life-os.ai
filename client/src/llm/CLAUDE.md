# CLAUDE.md — `client/src/llm/`

## Responsibility

Provider-agnostic LLM dispatch. Every chat and embedding call in the app goes through `runChatTask` / `runEmbedTask` here. No other file calls `fetch` against an LLM endpoint directly.

This folder owns:
- The model catalogue (`models.ts`)
- Each provider's HTTP wire format (`providers/`)
- API key storage (`keys.ts`)
- Which model handles which task (`assignments.ts`)
- Cost tracking and the daily cap (`ledger.ts`)
- The gate that decides whether a call should run (`router.ts`)

## Files

| File | Purpose |
|---|---|
| `types.ts` | `ProviderId` (`'openai' \| 'anthropic' \| 'minimax' \| 'deepseek'`), `TaskKind` (`'nightly' \| 'chat' \| 'smart_nudge' \| 'extract' \| 'consolidation' \| 'rule_generation' \| 'embed'`), `ModelDescriptor`, `ChatMessage`, `ToolDefinition`, `ToolCall`, `ChatRequest`, `ChatResponse`, `EmbedRequest`, `EmbedResponse`. Discriminated unions: `ChatTaskResult = {kind:'ok'} \| {kind:'skipped',reason} \| {kind:'failed',reason}`, same shape for `EmbedTaskResult`. |
| `models.ts` | The catalogue. `MODELS: ModelDescriptor[]` — 13 entries (GPT-4o-mini, GPT-4o, Claude Sonnet, Claude Haiku, MiniMax M2, DeepSeek V3, text-embedding-3-small, etc.). `findModel(id)`, `modelsForProvider`, `chatModels`, `embeddingModels`. `DEFAULT_TASK_MODELS` maps every `TaskKind` to a fallback. `ASSIGNABLE_TASKS` excludes `'embed'` (embedding is fixed). `TASK_LABELS` + `TASK_DESCRIPTIONS` drive the AiModels UI. |
| `keys.ts` | `getProviderKey`, `setProviderKey`, `deleteProviderKey`, `listProviderKeys`. Storage: `LLM_KEY_<PROVIDER>` in `expo-secure-store`. Auto-migrates legacy `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` on first read. `ProviderKeyStatus = {provider, hasKey, tail}` (last 4 chars only). |
| `assignments.ts` | `loadAssignments`, `saveAssignments`, `setAssignment(task, modelId)`, `resolveAssignment(task) → ModelDescriptor \| null`. Persisted in `schema_meta` row `key='task_assignments'` as JSON. Falls back to `DEFAULT_TASK_MODELS[task]`. |
| `ledger.ts` | `sumTodayLlmCostUsd()` + `logLlmCall(LlmLogRow)`. Single source of truth — no other file inserts into `llm_calls`. Router calls `logLlmCall` before returning so `lastLlmCallId()` is safe in the same tick. |
| `router.ts` | `DAILY_COST_CAP_USD = 0.30`. `runChatTask(task, req)` and `runEmbedTask(req)`. Pipeline: resolve model → check cost cap → get provider key → call provider → log → return. **Never throws.** Returns `{kind:'ok'\|'skipped'\|'failed'}`. |
| `providers/base.ts` | Two interfaces: `ChatProvider { chat(req, key) → ChatResponse }` and `EmbeddingProvider { embed(req, key) → EmbedResponse }`. Errors from impls bubble up as `kind:'failed'` — impls must not swallow them. |
| `providers/openaiCompat.ts` | `OpenAiCompatChatProvider` — shared base for any vendor using the OpenAI `/v1/chat/completions` shape. Configurable `url` + `extraHeaders`. Translates `ChatMessage[]` to wire format, parses `tool_calls`, maps `finish_reason → stopReason`. |
| `providers/openai.ts` | `openaiChat` (OpenAiCompatChatProvider at `api.openai.com`). `OpenAiEmbedProvider` — validates returned vector length matches `embedDim`. |
| `providers/anthropic.ts` | `AnthropicChatProvider` at `api.anthropic.com/v1/messages`. Handles tool translation (`input_schema`), adjacent `tool` message merging, and `tool_use` block parsing. |
| `providers/minimax.ts` | OpenAI-compat instance at `api.minimax.io/v1/text/chatcompletion_v2`. |
| `providers/deepseek.ts` | OpenAI-compat instance at `api.deepseek.com/chat/completions`. |
| `providers/registry.ts` | `CHAT: Record<ProviderId, ChatProvider>` and `EMBED: Partial<Record<ProviderId, EmbeddingProvider>>`. `getChatProvider`, `getEmbedProvider`, `ALL_PROVIDERS`, `PROVIDER_LABELS`, `PROVIDER_KEY_HINT`. |

## Adding a new provider

1. Add the id to `ProviderId` in `types.ts`.
2. Create `providers/<vendor>.ts` — instantiate `OpenAiCompatChatProvider` if the vendor speaks that shape, otherwise implement `ChatProvider` directly.
3. Register in `providers/registry.ts` (`CHAT` map + `PROVIDER_LABELS` + `PROVIDER_KEY_HINT` + `ALL_PROVIDERS`).
4. Add at least one `ModelDescriptor` in `models.ts`.

The AiModels UI picks up the new provider automatically.

## Hard rules

1. **Never call `fetch` against an LLM endpoint outside `providers/`.** All calls go through `runChatTask` / `runEmbedTask`.
2. **Never insert into `llm_calls` outside `ledger.ts`.** Cost accounting must stay coherent with the cap.
3. **Never throw from `router.ts`.** Return discriminated unions. Callers handle all three outcomes.
4. **Embeddings stay on `text-embedding-3-small`.** Switching is a re-embed migration, not a config change.
5. **`ChatMessage` and `ToolDefinition` are provider-neutral.** Provider adapters are the only place that knows vendor-specific shapes.

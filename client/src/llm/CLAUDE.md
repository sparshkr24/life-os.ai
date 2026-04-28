# CLAUDE.md — `client/src/llm/`

## Responsibility

Provider-agnostic LLM dispatch. Every chat or embedding call in the app
goes through `runChatTask` / `runEmbedTask` here. This folder owns:

- **What** the catalogue of usable models is (`models.ts`).
- **How** each provider's HTTP wire format is shaped (`providers/`).
- **Where** API keys live (`keys.ts`, fronting `expo-secure-store`).
- **Which** model a given task uses right now (`assignments.ts`,
  persisted in `schema_meta.task_assignments` JSON).
- **How much** has been spent today and how that's logged
  (`ledger.ts`, single source of truth for `llm_calls` inserts and the
  $0.30/day cap).
- **Whether** a call should run at all (`router.ts`, the gate).

Callers never call `fetch` against an LLM endpoint directly. They never
call `SecureStore.getItemAsync` for an LLM key. They never sum
`llm_calls.cost_usd`. Those rules are enforced by code review, not by
language tooling — please respect them.

## Files

| File | Purpose |
|---|---|
| `types.ts` | `ProviderId` (`'openai' \| 'anthropic' \| 'minimax' \| 'deepseek'`), `TaskKind` (`'nightly' \| 'chat' \| 'smart_nudge' \| 'extract' \| 'consolidation' \| 'rule_generation' \| 'embed'`), `ModelDescriptor` (`{id, provider, kind, label, capabilities, contextWindow, pricePerMInput, pricePerMOutput, embedDim?}`), `ChatMessage` (`role: 'user' \| 'assistant' \| 'tool'`, optional `toolCalls` on assistant, `toolResultFor` on tool), `ToolDefinition` (`{name, description, parameters: JSON schema}` — provider-neutral; each provider's adapter translates), `ToolCall`, `ChatRequest`/`ChatResponse` (`{text, toolCalls, stopReason, usage:{inTokens,outTokens,costUsd}, modelId, rawForLog}`), `EmbedRequest`/`EmbedResponse`. Discriminated unions: `ChatTaskResult = {kind:'ok',response} \| {kind:'skipped',reason} \| {kind:'failed',reason}`, same shape for `EmbedTaskResult`. |
| `models.ts` | The catalogue. `MODELS: ModelDescriptor[]` with 13 entries today (GPT-4o-mini, GPT-4o, claude-sonnet-4-5, claude-haiku, MiniMax M2 chat/reasoning, DeepSeek V3 chat/coder, OpenAI text-embedding-3-small, etc.). `findModel(id)`, `modelsForProvider(p)`, `chatModels()`, `embeddingModels()`. `DEFAULT_TASK_MODELS` maps every `TaskKind` to a fallback id. `ASSIGNABLE_TASKS` excludes `'embed'` (embedding is fixed to `text-embedding-3-small` because that's the only dim our `memories.embedding` rows are built for). `TASK_LABELS` + `TASK_DESCRIPTIONS` drive the AiModels routing matrix UI. |
| `keys.ts` | `getProviderKey/setProviderKey/deleteProviderKey/listProviderKeys`. Storage namespace: `LLM_KEY_<PROVIDER>` in `expo-secure-store`. On first read, auto-migrates legacy keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) into the new namespace. `ProviderKeyStatus` is `{provider, hasKey, tail}` — `tail` is the last 4 chars only. |
| `assignments.ts` | `loadAssignments() → TaskAssignmentMap` (partial map `TaskKind → modelId`), `saveAssignments`, `setAssignment(task, modelId)`, `resolveAssignment(task) → ModelDescriptor \| null`. Persists in `schema_meta` row `key='task_assignments'` as JSON. `resolveAssignment` falls back to `DEFAULT_TASK_MODELS[task]`; returns `null` only when both the user pick and the default are absent from the catalogue (i.e. someone deleted a `MODELS` entry mid-flight). |
| `ledger.ts` | `sumTodayLlmCostUsd()` (local-day midnight, same window as the v2 cost cap), `logLlmCall(LlmLogRow)`. The router calls `logLlmCall` synchronously *before* it returns to the caller, so `lastLlmCallId()` reads from the DB cleanly in the same tick (used by smart-nudge to fk the row into `nudges_log`). Single source of truth — no other file inserts into `llm_calls`. |
| `router.ts` | `DAILY_COST_CAP_USD = 0.30`. `runChatTask(task, req)` and `runEmbedTask(req)`. Pipeline: resolve assignment → check cost cap → check provider key → call provider → log → return. **Never throws.** Skips are reasons (`'no_model' \| 'no_key' \| 'cap_exceeded'`), failures are HTTP / shape errors (the router still logs them with `ok=0`). `summarizeRequest(req)` builds the compact log line stored in `llm_calls.request`. |
| `providers/base.ts` | Two interfaces: `ChatProvider { chat(req, key) → ChatResponse }` and `EmbeddingProvider { embed(req, key) → EmbedResponse }`. Each provider impl is a class implementing one of these. Errors thrown from impls bubble up as `kind:'failed'` from the router; impls should not swallow errors. |
| `providers/openaiCompat.ts` | `OpenAiCompatChatProvider` — shared base for any vendor whose chat API is the OpenAI `/v1/chat/completions` shape (OpenAI itself, MiniMax, DeepSeek). Configurable `url` + `extraHeaders`. Translates `ChatMessage[]` to wire format (system message prepended; assistant with `toolCalls` → `tool_calls`; `role='tool'` → `{role:'tool', tool_call_id, content}`), parses `choices[0].message.tool_calls` into normalized `ToolCall[]`, maps `finish_reason` → `stopReason`. |
| `providers/openai.ts` | `openaiChat` (instance of `OpenAiCompatChatProvider` pointing at `https://api.openai.com/v1/chat/completions`). `OpenaiEmbed` class implementing `EmbeddingProvider` against `/v1/embeddings`; validates returned vector length matches `embedDim` from `MODELS`. |
| `providers/anthropic.ts` | `AnthropicChatProvider` against `https://api.anthropic.com/v1/messages`. `anthropic-version: 2023-06-01`. Tools translated to `{name, description, input_schema}`. Message conversion: skips system role (passed at top level), merges adjacent `tool` messages into a single user message whose `content` is an array of `tool_result` blocks, assistant with `toolCalls` becomes `content` array with `text` + `tool_use` blocks. Parses response `content` blocks (`text` \| `tool_use`). |
| `providers/minimax.ts` | OpenAI-compat instance pointing at `https://api.minimax.io/v1/text/chatcompletion_v2`. |
| `providers/deepseek.ts` | OpenAI-compat instance pointing at `https://api.deepseek.com/chat/completions`. |
| `providers/registry.ts` | `CHAT: Record<ProviderId, ChatProvider>` and `EMBED: Partial<Record<ProviderId, EmbeddingProvider>>`. `getChatProvider(p)`, `getEmbedProvider(p)`. `ALL_PROVIDERS`, `PROVIDER_LABELS`, `PROVIDER_KEY_HINT` (placeholder text for the AiModels UI). |

## Adding a new provider

1. Add the id to `ProviderId` in `types.ts`.
2. Add a `ChatProvider` impl in `providers/<vendor>.ts`. If the vendor speaks
   the OpenAI chat shape, instantiate `OpenAiCompatChatProvider`; else write
   a class with a `chat()` method returning a `ChatResponse`.
3. Register it in `providers/registry.ts` (`CHAT` map + `PROVIDER_LABELS` +
   `PROVIDER_KEY_HINT` + `ALL_PROVIDERS`).
4. Add at least one `ModelDescriptor` for the provider in `models.ts`.

That's it. No other file in the repo needs to change. The AiModels UI
picks up the new provider automatically because it iterates
`ALL_PROVIDERS` and `chatModels()`.

## Hard rules

1. **Never call `fetch` against an LLM endpoint outside `providers/`.** If a
   caller wants to talk to an LLM, it goes through `runChatTask` /
   `runEmbedTask`.
2. **Never insert into `llm_calls` outside `ledger.ts`.** Cost accounting
   must stay coherent with the cap.
3. **Never throw from `router.ts`.** Return discriminated unions. Callers
   handle `kind === 'skipped'` and `kind === 'failed'` explicitly.
4. **Embeddings stay on `text-embedding-3-small`.** `memories.embedding`
   rows are 1536-dim by `embed_model` design (see root CLAUDE.md
   Stage-12 invariants). Switching the embed model is a re-embed
   migration, not an assignment toggle.
5. **`ChatMessage` and `ToolDefinition` are provider-neutral.** Each
   provider's adapter is the only place that knows about
   `tool_calls` / `input_schema` / `tool_use` block formats. Never leak
   vendor-specific shapes upward.

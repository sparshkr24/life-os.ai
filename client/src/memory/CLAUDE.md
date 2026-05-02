# CLAUDE.md — `client/src/memory/`

## Responsibility

Memory store, retrieval, and maintenance. This is what makes the app get smarter over time.

The nightly brain extracts patterns from raw events and stores them here as structured memories with embeddings. Every future AI call (chat, profile rebuild, nudge generation) searches this store to retrieve only the most relevant context — rather than sending everything.

## Files

| File | Role |
|---|---|
| `embed.ts` | Wraps `runEmbedTask` from `llm/router.ts`. Returns `EmbedResult` or `null`. Exports `embedText`, `cosineSim`, `EMBED_DIM=1536`, `EMBED_MODEL`. Returns null on cap/no-key/failure — callers must skip the write. |
| `store.ts` | CRUD + scoring. `createMemory(MemoryInput)` embeds + inserts atomically (returns null on embed failure — never persists without embedding). `listActiveMemories`, `getMemoryById`, `touchMemories` (bumps `last_accessed`), `reinforceMemory` (`confidence = MIN(0.99, confidence + 0.05)`), `contradictMemory` (`confidence = MAX(0.05, confidence − 0.10)`), `archiveMemory` (sets `archived_ts`), `recordPredictionOutcome`, `getMemoryStats`. `computeEffectiveScore(Memory)` = raw impact + reinforcement·0.3·impact − contradiction·0.5·sign(impact), with exponential recency decay after 7 days idle. Rows with bad embedding shape are silently skipped during hydration. |
| `rag.ts` | `retrieveContext(RagQuery) → RagResult`. Embeds query, scans `listActiveMemories()`, re-ranks by `0.5·sim + 0.2·recency + 0.15·|impact| + 0.15·confidence` (+ small tag-overlap bonus), touches top-k. Per-decision-type k defaults: nightly=12, rule_generation=18, chat=6, prediction_update=6. Returns `{embedded:false, memories:[]}` on embed failure so callers fall back gracefully. Builds a markdown `contextBlock` ready to inject into any prompt. |
| `maintenance.ts` | `runMemoryMaintenance() → MaintenanceReport` — deterministic SQL safety net. Called from `brain/nightly.ts` after the LLM tool loop. Idempotent (every UPDATE includes `archived_ts IS NULL`). Soft-archives 4 buckets: (1) failed predictions never reinforced, (2) consistently disproven (`contradiction≥3 AND contradiction≥2·reinforcement`), (3) confidence<0.10 with no reinforcement, (4) consolidation children whose parent is ≥14d old. Logs counts, does not persist the report. |

## Callers

- `brain/nightly.ts:runMemoryPass` → loads raw events + prior profile + shaky memories, prompts LLM to call memory tools, then calls `runMemoryMaintenance()`.
- `brain/nightly.ts:runProfilePass` → reads top-25 active memories by `|impact|·confidence` to ground profile rebuild. Read-only.
- `brain/nightly.ts:runNudgePass` → reads top-30 actionable memories (causal/habit/prediction with `|impact|≥0.15` AND `confidence≥0.5`) to seed rule creation.
- `brain/chat.ts` → `retrieveContext({decisionType:'chat', queryText: lastUserMessage, k:6})` — appends `contextBlock` to the system prompt.
- `brain/predictiveInsights.ts` → `retrieveContext({decisionType:'prediction_update', k:5})` for the rollup predictive tile.

## Hard rules

1. **Never persist a memory without an embedding.** `createMemory` enforces this — if `embedText` returns null, the function returns null.
2. **Soft-delete only.** Use `archiveMemory`. No `DELETE FROM memories` anywhere.
3. **Embedding model is pinned to `text-embedding-3-small` (1536-dim).** Switching requires a re-embed migration across all existing rows.
4. **No raw events through this module.** Memories are derived from rollups + the nightly pass output.
5. **Cost cap is the hard wall.** `embedText` checks `sumTodayLlmCostUsd` first.
6. **No new deps for in-process math.** Cosine similarity is a 5-line loop. Revisit only if active memory count crosses ~5K and scan time exceeds ~50ms.

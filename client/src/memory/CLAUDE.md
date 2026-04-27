# CLAUDE.md — `client/src/memory/`

> **v3 Stage 13 module.** Memory store + extraction + RAG. Read [docs/ARCHITECTURE.md §9](../../../docs/ARCHITECTURE.md) and [docs/LIFEOS_ARCHITECTURE_EVOLUTION.md](../../../docs/LIFEOS_ARCHITECTURE_EVOLUTION.md) before editing.

## Files

| File | Role |
|---|---|
| `embed.ts` | OpenAI `text-embedding-3-small` wrapper. Cost-cap-gated, key-checked, every call logged to `llm_calls` (purpose='embed'). Exports `embedText`, `cosineSim`, `EMBED_DIM=1536`, `EMBED_MODEL`. Returns `null` on failure — callers must skip the write, never persist a row without an embedding. |
| `store.ts` | CRUD + scoring. `createMemory(MemoryInput)` embeds + inserts (or returns null). `listActiveMemories`, `getMemoryById`, `touchMemories`, `reinforceMemory`, `contradictMemory`, `archiveMemory`, `recordPredictionOutcome`, `getMemoryStats`. `computeEffectiveScore(Memory)` is the deterministic decay formula consumed by re-rankers and Stage-16 consolidation. Hydration parses JSON `embedding`/`tags`/`child_ids`; rows with bad shape are skipped (logged). |
| `rag.ts` | `retrieveContext(RagQuery) → RagResult`. Embeds the query text, scans `listActiveMemories()`, computes cosine, re-ranks by `0.5·sim + 0.2·recency + 0.15·|impact| + 0.15·confidence` (+ small tag-overlap bonus), bumps `last_accessed` on the top-k via `touchMemories`. Returns `{ embedded: false, memories: [] }` on embed failure so callers can fall back. |
| `extract.ts` | **Stage 13.** `runDailyMemoryExtraction(forDate)`: cost-cap + OpenAI key check, gated by `schema_meta.last_extract_date`. Loads `daily_rollup` for `forDate` + 7-day baseline scores, calls gpt-4o-mini with `response_format: json_object` and a strict schema (type/summary/cause/effect/impact_score/confidence/tags/predicted_outcome), validates each candidate (clamps + drops weak/malformed), then `createMemory` per candidate. Logs to `llm_calls` (purpose='extract'). Called from `brain/nightly.ts` for yesterday before the consolidation prompt is built. |

## Callers (Stage 13 wiring)

- `brain/nightly.ts` → calls `runDailyMemoryExtraction(yesterday)` (self-gated), then `retrieveContext({decisionType:'nightly_consolidation', queryText, k:12})` and appends `result.contextBlock` to the user prompt. Empty result → prompt unchanged (v2 path).
- `brain/chat.ts` → calls `retrieveContext({decisionType:'chat', queryText: lastUserMessage, k:6})` and appends `contextBlock` to `SYSTEM_PROMPT`. Embed failure / empty store → bare `SYSTEM_PROMPT`.

## Hard rules (in addition to the root list)

1. **Never persist a memory without an embedding.** `createMemory` enforces this. If `embedText` returns null, return null — do not insert a row with an empty/zero vector.
2. **Soft-delete only.** Use `archiveMemory` (sets `archived_ts`). No `DELETE FROM memories` anywhere in this folder or its callers.
3. **Embedding model is pinned to `text-embedding-3-small` (1536-dim).** Each row stores `embed_model` so a future swap is a re-embed migration, not a schema bump. `EMBED_DIM` must equal the dim of every row read by `rag.ts`; `hydrate()` filters bad-shape rows.
4. **No raw events through this module.** Memories are derived from rollups + verified facts. Stage 13 (`extract.ts`) will read `daily_rollup`, never `events`.
5. **Cost cap is the hard wall.** `embedText` checks `sumTodayLlmCostUsd` first; do not bypass.
6. **No new deps for in-process math.** Cosine similarity is a 5-line loop. If row count crosses ~5 K and the scan exceeds ~50 ms, revisit (Annoy via JSI, or `sqlite-vss` if it ever ships RN-compatible). Until then, stay simple.

## Stage progression

- **Stage 12:** scaffolding (embed/store/rag).
- **Stage 13 (now):** `extract.ts` shipped. RAG wired into `brain/nightly.ts` + `brain/chat.ts`. Falls back to v2 path on RAG miss.
- **Stage 14:** add weekly rule-generator that consumes top-confidence memories, writes to `rules` with `source='llm'`. Disable smart-nudge tick.
- **Stage 15:** in `brain/nightly.ts`, after rebuilding rollups, call `recordPredictionOutcome` on yesterday's `type='prediction'` memories.
- **Stage 16:** add `consolidate.ts` — weekly merge pass. Sets `parent_id`/`child_ids`, archives subsumed memories.
- **Stage 17:** add 5-min RAG cache, batch embedding while charging, empty-store fallback in callers.

## Folder layout invariants

- One file per concern. Don't bundle extract / consolidate into store.
- No React, no UI, no notifications. This folder is pure data + math.

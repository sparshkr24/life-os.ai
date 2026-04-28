# LifeOS Architecture Evolution

## From Reactive Tracking to Predictive Intelligence

**Document Version:** 3.0
**Date:** 2026-04-28
**Status:** Draft — Awaiting Implementation
**Priority:** Critical
**Target:** Jarvis-level personal understanding with >98% prediction accuracy

---

> **To the implementing developer:**
> This document outlines a comprehensive architectural evolution for LifeOS. The current system is functional but limited — it collects data and generates periodic snapshots without truly *understanding* the user. What follows is not a minor tweak. It is a fundamental shift from a reactive tracking system to a predictive, self-learning intelligence layer.
>
> The changes are significant but achievable. Each phase builds on the last. The goal is a system that knows you better than you know yourself — anticipating needs, preventing bad habits, and genuinely helping throughout every day.
>
> Please read this document in full before beginning implementation. The "Why" sections explain the reasoning behind every decision. The "How" sections provide concrete implementation guidance. The "Risks" sections ensure you don't discover critical failures too late.
>
> Let's build something extraordinary.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Analysis of Current Architecture](#2-critical-analysis-of-current-architecture)
3. [Updated Architecture](#3-updated-architecture)
4. [Memory System Design](#4-memory-system-design)
5. [Retrieval System (RAG)](#5-retrieval-system-rag)
6. [Consolidation Strategy](#6-consolidation-strategy)
7. [Optimization Ideas](#7-optimization-ideas)
8. [Model Usage Strategy](#8-model-usage-strategy)
9. [Implementation Phases](#9-implementation-phases)
10. [Risks and Limitations](#10-risks-and-limitations)
11. [Expected Outcomes](#11-expected-outcomes)

---

## 1. Executive Summary

### Where We Are

The current LifeOS architecture (v2) is a well-engineered data collection and aggregation system. It reliably captures events, builds daily and monthly rollups, and generates a nightly behavior profile via LLM. The foundation is solid.

### Where We Need to Be

A true personal intelligence system — Jarvis-like — that:

- **Understands causal relationships**, not just correlations
- **Predicts behavior** with >98% accuracy
- **Self-improves continuously** without manual intervention
- **Operates mostly offline** with minimal AI call dependency
- **Maintains cost** under $2/month total

### The Gap

Current `prediction_hit_rate_7d: 0.62` means the system is wrong nearly half the time. This is not a Jarvis — this is a sophisticated data diary. The problem is not the data collection. The problem is **we are not learning from the data in a structured, retrievable way**.

### The Solution

Three interlocking systems that transform data into intelligence:

| System | Purpose | Current State | Target State |
|--------|---------|---------------|--------------|
| **Memory Layer** | Store meaningful patterns, not raw logs | Does not exist | High-impact memories with embeddings |
| **RAG (Retrieval Augmented Generation)** | Retrieve relevant context for every decision | No retrieval — full context sent | Targeted retrieval of top-5 relevant memories |
| **Self-Learning Loop** | Continuously improve predictions | Manual nightly LLM call | Automated feedback-driven refinement |

Combined, these systems can realistically achieve **5-10x accuracy improvement** — pushing prediction accuracy from 62% toward 85-90%+ within the first implementation phase.

---

## 2. Critical Analysis of Current Architecture

### 2.1 What Works Well

The existing architecture has strong fundamentals:

- **Local-first storage**: SQLite is the right choice for on-device intelligence
- **Event collectors**: Comprehensive coverage of user signals (app usage, location, sleep, activity)
- **Rollup system**: Deterministic aggregation prevents LLM hallucination on raw numbers
- **Rule engine**: Offline if/else nudges are efficient and cost-effective
- **VERIFIED_FACTS block**: Deterministic correlations provide grounding — this is excellent

### 2.2 What Needs to Change

Despite its strengths, the current architecture suffers from three fundamental limitations:

#### Problem 1: The "Send Everything" Paradigm

**Current behavior:** Every LLM call (nightly profile, smart nudge tick, chat) receives the entire context window — all 30 daily rollups, all 6 monthly rollups, full behavior profile, etc.

**Why this is problematic:**

1. **Token bloat**: Sending 10-30KB of context for every decision wastes tokens and money
2. **Signal-to-noise dilution**: The model must sift through irrelevant data to find what's pertinent
3. **No memory persistence**: Each LLM call starts from scratch — there's no retrieval of past reasoning
4. **Scaling failure**: As data grows, token limits will force us to truncate, losing important patterns

**Example:** When deciding whether to send a "late-night Instagram" nudge at 22:30, we send:
- 30 days of sleep patterns (mostly irrelevant)
- 6 months of place data (irrelevant)
- Full behavior profile including weekend habits (irrelevant at 22:30 on a Tuesday)

The only relevant context is: *"Does the user typically browse Instagram after 22:00? Has tonight exceeded that threshold? What happened last time?"*

We send 30KB to answer a question that 5 relevant memories could answer in 500 bytes.

#### Problem 2: No Structured Learning

**Current behavior:** The nightly LLM call generates a new behavior profile from scratch. Previous profile insights are only preserved if the LLM explicitly carries them forward in text.

**Why this is problematic:**

1. **No retrieval of reasoning**: When a pattern is discovered (e.g., "late chess games predict poor sleep"), that insight is buried in profile JSON and must be re-derived each night
2. **No feedback loop integration**: Prediction outcomes (did the prediction match reality?) are not systematically stored for retrieval
3. **Profile fragility**: If the LLM prompt misses a nuance, valuable patterns can be lost
4. **No similarity learning**: System cannot find "similar past situations" to inform current decisions

**Example:** Profile shows `prediction_hit_rate_7d: 0.62`. Why is it 62%? Which predictions fail? Which patterns are reliable? The system knows the score but not the reasons.

#### Problem 3: Over-Engineered Smart Nudges

**Current behavior:** Every 15 minutes, `gpt-4o-mini` is called to decide whether to send a smart nudge. This is 96 potential calls per day, though most are gated.

**Why this needs optimization:**

1. **Redundant reasoning**: Many nudge decisions are predictable without LLM involvement — if `rule engine` already covers "Instagram > 60 min after 22:00", why ask the LLM?
2. **Context starvation**: LLM cannot make good decisions with the compact context currently provided
3. **Cost accumulation**: Even with gating, smart nudges consume ~$0.05/day = $1.50/month
4. **No rule generation**: We rely on LLM for one-off nudge decisions when we could generate persistent rules

**The insight:** Instead of asking the LLM "should I send a nudge?" every 15 minutes, we should ask it once: "Generate rules for nudge scenarios based on this user's patterns." Then execute those rules locally, offline, without LLM calls.

---

## 3. Updated Architecture

### 3.1 High-Level Vision

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LIFEOS INTELLIGENCE LAYER                          │
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│  │   Events    │───►│   Rollups   │───►│   Memory   │───►│    RAG      │   │
│  │ (existing)  │    │ (existing)  │    │   (NEW)    │    │  (NEW)      │   │
│  └─────────────┘    └─────────────┘    └─────────────┘    └──────┬──────┘   │
│                                                                    │          │
│                          ┌───────────────────────────────────────────┘          │
│                          ▼                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                      INTELLIGENCE ENGINE                                │  │
│  │                                                                          │  │
│  │   MiniMax M2.7 ◄──────────────────────────────────── High-reasoning      │  │
│  │        │        │                                   tasks                │  │
│  │        │        │                                                          │  │
│  │        │        ▼                                                          │  │
│  │        │   DeepSeek v3.2 ◄─────────────────────── Medium tasks            │  │
│  │        │        │                                   (nudges, chat)         │  │
│  │        │        │                                                          │  │
│  │        │        ▼                                                          │  │
│  │        │   Rule Engine ◄─────────────────────────── Zero-LLM decisions   │  │
│  │        │        │                                                          │  │
│  │        │        ▼                                                          │  │
│  │        │   Local Rules ──► Notifications (offline)                        │  │
│  │        │                                                               │  │
│  └────────┼───────────────────────────────────────────────────────────────────┘  │
│           │                                                                   │
│           ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                     BEHAVIOR PROFILE (Enhanced)                           │  │
│  │                                                                              │  │
│  │   • Confidence score (target >0.98)                                       │  │
│  │   • Causal chains (not just correlations)                                 │  │
│  │   • Prediction accuracy by category                                       │  │
│  │   • Learned rules (LLM-generated, rule-engine-executed)                    │  │
│  │   • Memory references (links to relevant memories)                        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Data Flow: Enhanced Architecture

```
                         ┌──────────────────────────────────────────────────────┐
                         │              COLLECTORS (Kotlin, existing)             │
                         │  UsageStats • Sleep API • Geofence • HealthConnect    │
                         └────────────────────────────┬───────────────────────────┘
                                                      │ INSERT
                                                      ▼
                         ┌──────────────────────────────────────────────────────┐
                         │                   EVENTS TABLE (existing)             │
                         └────────────────────────────┬───────────────────────────┘
                                                      │
                         every 15 min ────────────────┼────────────────────────────
                                                      ▼
                         ┌──────────────────────────────────────────────────────┐
                         │         INGESTION PIPELINE (existing)                │
                         │  cleanup.ts: noise purge • session merge • short drop  │
                         └────────────────────────────┬───────────────────────────┘
                                                      ▼
                         ┌──────────────────────────────────────────────────────┐
                         │           DAILY ROLLUP (existing)                     │
                         │  rebuildDailyRollup(today) + yesterday                 │
                         └────────────────────────────┬───────────────────────────┘
                                                      │
                                                      │
                         ┌────────────────────────────┴───────────────────────────┐
                         │                                                            │
                         ▼                                                            ▼
         ┌──────────────────────────────┐              ┌──────────────────────────────┐
         │    MODULE A: MEMORY          │              │    MODULE B: RAG             │
         │    CREATION (NEW)            │              │    RETRIEVAL (NEW)           │
         │  ─────────────────────────── │              │  ──────────────────────────  │
         │  Analyze daily rollup        │              │  Query relevant memories    │
         │  Extract key patterns        │              │  for current context        │
         │  Score by impact             │              │  Return top-5 candidates    │
         │  Store with embeddings       │              └──────────────┬─────────────┘
         └──────────────┬───────────────┘                             │
                        │                                             │
                        │ Create memory                               │ Retrieve
                        │                                             │
                        ▼                                             ▼
         ┌──────────────────────────────┐              ┌──────────────────────────────┐
         │    MEMORY STORE (NEW)        │              │    INTELLIGENCE              │
         │    VectorDB (on-device)      │              │    ENGINE                   │
         │  ─────────────────────────── │              │  ──────────────────────────  │
         │  • High-impact patterns      │              │  MiniMax M2.7 (nightly)      │
         │  • Causal relationships     │              │  DeepSeek v3.2 (nudges)      │
         │  • Prediction outcomes      │              │  Rule Engine (offline)        │
         │  • Embedding vectors       │              └──────────────┬─────────────┘
         └──────────────────────────────┘                             │
                                                                     │
                                                                     ▼
         ┌──────────────────────────────────────────────────────────────────────────┐
         │                     BEHAVIOR PROFILE (enhanced)                           │
         │                                                                          │
         │   Built nightly from: Memories + Rollups + Profile + VERIFIED_FACTS     │
         │   With RAG context: Only relevant memories included                     │
         └──────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Key Architectural Changes

| Component | Current (v2) | Evolved (v3) | Impact |
|-----------|--------------|--------------|--------|
| **Context for LLM** | Full rollups, all data | RAG-retrieved relevant memories | 10x reduction in tokens per call |
| **Memory storage** | None (implicit in profile) | Explicit memories with embeddings | Persistent reasoning, not just text |
| **Smart nudges** | LLM call every 15 min (gated) | Rule engine executes LLM-generated rules | 90% reduction in nudge AI calls |
| **Rule generation** | Manual rules in `rules` table | LLM-generated rules, weekly refinement | Personalized automation |
| **Feedback loop** | Implicit in nightly profile | Explicit outcome tracking in Memory Store | Measurable prediction accuracy |
| **Pattern abstraction** | LLM infers from data | LLM + VectorDB similarity search | Consistent causal discovery |

### 3.4 New Components

#### 3.4.1 Memory Store

Stores extracted patterns as first-class entities:

```typescript
interface Memory {
  id: string;                    // UUID
  created_at: number;           // epoch ms
  type: 'pattern' | 'causal' | 'prediction' | 'habit';

  // Core content
  summary: string;              // Human-readable summary
  cause?: string;               // For causal types: "what happened"
  effect?: string;              // For causal types: "what resulted"

  // Scoring
  impact_score: number;         // -1.0 to +1.0 (negative = harmful)
  confidence: number;           // 0.0 to 1.0
  occurrences: number;          // How many times observed

  // Metadata
  tags: string[];               // ['sleep', 'instagram', 'late-night']
  source_data: string;          // Reference to rollup or events
  rollup_date?: string;         // Which rollup this was extracted from

  // Embedding (for VectorDB)
  embedding: number[];          // 384-dimension floating point array

  // Outcome tracking (for predictions)
  predicted_outcome?: string;   // "next day productivity will drop"
  actual_outcome?: string;      // Set when outcome is known
  was_correct?: boolean;        // Derived from prediction match
}
```

**Why this structure matters:**

- `cause` + `effect` fields enable causal chain reasoning, not just correlation
- `impact_score` enables prioritization — high-impact memories persist, low-impact decay
- `embedding` enables similarity search — finding "similar past situations"
- `was_correct` tracking enables measurable self-improvement

#### 3.4.2 VectorDB (On-Device)

Lightweight vector similarity search without heavy infrastructure:

**Option A: SQLite with vector extension**
- Use `sqlite-vss` or similar if available in React Native ecosystem
- Fallback: Store embeddings as JSON blob, do approximate search client-side

**Option B: Pure-JS approximate nearest neighbor**
- Use a library like `annoy` (Airbnb'sApproximate Nearest Neighbors Oh Yeah)
- Compile to JSI for performance
- 384-dimensional embeddings, 1000-5000 memories expected

**Option C: Chroma (embedded)**
- Chroma has a lightweight serverless mode
- Can be bundled as native module
- Provides production-grade similarity search

**Recommendation:** Start with Option A (SQLite-based) for simplicity. If performance is insufficient, migrate to Option B. Only consider Option C if Chroma provides a React Native compatible build.

#### 3.4.3 Intelligence Engine

The reasoning layer that replaces "dumb LLM calls":

```typescript
// High-reasoning tasks: MiniMax M2.7
interface HighReasoningTask {
  type: 'nightly_consolidation' | 'pattern_abstraction' | 'rule_generation' | 'causal_analysis';
  context: Memory[];              // RAG-retrieved relevant memories (top-10)
  rollups: DailyRollup[];         // Last 7 days only for nightly
  profile: BehaviorProfile;       // Current profile for continuity
}

// Medium tasks: DeepSeek v3.2
interface MediumTask {
  type: 'smart_nudge_decision' | 'chat' | 'memory_creation' | 'prediction_update';
  context: Memory[];               // Top-5 relevant memories
  current_state: TodayPartialRollup;
  profile_summary: BehaviorProfileSummary;
}

// Zero-LLM tasks: Rule Engine
interface RuleExecution {
  rule: GeneratedRule;
  current_state: TodayPartialRollup;
  last_triggered?: number;         // For cooldown enforcement
}
```

---

## 4. Memory System Design

### 4.1 What to Store

Not every pattern warrants a memory. The Memory Store is curated intelligence, not a second events table.

**Store when:**

| Condition | Example | Priority |
|-----------|---------|----------|
| Impact score > 0.15 or < -0.15 | Late-night Instagram reduces next-day productivity by 28% | High |
| Confidence > 0.7 | Observed 5+ times with consistent outcome | High |
| Novel causal relationship | "When X happens, Y always follows" not previously captured | High |
| Prediction outcome | Prediction made, outcome observed, result differs from prediction | Medium |
| Habit formation | New behavior repeated 3+ days | Medium |
| Deviation from baseline | Significant deviation (>2 sigma) on any metric | Medium |

**Do NOT store:**

| Condition | Reason |
|-----------|--------|
| Single occurrence patterns | Too noisy, not reliable |
| Impact score between -0.15 and +0.15 | Too weak to be actionable |
| Raw event data | Already in events table |
| Already-captured patterns | Memory merging handles duplicates |

### 4.2 When to Store

**Phase 1: After Daily Rollup (every 15 min)**

```typescript
// Run after rebuildDailyRollup(today)
async function extractMemories(rollup: DailyRollup): Promise<Memory[]> {
  // Use DeepSeek v3.2 for memory extraction
  // Compact prompt: Only this day's rollup + profile summary
  // Output: Array of potential memories with impact scores

  const prompt = `
    Analyze this day's rollup for significant patterns:
    ${JSON.stringify(rollup)}

    Current profile summary:
    ${profile.summary}

    Extract memories where:
    - A specific behavior led to a measurable outcome
    - A prediction was made and the outcome is now known
    - A deviation from baseline occurred
    - A habit shows formation or disruption

    Return structured memories with impact scores.
  `;

  // DeepSeek v3.2 call (~$0.001 per call — once per day, not per 15 min)
}
```

**Phase 2: After Nightly Consolidation (once per day)**

```typescript
// Run after behavior profile rebuild
async function consolidateMemories(profile: BehaviorProfile): Promise<void> {
  // MiniMax M2.7 for deep causal analysis
  // Input: All recent memories + profile changes + verified facts

  const prompt = `
    Analyze the evolution of user patterns:
    ${JSON.stringify(recentMemories)}

    Previous profile understanding:
    ${previousProfile.summary}

    New profile understanding:
    ${newProfile.summary}

    Identify:
    1. New causal relationships discovered
    2. Previously held beliefs now contradicted
    3. Abstract patterns that subsume specific ones
    4. High-confidence predictions that should become rules
  `;

  // Update memories based on consolidation insights
  // Merge duplicate patterns
  // Archive low-confidence memories
}
```

### 4.3 Memory Scoring

Every memory has a dynamic score that changes over time:

```typescript
interface MemoryScore {
  raw_score: number;        // Initial impact when created
  reinforcement_count: number;  // Times observed again
  contradiction_count: number;  // Times observed without expected effect
  last_accessed: number;    // For recency weighting
  decay_factor: number;     // How fast this memory decays
}

// Computed score: weighted combination
function computeEffectiveScore(score: MemoryScore): number {
  const reinforcement_weight = 0.3;
  const contradiction_penalty = 0.5;
  const recency_weight = 0.2;

  let effective = score.raw_score;

  // Reinforcement increases confidence
  effective += (score.reinforcement_count * reinforcement_weight * score.raw_score);

  // Contradictions reduce confidence
  effective -= (score.contradiction_count * contradiction_penalty);

  // Recency decay (if not accessed in 7 days, start decaying)
  const days_since_access = (Date.now() - score.last_accessed) / (1000 * 60 * 60 * 24);
  if (days_since_access > 7) {
    effective *= Math.exp(-score.decay_factor * (days_since_access - 7));
  }

  return Math.max(-1.0, Math.min(1.0, effective));
}
```

**Memory lifecycle:**

| State | Criteria | Action |
|-------|----------|--------|
| **New** | Just created | Full embedding, active monitoring |
| **Reinforced** | Same pattern observed 2+ more times | Increase confidence |
| **Stable** | Confidence > 0.8, no contradictions | Promote to "verified pattern" |
| **Decaying** | Not accessed >30 days | Reduce priority in retrieval |
| **Contradicted** | Observed without expected effect | Flag for review, reduce confidence |
| **Archived** | Confidence < 0.2 or redundant | Remove from active memory, keep metadata |

### 4.4 Pattern Merging

When similar memories are created, merge them:

```typescript
// Example: Three separate memories about late-night stimulation
const memory1 = {
  summary: "Late-night Instagram (>1hr) → next day productivity -28%",
  impact: -0.28,
  tags: ["instagram", "late-night", "productivity"]
};

const memory2 = {
  summary: "Using YouTube after 23:00 predicts -22% next-day focus",
  impact: -0.22,
  tags: ["youtube", "late-night", "focus"]
};

const memory3 = {
  summary: "Phone usage >30 min after 22:00 correlates with poor sleep quality",
  impact: -0.18,
  tags: ["phone", "late-night", "sleep"]
};

// Merge into abstract pattern
const mergedMemory = {
  summary: "Late-night digital stimulation (>30 min after 22:00) → reduced next-day performance",
  impact: -0.24,  // Average weighted by occurrences
  tags: ["late-night-stimulation", "digital", "negative-outcome"],
  subsumes: [memory1.id, memory2.id, memory3.id],  // Links to merged memories
  children: [memory1.id, memory2.id, memory3.id]   // Keep for specific cases
};
```

**Why pattern merging is essential:**

1. Reduces memory bloat — 100 specific patterns become 20 abstract ones
2. Improves prediction generalization — "late-night stimulation" applies to new apps
3. Accelerates learning — system doesn't re-learn the same lesson with each new app

---

## 5. Retrieval System (RAG)

### 5.1 How RAG Should Work

**Current problem:** Every LLM call sends all available context.

**RAG solution:** Retrieve only the most relevant context for the specific decision being made.

### 5.2 Retrieval Pipeline

```typescript
interface RAGQuery {
  // What decision needs to be made?
  decision_type: 'nudge' | 'prediction' | 'chat' | 'consolidation';

  // Current context
  current_time: Date;
  current_location?: string;
  current_rollup?: TodayPartialRollup;

  // User state
  recent_behavior?: string[];  // e.g., ["open_instagram", "late_night"]

  // Constraints
  max_memories: number;        // Typically 5-10
  time_range?: string;         // e.g., "last 7 days"
  required_tags?: string[];    // e.g., ["sleep", "instagram"]
}

async function retrieveContext(query: RAGQuery): Promise<RetrievedContext> {
  // Step 1: Generate query embedding
  const queryEmbedding = await embeddingModel.embed(`
    ${query.decision_type} decision at ${query.current_time.toISOString()}
    ${query.current_location ? `location: ${query.current_location}` : ''}
    recent behavior: ${query.recent_behavior?.join(', ') || 'none'}
  `);

  // Step 2: Vector similarity search
  const candidateMemories = await vectorDB.similaritySearch({
    query_vector: queryEmbedding,
    limit: query.max_memories * 3,  // Get more than needed for filtering
    filters: {
      ...(query.required_tags && { tags: { $overlap: query.required_tags } }),
    }
  });

  // Step 3: Re-rank by recency and relevance
  const reranked = candidateMemories
    .map(m => ({
      memory: m,
      score: computeRetrievalScore(m, query)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, query.max_memories);

  // Step 4: Build context string
  return {
    memories: reranked.map(r => r.memory),
    context_summary: buildContextSummary(reranked),
    retrieval_metadata: {
      query_type: query.decision_type,
      total_candidates: candidateMemories.length,
      retrieval_time_ms: Date.now() - startTime
    }
  };
}

function computeRetrievalScore(memory: Memory, query: RAGQuery): number {
  let score = 0;

  // Tag overlap with query requirements
  if (query.required_tags) {
    const overlap = memory.tags.filter(t => query.required_tags.includes(t)).length;
    score += overlap / query.required_tags.length * 0.3;
  }

  // Recency (more recent = more relevant)
  const daysOld = (Date.now() - memory.created_at) / (1000 * 60 * 60 * 24);
  score += Math.exp(-daysOld / 30) * 0.3;

  // Impact magnitude (larger impact = more decision-relevant)
  score += Math.abs(memory.impact_score) * 0.2;

  // Confidence (higher confidence = more reliable)
  score += memory.confidence * 0.2;

  return score;
}
```

### 5.3 How Many Memories to Retrieve

| Use Case | Memories | Rationale |
|---------|----------|-----------|
| **Nightly consolidation** | 10-15 | Deep context for complex reasoning |
| **Smart nudge decision** | 3-5 | Quick decision, focused context |
| **Prediction update** | 5-7 | Balance between context and brevity |
| **Chat response** | 5-10 | Depends on query complexity |
| **Rule generation** | 15-20 | Need comprehensive pattern view |

### 5.4 Context Assembly

Once memories are retrieved, they must be assembled into a coherent context for the LLM:

```typescript
function assembleContext(
  memories: Memory[],
  query: RAGQuery,
  rollup?: DailyRollup
): string {
  // Format memories for LLM consumption
  const memorySection = memories.length > 0
    ? `## Relevant Memories\n${memories.map(m => `
### ${m.type}: ${m.summary}
- Impact: ${(m.impact_score * 100).toFixed(0)}% (${m.impact_score > 0 ? 'positive' : 'negative'})
- Confidence: ${(m.confidence * 100).toFixed(0)}%
- Observed: ${m.occurrences} times
- Tags: ${m.tags.join(', ')}
${m.cause && m.effect ? `Causal chain: ${m.cause} → ${m.effect}` : ''}
${m.was_correct !== undefined ? `Prediction accuracy: ${m.was_correct ? 'correct' : 'incorrect'}` : ''}
`).join('\n')}`
    : '## Relevant Memories\nNo specific memories for this context.';

  // Add current rollup if available
  const rollupSection = rollup
    ? `## Current State (Today)\n${summarizeRollup(rollup)}`
    : '';

  // Add query context
  const querySection = `## Current Query
Decision type: ${query.decision_type}
Time: ${query.current_time.toISOString()}
${query.current_location ? `Location: ${query.current_location}` : ''}
${query.recent_behavior?.length ? `Recent behavior: ${query.recent_behavior.join(' → ')}` : ''}`;

  return [
    querySection,
    memorySection,
    rollupSection,
  ].join('\n\n');
}
```

**Example output for a 22:00 smart nudge decision:**

```
## Current Query
Decision type: nudge
Time: 2026-04-28T22:00:00+05:30
Location: home
Recent behavior: open_instagram → screen_on_47min

## Relevant Memories

### pattern: Late-night Instagram (>1hr) predicts next-day productivity drop
- Impact: -28% (negative)
- Confidence: 82%
- Observed: 14 times
- Tags: instagram, late-night, productivity
Causal chain: Instagram >60min after 22:00 → next morning productivity -28%

### pattern: Home location after 21:00 is high-risk for doomscrolling
- Impact: -22% (negative)
- Confidence: 74%
- Observed: 21 times
- Tags: home, late-night, risk-window
Causal chain: At home after 21:00 with phone in hand → typically 45+ min doomscroll

### prediction: If Instagram used at 22:00, next day productivity drops
- Impact: -28% (negative)
- Confidence: 65%
- Observed: 14 times
- Prediction accuracy: correct
Prediction outcome: next-day productivity < 60

## Current State (Today)
- Instagram usage: 47 minutes (today)
- Current hour: 22:00
- Screen time total: 3h 24m
- Productivity score so far: 71

---

Given this context, should I send a nudge? If yes, what level?
```

This context is ~1.5KB versus the 30KB of full context currently sent.

---

## 6. Consolidation Strategy

### 6.1 When to Run Consolidation

| Consolidation Type | Frequency | Trigger | Model |
|-------------------|-----------|----------|-------|
| **Memory extraction** | Once per day | After daily rollup finalizes (~02:00) | DeepSeek v3.2 |
| **Weekly rule generation** | Once per week | Sunday midnight or configured time | MiniMax M2.7 |
| **Monthly deep analysis** | Once per month | Last day of month | MiniMax M2.7 |
| **On-demand refinement** | As needed | When prediction hit rate drops below threshold | MiniMax M2.7 |

### 6.2 Weekly Rule Generation (Critical Optimization)

This is where we eliminate 90% of smart nudge AI calls:

```typescript
interface GeneratedRule {
  id: string;
  name: string;
  description: string;

  // Trigger conditions
  conditions: RuleCondition[];

  // Action
  action: {
    type: 'nudge';
    level: 1 | 2 | 3;
    message_template: string;
  };

  // Cooldown
  cooldown_minutes: number;

  // Meta
  created_by: 'llm';
  based_on_memories: string[];  // Memory IDs this rule is based on
  confidence: number;
  last_validated?: number;
}

interface RuleCondition {
  field: string;        // e.g., 'app_usage.instagram.after_22_minutes'
  operator: '>' | '<' | '==' | '!=' | 'contains';
  value: number | string;
  AND?: RuleCondition[];
  OR?: RuleCondition[];
}

// Example LLM prompt for rule generation
const ruleGenerationPrompt = `
You are analyzing user behavior patterns to generate automated rules.

## User Profile Summary
${profile.summary}

## Recent Memories (last 14 days)
${memories.map(m => `- ${m.summary} (impact: ${m.impact_score}, confidence: ${m.confidence})`).join('\n')}

## VERIFIED_FACTS (deterministic correlations)
${verifiedFacts.map(f => `- ${f.description}: ${f.score_delta}`).join('\n')}

## Nudge History (last 14 days)
${recentNudges.map(n => `- ${n.source}: "${n.message}" → ${n.user_action}`).join('\n')}

## Task
Generate rules that:
1. Have clear, observable trigger conditions
2. Would have prevented negative outcomes or reinforced positive ones
3. Are specific enough to be accurate but general enough to be robust
4. Do NOT overlap with existing rules

Output format: JSON array of rule objects.
Rules should be actionable with the current rule engine structure.

Example output:
[
  {
    "name": "Late night Instagram nudge",
    "description": "Warn when Instagram usage exceeds 30 min after 22:00",
    "conditions": [
      { "field": "app_usage.com.instagram.android.minutes_after_22", "operator": ">", "value": 30 }
    ],
    "action": {
      "type": "nudge",
      "level": 2,
      "message_template": "You've been on Instagram for {minutes} minutes after 22:00. Tomorrow's productivity tends to drop {impact}% on nights like this."
    },
    "cooldown_minutes": 120
  }
]
`;
```

**This single MiniMax M2.7 call (~5 cents) generates rules that execute **all week** without any AI calls.**

### 6.3 Memory Consolidation (Weekly)

```typescript
async function consolidateMemories(): Promise<void> {
  // MiniMax M2.7 for deep causal analysis

  const prompt = `
    Analyze the week's patterns and identify:

    1. **New patterns**: Any new causal relationships discovered this week?
    2. **Contradictions**: Any memories that were contradicted by outcomes?
    3. **Abstractions**: Can we merge specific patterns into more general ones?
    4. **Rule candidates**: Which patterns are stable enough to become automated rules?
    5. **Confidence updates**: Should any memory confidence scores be adjusted?

    Recent memories (20 most recent):
    ${recentMemories.map(m => JSON.stringify(m)).join('\n')}

    Nudge outcomes this week:
    ${nudgeOutcomes.map(n => `${n.message} → ${n.acted ? 'acted' : 'ignored/dismissed'}`).join('\n')}

    Output: JSON with updates to make to memory store.
  `;

  // Process updates:
  // - Merge similar memories
  // - Archive contradicted memories
  // - Promote high-confidence patterns
  // - Flag low-confidence patterns for decay
}
```

### 6.4 Monthly Deep Analysis

```typescript
async function monthlyAnalysis(): Promise<MonthlyReport> {
  // MiniMax M2.7 — most complex reasoning task

  const prompt = `
    Perform comprehensive analysis of the past month's behavior:

    1. **Pattern Evolution**: How have the user's patterns changed over the month?
    2. **Causal Chain Discovery**: What new causal relationships emerged?
    3. **Prediction Accuracy**: Detailed breakdown of prediction success/failure
    4. **Intervention Effectiveness**: Which nudges actually worked?
    5. **Lifestyle Assessment**: Is the user trending toward their goals?

    Data sources:
    - Monthly rollup: ${monthlyRollup}
    - Memory store summary: ${memoryStats}
    - Nudge outcomes: ${nudgeAnalysis}
    - VERIFIED_FACTS: ${verifiedFacts}

    Output: Comprehensive monthly report + recommendations for next month.
  `;

  return {
    report,
    updated_profile_confidence: calculateNewConfidence(),
    memory_store_optimizations: applyOptimizations(),
    rules_to_deprecate: identifyOutdatedRules(),
    new_rules_to_generate: suggestNewRules()
  };
}
```

---

## 7. Optimization Ideas

### 7.1 Reduce AI Calls

| Current | Optimized | Reduction |
|---------|-----------|-----------|
| Smart nudge tick every 15 min | Rule engine executes LLM-generated rules | **95%** |
| Nightly profile rebuild | Incremental profile update when changes detected | **50%** |
| Memory extraction every 15 min | Memory extraction once per day | **93%** |
| Chat with full context | Chat with RAG-retrieved context | **70%** |

**Estimated monthly AI calls after optimization:**

| Task | Current Calls/Month | Optimized Calls/Month |
|------|--------------------|-----------------------|
| Nightly profile | 30 | 30 (unchanged) |
| Smart nudges | ~200 (gated from 2,880) | 0 (replaced by rules) |
| Memory extraction | 0 | 30 |
| Rule generation | 0 | 4 |
| Chat | User-driven | User-driven (less tokens per call) |
| **Total** | **~230** | **~64** |

### 7.2 Improve Latency

| Strategy | Implementation | Expected Improvement |
|----------|---------------|---------------------|
| **Cached context** | Cache RAG results for 5 min | 200ms saved per call |
| **Async embedding** | Generate embeddings asynchronously | Non-blocking memory creation |
| **Batch retrieval** | Retrieve memories in batch, not per-call | 30% faster retrieval |
| **Local rule evaluation** | Rules execute instantly, no network | <1ms vs 500ms+ for LLM call |

### 7.3 Battery Efficiency

| Current Issue | Optimization | Battery Impact |
|--------------|-------------|----------------|
| Frequent LLM calls drain battery | Reduce calls by 90% via rules | **Significant** improvement |
| Constant embedding generation | Batch embeddings, generate when charging | **Moderate** improvement |
| Smart nudge background work | Rules execute in-process | **Moderate** improvement |

### 7.4 Pattern Abstraction Strategy

**Example transformation:**

```
Before (50 specific memories):
- "Late-night Instagram (>1hr) → productivity -28%"
- "Late-night YouTube (>45min) → productivity -22%"
- "Late-night Twitter (>30min) → productivity -18%"
- "Late-night TikTok (>20min) → productivity -25%"
- "Late-night Reddit (>40min) → productivity -20%"

After abstraction (5 general memories):
- "Late-night social media (>30min) → productivity -23%"
- "Late-night video content (>45min) → productivity -21%"
- "Late-night news/apps (>30min) → productivity -19%"

Rules generated:
- "If social media > 30 min after 22:00 → level-2 nudge"
- "If video content > 45 min after 23:00 → level-1 nudge"
```

This transformation:
1. Reduces memory store size by 90%
2. Improves generalization to new apps
3. Makes rules more robust
4. Increases prediction accuracy for novel situations

---

## 8. Model Usage Strategy

### 8.1 Model Selection Criteria

| Criteria | MiniMax M2.7 | DeepSeek v3.2 | Rule Engine |
|----------|--------------|--------------|-------------|
| **Reasoning depth** | Excellent | Good | None |
| **Tool calling** | Native | Supported | N/A |
| **Cost efficiency** | $0.30/1M in, $1.20/1M out | $0.27/1M in, $0.42/1M out | Free |
| **Context window** | 200K tokens | 128K+ tokens | N/A |
| **Speed** | Medium | Fast | Instant |
| **Best for** | Complex reasoning, rule generation | Medium reasoning, memory extraction | Zero-LLM decisions |

### 8.2 Task-to-Model Mapping

| Task | Model | Frequency | Estimated Cost/Month |
|------|-------|-----------|---------------------|
| **Nightly behavior profile rebuild** | MiniMax M2.7 | 30x | $1.50 |
| **Weekly rule generation** | MiniMax M2.7 | 4x | $0.20 |
| **Monthly deep analysis** | MiniMax M2.7 | 1x | $0.10 |
| **Memory extraction** | DeepSeek v3.2 | 30x | $0.30 |
| **RAG context assembly** | DeepSeek v3.2 | 30x | $0.30 |
| **Rule evaluation** | Rule Engine (local) | 1000s/day | Free |
| **Chat responses** | DeepSeek v3.2 | User-driven | ~$0.20 |
| **Total** | | | **$2.60** ❌ Over budget |

### 8.3 Cost Optimization

We need to reduce monthly cost to <$2.00:

| Strategy | Change | Monthly Savings |
|----------|---------|-----------------|
| Use DeepSeek v3.2 for nightly profile | MiniMax M2.7 → DeepSeek v3.2 | -$1.20 |
| Reduce nightly profile context | 30 rollups → 14 rollups (RAG helps) | -$0.30 |
| **Total optimized** | | **$1.10/month** ✅ Under budget |

**Revised Model Usage:**

| Task | Model | Frequency | Cost/Month |
|------|-------|-----------|------------|
| **Nightly profile rebuild** | DeepSeek v3.2 | 30x | $0.30 |
| **Weekly rule generation** | DeepSeek v3.2 | 4x | $0.20 |
| **Monthly deep analysis** | DeepSeek v3.2 | 1x | $0.10 |
| **Memory extraction** | DeepSeek v3.2 | 30x | $0.30 |
| **Rule evaluation** | Rule Engine (local) | 1000s/day | Free |
| **Chat responses** | DeepSeek v3.2 | User-driven | $0.20 |
| **RAG retrieval** | Local (no LLM) | 100s/day | Free |
| **Total** | | | **$1.10/month** ✅ |

**Note:** We are using DeepSeek v3.2 for everything except rule generation, where MiniMax M2.7's superior reasoning would help. For cost efficiency, we use DeepSeek v3.2 throughout. If prediction accuracy is insufficient after implementation, upgrade rule generation to MiniMax M2.7.

### 8.4 Web Fetch Capabilities

DeepSeek v3.2 supports function calling, which can be used for web search when needed:

```typescript
// Example: Fetching external context for predictions
const webSearchTool = {
  name: 'web_search',
  description: 'Search the web for current events or information',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number', default: 3 }
    }
  }
};

// Use case: When user asks "What should I do today?"
// System can fetch: weather, calendar events, user's schedule
// Then incorporate into prediction
```

However, for privacy and offline capability, web fetch should be used sparingly and only when user explicitly requests external information.

---

## 9. Implementation Phases

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Establish memory store and basic retrieval without changing existing behavior

**Deliverables:**
1. New SQLite table `memories` with embedding storage
2. Basic embedding generation (can use a simple local model or API)
3. RAG retrieval function (no LLM integration yet)
4. Memory scoring algorithm

**Changes to existing code:**
- None yet — this phase is additive

**Testing:**
- Verify memories are created from daily rollups
- Verify similarity search returns relevant memories
- Benchmark retrieval latency (<50ms target)

---

### Phase 2: RAG Integration (Weeks 3-4)

**Goal:** Replace "send everything" with RAG-retrieved context

**Deliverables:**
1. RAG context assembly for nightly profile rebuild
2. RAG context assembly for chat
3. Memory relevance evaluation

**Changes to existing code:**
- Modify Module 7 (nightly profile) to use RAG
- Modify chat module to use RAG
- Add RAG context to prompt templates

**Testing:**
- Compare prediction accuracy with vs. without RAG
- Verify RAG retrieves relevant memories (manual review)
- Token usage reduction measurement

---

### Phase 3: Rule Generation (Weeks 5-6)

**Goal:** Eliminate smart nudge LLM calls via LLM-generated rules

**Deliverables:**
1. Weekly rule generation call (MiniMax M2.7 or DeepSeek v3.2)
2. Rule storage in `rules` table with LLM-generated flag
3. Rule engine enhancement to handle new rule format
4. Deprecate smart nudge tick (Module 6b)

**Changes to existing code:**
- Add new module: Rule Generator
- Modify Module 6a to execute LLM-generated rules
- Remove or disable Module 6b (smart nudge tick)
- Update Settings UI to show "LLM-generated rules"

**Testing:**
- Verify rules are generated weekly
- Verify rule execution matches intended behavior
- Measure nudge accuracy improvement
- Measure AI call reduction

---

### Phase 4: Self-Learning Loop (Weeks 7-8)

**Goal:** Close the feedback loop — predictions affect memory creation

**Deliverables:**
1. Prediction outcome tracking in memory store
2. Memory reinforcement on correct predictions
3. Memory contradiction flagging on incorrect predictions
4. Prediction accuracy dashboard (in Profile tab)

**Changes to existing code:**
- Modify prediction creation to store in memory with `predicted_outcome`
- Add nightly task to update memories with actual outcomes
- Implement confidence adjustment based on outcomes

**Testing:**
- Measure prediction_hit_rate improvement over time
- Verify memory confidence updates correctly
- Verify contradicted memories are flagged

---

### Phase 5: Pattern Abstraction (Weeks 9-10)

**Goal:** Reduce memory bloat, improve generalization

**Deliverables:**
1. Memory merging algorithm
2. Abstract pattern creation
3. Rule generalization based on abstract patterns

**Changes to existing code:**
- Add memory consolidation to nightly tasks
- Implement subsumption detection
- Update rules to reference abstract patterns

**Testing:**
- Measure memory store size reduction
- Verify rule generalization works for new apps
- Verify specific memories are preserved for detailed queries

---

### Phase 6: Optimization & Polish (Weeks 11-12)

**Goal:** Fine-tune for performance, battery, and edge cases

**Deliverables:**
1. Caching layer for RAG results
2. Battery usage monitoring
3. Edge case handling (empty memory store, low confidence, etc.)
4. Performance profiling and optimization

**Changes to existing code:**
- Add caching mechanisms
- Add battery impact monitoring
- Enhance error handling

**Testing:**
- Full stress test: 1 week of continuous operation
- Battery impact measurement
- Memory leak detection

---

## 10. Risks and Limitations

### 10.1 Where System May Fail

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Empty memory store** | High (initial) | High | Seed with initial patterns from rollups |
| **Embedding quality poor** | Medium | High | Use proven embedding model, benchmark quality |
| **RAG retrieval returns irrelevant memories** | Medium | Medium | Manual evaluation, tune retrieval scoring |
| **LLM-generated rules have bugs** | Medium | High | Sandbox testing, gradual rollout, kill switch |
| **Memory store grows unbounded** | Medium | Low | Decay policy, archiving, pattern merging |
| **Battery drain from vector operations** | Low | Medium | Async operations, batch processing |
| **Prediction accuracy doesn't improve** | Medium | High | A/B testing, feedback loop tuning |

### 10.2 Edge Cases

| Edge Case | Handling |
|-----------|----------|
| **New user (<7 days data)** | Use generic priors, conservative predictions, rapid learning mode |
| **Inconsistent user behavior** | Lower confidence scores, wider prediction intervals |
| **Major life changes** | Detect deviation >3 sigma, reset learning, flag for user review |
| **Memory store corruption** | Backup/restore, corruption detection, auto-recovery from rollups |
| **Embedding model unavailable** | Fallback to keyword-based retrieval |

### 10.3 Trade-offs

| Trade-off | Choice | Rationale |
|-----------|--------|-----------|
| **Memory depth vs. storage** | Keep top-1000 memories | Enough for RAG, manageable size |
| **Retrieval breadth vs. latency** | Top-5 to Top-10 | Balance between context and speed |
| **Rule automation vs. safety** | LLM generates, human reviews | User confirms rules before enforcement |
| **Abstraction vs. specificity** | Keep both layers | Abstract for generalization, specific for detail |

---

## 11. Expected Outcomes

### 11.1 Prediction Accuracy Trajectory

| Phase | Prediction Hit Rate | Confidence | Key Improvement |
|-------|--------------------|------------|-----------------|
| **Current** | 62% | 0.71 | Baseline |
| **After Phase 2** | 70% | 0.75 | RAG context |
| **After Phase 3** | 78% | 0.80 | Rules reduce noise |
| **After Phase 4** | 85% | 0.85 | Feedback loop |
| **After Phase 5** | 90% | 0.90 | Pattern abstraction |
| **After Phase 6** | 90-95% | 0.95 | Optimization |

**Target: >98% is ambitious.** 90-95% is realistic with full implementation. Reaching >98% would require:
- User feedback integration (explicit corrections)
- External context (calendar, weather, appointments)
- Extended learning period (6+ months of data)

### 11.2 Cost Trajectory

| Component | Current | With RAG Only | Full Implementation |
|-----------|---------|---------------|-------------------|
| Nightly profile | $1.50 | $1.50 | $0.30 |
| Smart nudges | $1.50 | $1.50 | $0 |
| Memory operations | $0 | $0.30 | $0.60 |
| Rule generation | $0 | $0 | $0.20 |
| Chat | Variable | Variable | Variable |
| **Total** | **~$3.00** | **~$3.30** | **$1.10** |

### 11.3 System Behavior Changes

| Behavior | Before | After |
|----------|--------|-------|
| **Context for decisions** | Full rollups (30KB) | RAG-retrieved (1.5KB) |
| **Nudge decisions** | LLM every 15 min | Rules execute locally |
| **Learning mechanism** | Implicit in profile | Explicit in memories |
| **Pattern storage** | Buried in profile JSON | First-class entities |
| **Prediction feedback** | Score only | Full outcome tracking |
| **Rule generation** | Manual | Weekly LLM + local execution |

---

## 12. Conclusion

The current LifeOS architecture is a well-built data collection system. What it lacks is intelligence — the ability to learn from data, retrieve relevant patterns, and make increasingly accurate predictions without expensive, frequent LLM calls.

The proposed evolution adds three interlocking systems:

1. **Memory Layer** — Storing meaningful patterns as first-class entities with embeddings
2. **RAG** — Retrieving only relevant context for each decision
3. **Self-Learning Loop** — Explicit feedback tracking and pattern refinement

Together, these systems transform LifeOS from a reactive tracker into a predictive intelligence. The goal is not just data collection — it is genuine understanding of the user's life patterns, with the ability to anticipate needs, prevent harmful habits, and provide meaningful assistance throughout every day.

The implementation is significant but achievable in 12 weeks. The cost reduction from ~$3.00/month to ~$1.10/month offsets the development effort. The accuracy improvement from 62% to 90%+ transforms the system from occasionally helpful to genuinely indispensable.

Let's build the personal intelligence system you deserve — one that knows you better than you know yourself.

---

**Next Steps for Implementer:**

1. Review this document and the architecture.md in parallel
2. Confirm understanding of RAG, VectorDB, and memory scoring concepts
3. Create technical specification for Phase 1 (Memory Store)
4. Begin implementation

Questions, concerns, or clarifications needed before proceeding? This is a substantial architectural change — let's ensure alignment before beginning.

---

*Document prepared for implementation by MiniMax Agent*
*2026-04-28*

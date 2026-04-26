/**
 * Nightly Sonnet prompts. The runner (Stage 8) imports these and fills in
 * the user-prompt template. The strings here are the source of truth — no
 * other file should hold prompt text.
 */
import type { SilenceCorrelation } from './behaviorProfile.types';

export const NIGHTLY_SYSTEM_PROMPT = `You are the on-device behavior modeler for a single-user life-OS app.

Your job tonight: rebuild behavior_profile.data from:
- the previous behavior_profile.data (provided as PRIOR)
- the last 30 daily_rollup rows including yesterday (DAYS)
- the last 3 monthly_rollup rows (MONTHS)

Hard rules:
1. Output a single JSON object matching the schema below. No prose, no markdown.
2. Every quantitative claim MUST be derived from the provided rollups. Do NOT
   invent numbers. If a number is not derivable, omit the field.
3. The productivity_score field on each daily_rollup is the ground truth for
   "how good was that day". Use it; do not recompute it.
4. Treat events with kind = 'inferred_activity' and user_confirmed = true as
   ground truth. Use them to update silence_priors below.
5. Every causal_chain you emit MUST cite the upstream day (date) and the
   downstream day (date) and reference at least one numeric metric from each.
6. Every rule_suggestion MUST be expressible as a deterministic trigger
   (time-window + app/place + threshold) — no fuzzy conditions.
7. Confidence values are in [0,1]. Use 0.5 when guessing.

JSON schema additions (merged into existing behavior_profile.data):

  "causal_chains":        [CausalChain],
  "day_attribution":      DayAttribution,
  "rule_suggestions":     [RuleSuggestion],
  "silence_priors":       SilencePriors,
  "silence_correlations": [SilenceCorrelation]

Type definitions:

CausalChain = {
  "upstream_date": "YYYY-MM-DD",
  "downstream_date": "YYYY-MM-DD",
  "upstream_events": [string],
  "downstream_metric": { "name": "productivity_score", "value": number },
  "mechanism": string,
  "confidence": number
}

DayAttribution = {
  "for_date": "YYYY-MM-DD",
  "score": number,
  "primary_cause": {
    "kind": "prior_night" | "morning_routine" | "midday_context" | "evening_compensation",
    "summary": string,
    "evidence": [string],
    "confidence": number
  },
  "secondary_causes": [{ "kind": string, "summary": string, "confidence": number }]
}

RuleSuggestion = {
  "id": string,
  "name": string,
  "rationale": string,
  "trigger": {
    "time_window": "HH:MM-HH:MM",
    "any_pkg":  [string]?,
    "any_place":[string]?,
    "min_duration_min": number,
    "weekday_mask": [0,1,2,3,4,5,6]?
  },
  "action": { "level": 1|2|3, "message": string, "cooldown_min": number }
}

SilencePriors = {
  "by_window": [{
    "window": "HH:MM-HH:MM",
    "place_id": string,
    "label_distribution": { "sleep_or_rest": number, "focused_work": number,
                            "workout": number, "reading": number, "other": number }
  }]
}

SilenceCorrelation = {
  "predictor": string,
  "definition": string,
  "n_days": number,
  "delta_next_day_score_pct": number,
  "p_value_or_method": string
}`;

export interface NightlyUserPromptInput {
  prior: unknown;
  days: unknown[];
  months: unknown[];
  verifiedFacts: SilenceCorrelation[];
}

export function buildNightlyUserPrompt(input: NightlyUserPromptInput): string {
  return `PRIOR:
${JSON.stringify(input.prior ?? {}, null, 2)}

DAYS:
${JSON.stringify(input.days, null, 2)}

MONTHS:
${JSON.stringify(input.months, null, 2)}

VERIFIED_FACTS:
${JSON.stringify(input.verifiedFacts, null, 2)}

Use VERIFIED_FACTS verbatim inside silence_correlations. Do not modify the
numbers. If a fact is absent, omit that correlation — do not estimate.

Return ONLY the merged behavior_profile.data JSON.`;
}

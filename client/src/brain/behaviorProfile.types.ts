/**
 * `behavior_profile.data` v3 type definitions.
 *
 * The nightly profile pass outputs JSON matching this shape.
 * Validated before persisting to behavior_profile.
 */

export type SilenceLabel = 'sleep_or_rest' | 'focused_work' | 'workout' | 'reading' | 'other';

export interface CausalChain {
  upstream_date: string; // 'YYYY-MM-DD'
  downstream_date: string; // 'YYYY-MM-DD'
  /** Each item ends in "(<metric>=<value>)" so the LLM cites real numbers. */
  upstream_events: string[];
  downstream_metric: { name: 'productivity_score'; value: number };
  mechanism: string;
  confidence: number; // 0..1
}

export type DayAttributionKind =
  | 'prior_night'
  | 'morning_routine'
  | 'midday_context'
  | 'evening_compensation';

export interface DayAttribution {
  for_date: string;
  score: number; // mirrors daily_rollup.productivity_score
  primary_cause: {
    kind: DayAttributionKind;
    summary: string;
    evidence: string[];
    confidence: number;
  };
  secondary_causes: { kind: string; summary: string; confidence: number }[];
}

export interface RuleSuggestionTrigger {
  /** "HH:MM-HH:MM" 24h. */
  time_window: string;
  any_pkg?: string[];
  any_place?: string[];
  min_duration_min: number;
  /** 0=Sun … 6=Sat. */
  weekday_mask?: (0 | 1 | 2 | 3 | 4 | 5 | 6)[];
}

export interface RuleSuggestionAction {
  level: 1 | 2 | 3;
  message: string;
  cooldown_min: number;
}

export interface RuleSuggestion {
  /** Stable hash of trigger; used as dedup key when the user accepts. */
  id: string;
  name: string;
  rationale: string;
  trigger: RuleSuggestionTrigger;
  action: RuleSuggestionAction;
}

export interface SilencePriors {
  by_window: {
    window: string; // "HH:MM-HH:MM"
    place_id: string;
    label_distribution: Record<SilenceLabel, number>;
  }[];
}

export interface SilenceCorrelation {
  predictor: string; // e.g. "low_phone_night"
  definition: string;
  n_days: number;
  /** Signed percentage point change in next-day productivity_score. */
  delta_next_day_score_pct: number;
  /** Free-form provenance string e.g. "median diff, n_low=12 vs n_other=18". */
  p_value_or_method: string;
}

/**
 * Forward-compat: the v2 keys (identity, schedule, habits_*, time_wasters,
 * productivity_windows, predictions, open_loops, deviations, model_self_eval)
 * are intentionally typed as `unknown` here. The nightly runner will share
 * a single source of truth for the full shape; this file owns only the v3
 * additions to keep them isolated.
 */
export interface BehaviorProfileV3 {
  schema_version: 3;
  as_of: string;
  based_on_days: number;
  confidence: number;

  identity: unknown;
  schedule: unknown;
  habits_good: unknown;
  habits_bad: unknown;
  time_wasters: unknown;
  productivity_windows: unknown;
  predictions: unknown;
  open_loops: unknown;
  deviations: unknown;
  model_self_eval: unknown;

  // v3 additions.
  causal_chains: CausalChain[];
  day_attribution: DayAttribution;
  rule_suggestions: RuleSuggestion[];
  silence_priors: SilencePriors;
  silence_correlations: SilenceCorrelation[];
}

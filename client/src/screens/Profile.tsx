/**
 * Profile — what the AI thinks it knows about the user.
 *
 * Reads `behavior_profile.data` (BehaviorProfileV3, written nightly by
 * Sonnet) and renders it as: identity blurb, observed habits, verified
 * silence anchors, causal chains (A → B → C pills), and rule suggestions.
 *
 * All v3 keys are typed as `unknown` in BehaviorProfileV3 so we safe-parse
 * each section here without trusting Sonnet's output.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { getProfile } from '../repos/observability';
import type { BehaviorProfileRow } from '../db/schema';
import type {
  CausalChain,
  RuleSuggestion,
  SilenceCorrelation,
} from '../brain/behaviorProfile.types';
import { useTheme } from '../theme';
import { useToast } from '../toast';
import { fmtTime, makeStyles, useAsyncRunner } from './shared';
import { PressableScale, SectionHeader, StatusDot } from './widgets';

interface ParsedProfile {
  identity: string | null;
  habitsGood: string[];
  habitsBad: string[];
  timeWasters: string[];
  silenceCorrelations: SilenceCorrelation[];
  causalChains: CausalChain[];
  ruleSuggestions: RuleSuggestion[];
  confidence: number | null;
  asOf: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function asStringArray(v: unknown, max = 8): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim()) out.push(item);
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const summary =
        asString(o.summary) ?? asString(o.text) ?? asString(o.name) ?? asString(o.label);
      if (summary) out.push(summary);
    }
    if (out.length >= max) break;
  }
  return out;
}

function parseProfile(row: BehaviorProfileRow): ParsedProfile {
  let v: unknown = null;
  try {
    v = JSON.parse(row.data);
  } catch {
    v = null;
  }
  const o = (v ?? {}) as Record<string, unknown>;
  const identityObj = (o.identity ?? {}) as Record<string, unknown>;
  return {
    identity:
      asString(identityObj.summary) ??
      asString(identityObj.description) ??
      asString(o.identity as string),
    habitsGood: asStringArray(o.habits_good),
    habitsBad: asStringArray(o.habits_bad),
    timeWasters: asStringArray(o.time_wasters),
    silenceCorrelations: Array.isArray(o.silence_correlations)
      ? (o.silence_correlations as SilenceCorrelation[])
      : [],
    causalChains: Array.isArray(o.causal_chains) ? (o.causal_chains as CausalChain[]) : [],
    ruleSuggestions: Array.isArray(o.rule_suggestions)
      ? (o.rule_suggestions as RuleSuggestion[])
      : [],
    confidence: typeof o.confidence === 'number' ? o.confidence : null,
    asOf: asString(o.as_of),
  };
}

export function ProfileScreen({ onBack }: { onBack?: () => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const toast = useToast();
  const [row, setRow] = useState<BehaviorProfileRow | null>(null);
  const [parsed, setParsed] = useState<ParsedProfile | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const p = await run('profile', () => getProfile(), setLoading);
      if (p) {
        setRow(p);
        setParsed(parseProfile(p));
      } else {
        setRow(null);
        setParsed(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !row) {
    return (
      <View style={[s.flexFill, { alignItems: 'center', justifyContent: 'center', padding: 40 }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (!row || !parsed) {
    return (
      <ScrollView contentContainerStyle={s.body}>
        <View style={s.card}>
          <Text style={s.label}>No profile yet</Text>
          <Text style={[s.body2, { color: theme.textMuted, marginTop: 6 }]}>
            The nightly Sonnet job will build this once you have at least 3 days of data and an
            Anthropic API key in Settings. Until then there's nothing to show.
          </Text>
        </View>
      </ScrollView>
    );
  }

  const confidencePct =
    parsed.confidence == null ? null : Math.round(parsed.confidence * 100);

  return (
    <ScrollView contentContainerStyle={s.body}>
      {onBack && (
        <Pressable onPress={onBack} hitSlop={10} style={{ marginBottom: 4 }}>
          <Text style={[s.body2, { color: theme.accent, fontWeight: '700' }]}>‹ Settings</Text>
        </Pressable>
      )}
      {/* hero — "the AI's model of you" */}
      <View style={s.card}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
          <Text style={s.label}>Behavior profile</Text>
          {confidencePct != null && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                backgroundColor: theme.chipBg,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 999,
              }}>
              <StatusDot
                color={
                  confidencePct >= 70 ? theme.ok : confidencePct >= 40 ? theme.warn : theme.err
                }
              />
              <Text style={[s.tdMonoSm, { color: theme.text, fontWeight: '700' }]}>
                {confidencePct}% conf
              </Text>
            </View>
          )}
        </View>
        {parsed.identity && (
          <Text style={[s.body, { marginTop: 8, color: theme.text }]}>{parsed.identity}</Text>
        )}
        <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 10 }]}>
          rebuilt {fmtTime(row.built_ts)} · based on {row.based_on_days}d · {row.model}
          {parsed.asOf ? ` · as of ${parsed.asOf}` : ''}
        </Text>
      </View>

      {/* observed patterns */}
      {(parsed.habitsGood.length > 0 || parsed.habitsBad.length > 0) && (
        <>
          <SectionHeader>Observed patterns</SectionHeader>
          {parsed.habitsGood.length > 0 && (
            <View style={s.card}>
              <Text style={[s.label, { color: theme.ok }]}>✓ Good habits</Text>
              <View style={{ marginTop: 6, gap: 6 }}>
                {parsed.habitsGood.map((h, i) => (
                  <BulletRow key={i} text={h} color={theme.ok} />
                ))}
              </View>
            </View>
          )}
          {parsed.habitsBad.length > 0 && (
            <View style={s.card}>
              <Text style={[s.label, { color: theme.err }]}>✗ Friction</Text>
              <View style={{ marginTop: 6, gap: 6 }}>
                {parsed.habitsBad.map((h, i) => (
                  <BulletRow key={i} text={h} color={theme.err} />
                ))}
              </View>
            </View>
          )}
          {parsed.timeWasters.length > 0 && (
            <View style={s.card}>
              <Text style={[s.label, { color: theme.warn }]}>⏵ Time wasters</Text>
              <View style={{ marginTop: 6, gap: 6 }}>
                {parsed.timeWasters.map((h, i) => (
                  <BulletRow key={i} text={h} color={theme.warn} />
                ))}
              </View>
            </View>
          )}
        </>
      )}

      {/* verified silence anchors */}
      {parsed.silenceCorrelations.length > 0 && (
        <>
          <SectionHeader>Verified anchors</SectionHeader>
          <View style={s.card}>
            <Text style={[s.body2, { color: theme.textMuted, marginBottom: 8 }]}>
              Predictors of next-day productivity, computed deterministically from your own data.
            </Text>
            <View style={{ gap: 10 }}>
              {parsed.silenceCorrelations.map((c, i) => {
                const delta = c.delta_next_day_score_pct;
                const color = delta >= 5 ? theme.ok : delta <= -5 ? theme.err : theme.textMuted;
                return (
                  <View key={i} style={{ gap: 2 }}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                      }}>
                      <Text style={[s.body2, { fontWeight: '700', flex: 1 }]} numberOfLines={1}>
                        {c.predictor}
                      </Text>
                      <Text style={[s.tdMono, { color, fontWeight: '700' }]}>
                        {delta >= 0 ? '+' : ''}
                        {delta.toFixed(1)} pts
                      </Text>
                    </View>
                    <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>
                      n={c.n_days}d · {c.p_value_or_method}
                    </Text>
                    <Text style={[s.tdMonoSm, { color: theme.textMuted }]} numberOfLines={2}>
                      {c.definition}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        </>
      )}

      {/* causal chains */}
      {parsed.causalChains.length > 0 && (
        <>
          <SectionHeader>Causal chains</SectionHeader>
          <View style={{ gap: 8 }}>
            {parsed.causalChains.slice(0, 5).map((c, i) => (
              <CausalChainCard key={i} chain={c} />
            ))}
          </View>
        </>
      )}

      {/* derived rule suggestions */}
      {parsed.ruleSuggestions.length > 0 && (
        <>
          <SectionHeader>Suggested rules</SectionHeader>
          <View style={{ gap: 8 }}>
            {parsed.ruleSuggestions.slice(0, 6).map((r) => (
              <View key={r.id} style={s.card}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                  }}>
                  <Text style={[s.body2, { fontWeight: '700', flex: 1 }]} numberOfLines={2}>
                    {r.name}
                  </Text>
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: 6,
                      backgroundColor:
                        r.action.level === 3
                          ? theme.err + '22'
                          : r.action.level === 2
                            ? theme.warn + '22'
                            : theme.info + '22',
                    }}>
                    <Text
                      style={{
                        color:
                          r.action.level === 3
                            ? theme.err
                            : r.action.level === 2
                              ? theme.warn
                              : theme.info,
                        fontSize: 11,
                        fontWeight: '700',
                      }}>
                      L{r.action.level}
                    </Text>
                  </View>
                </View>
                <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 4 }]}>
                  {r.trigger.time_window}
                  {r.trigger.any_pkg && r.trigger.any_pkg.length > 0
                    ? ` · ${r.trigger.any_pkg.slice(0, 2).join(', ')}`
                    : ''}
                  {' · '}
                  {r.trigger.min_duration_min}m+
                </Text>
                <Text style={[s.body2, { color: theme.text, marginTop: 6 }]} numberOfLines={3}>
                  "{r.action.message}"
                </Text>
                <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 4 }]}>
                  {r.rationale}
                </Text>
                <Pressable
                  onPress={() =>
                    toast.ok('Stage 11 will let you turn this into a real rule. Coming soon.')
                  }
                  style={s.btnGhost}>
                  <Text style={s.btnGhostText}>Add as rule →</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function BulletRow({ text, color }: { text: string; color: string }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <View style={{ marginTop: 7 }}>
        <StatusDot color={color} size={6} />
      </View>
      <Text style={[s.body2, { color: theme.text, flex: 1 }]}>{text}</Text>
    </View>
  );
}

function CausalChainCard({ chain }: { chain: CausalChain }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [expanded, setExpanded] = useState(false);
  const score = chain.downstream_metric.value;
  const scoreColor = score >= 0.6 ? theme.ok : score >= 0.4 ? theme.warn : theme.err;
  const conf = Math.round(chain.confidence * 100);
  const upstreamHead = chain.upstream_events[0] ?? '—';
  return (
    <PressableScale onPress={() => setExpanded((v) => !v)}>
      <View style={s.card}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}>
          <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>
            {chain.upstream_date} → {chain.downstream_date}
          </Text>
          <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>{conf}% conf</Text>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
            flexWrap: 'wrap',
          }}>
          <Pill text={upstreamHead} color={theme.accent2} />
          <Text style={{ color: theme.textFaint, fontSize: 14 }}>→</Text>
          <Pill text={chain.mechanism} color={theme.warn} />
          <Text style={{ color: theme.textFaint, fontSize: 14 }}>→</Text>
          <Pill text={`score ${Math.round(score * 100)}`} color={scoreColor} />
        </View>
        {expanded && chain.upstream_events.length > 1 && (
          <View
            style={{
              marginTop: 10,
              paddingTop: 8,
              borderTopWidth: 1,
              borderColor: theme.cardBorder,
              gap: 4,
            }}>
            <Text style={s.subLabel}>All upstream signals</Text>
            {chain.upstream_events.map((e, i) => (
              <Text key={i} style={[s.tdMonoSm, { color: theme.textMuted }]}>
                · {e}
              </Text>
            ))}
          </View>
        )}
      </View>
    </PressableScale>
  );
}

function Pill({ text, color }: { text: string; color: string }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: color + '22',
        borderWidth: 1,
        borderColor: color + '55',
        maxWidth: 200,
      }}>
      <Text
        numberOfLines={1}
        style={{
          color,
          fontSize: 11,
          fontWeight: '700',
          fontFamily: theme.monoFont,
        }}>
        {text}
      </Text>
    </View>
  );
}

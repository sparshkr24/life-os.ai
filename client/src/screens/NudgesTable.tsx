/**
 * Nudges feed — grouped by day with manual thumbs-up/down feedback.
 *
 * The thumbs feedback is INDEPENDENT of the LLM's automated `score_delta`
 * analysis: this is the user's own opinion of whether the nudge fired at
 * the right moment with useful framing. Both signals end up feeding the
 * nightly Sonnet rebuild.
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { listNudges, setNudgeUserHelpful } from '../repos/observability';
import type { NudgeRow } from '../db/schema';
import { useTheme } from '../theme';
import { useToast } from '../toast';
import { fmtClock, fmtTimeShort, makeStyles, useAsyncRunner } from './shared';
import { PressableScale, StatusDot } from './widgets';

type Filter = 'all' | 'rule' | 'smart' | 'helpful' | 'annoying';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'rule', label: 'Rule' },
  { id: 'smart', label: '✦ Smart' },
  { id: 'helpful', label: 'Helpful' },
  { id: 'annoying', label: 'Annoying' },
];

function dayBucket(ts: number): 'today' | 'yesterday' | 'earlier' {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  if (ts >= startMs) return 'today';
  if (ts >= startMs - 24 * 3600_000) return 'yesterday';
  return 'earlier';
}

export function NudgesTable() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const toast = useToast();
  const [rows, setRows] = useState<NudgeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const refresh = async () => {
    const r = await run('nudges', () => listNudges(), setLoading);
    setHasFetched(true);
    if (r) setRows(r);
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === 'all') return true;
      if (filter === 'rule') return r.source === 'rule';
      if (filter === 'smart') return r.source === 'smart';
      if (filter === 'helpful') return r.user_helpful === 1;
      if (filter === 'annoying') return r.user_helpful === -1;
      return true;
    });
  }, [rows, filter]);

  const grouped = useMemo(() => {
    const g: Record<'today' | 'yesterday' | 'earlier', NudgeRow[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const r of filtered) g[dayBucket(r.ts)].push(r);
    return g;
  }, [filtered]);

  const onFeedback = async (id: number, val: 1 | -1 | null) => {
    await setNudgeUserHelpful(id, val);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, user_helpful: val } : r)));
    toast.ok(val === 1 ? 'marked helpful' : val === -1 ? 'marked annoying' : 'cleared');
  };

  return (
    <View style={s.flexFill}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 14, gap: 8 }}>
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <PressableScale key={f.id} onPress={() => setFilter(f.id)}>
              <View
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 999,
                  backgroundColor: active ? theme.accent : theme.chipBg,
                  borderWidth: 1,
                  borderColor: active ? theme.accent : theme.cardBorder,
                }}>
                <Text
                  style={{
                    color: active ? theme.accentText : theme.chipText,
                    fontWeight: '600',
                    fontFamily: theme.monoFont,
                    fontSize: 12,
                  }}>
                  {f.label}
                </Text>
              </View>
            </PressableScale>
          );
        })}
      </ScrollView>

      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120, gap: 8 }}>
        {loading && rows.length === 0 && (
          <View style={s.inlineLoad}>
            <ActivityIndicator color={theme.accent} />
            <Text style={s.muted}>loading…</Text>
          </View>
        )}
        {!loading && hasFetched && filtered.length === 0 && (
          <Text style={[s.muted, { padding: 16 }]}>no nudges match this filter</Text>
        )}
        {(['today', 'yesterday', 'earlier'] as const).map((bucket) => {
          const list = grouped[bucket];
          if (list.length === 0) return null;
          const label =
            bucket === 'today' ? 'Today' : bucket === 'yesterday' ? 'Yesterday' : 'Earlier';
          return (
            <View key={bucket} style={{ gap: 8 }}>
              <Text
                style={{
                  color: theme.text,
                  fontSize: 18,
                  fontWeight: '700',
                  marginTop: 12,
                  marginBottom: 2,
                }}>
                {label}
              </Text>
              {list.map((n) => (
                <NudgeCard
                  key={n.id}
                  nudge={n}
                  expanded={expandedId === n.id}
                  onToggle={() => setExpandedId((x) => (x === n.id ? null : n.id))}
                  onFeedback={(v) => onFeedback(n.id, v)}
                />
              ))}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function NudgeCard({
  nudge,
  expanded,
  onToggle,
  onFeedback,
}: {
  nudge: NudgeRow;
  expanded: boolean;
  onToggle: () => void;
  onFeedback: (v: 1 | -1 | null) => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const levelColor =
    nudge.level === 3 ? theme.err : nudge.level === 2 ? theme.warn : theme.info;
  const llmVerdict =
    nudge.score_delta == null
      ? null
      : nudge.score_delta >= 5
        ? 'helped (+' + Math.round(nudge.score_delta) + ')'
        : nudge.score_delta <= -5
          ? 'hurt (' + Math.round(nudge.score_delta) + ')'
          : 'neutral';
  return (
    <Pressable onPress={onToggle}>
      <View style={s.card}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ marginTop: 6 }}>
            <StatusDot color={levelColor} size={10} glow={nudge.level === 3} />
          </View>
          <View style={{ flex: 1 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}>
              <Text style={[s.body2, { fontWeight: '700', flex: 1 }]} numberOfLines={2}>
                {nudge.message}
              </Text>
              {nudge.source === 'smart' && (
                <View
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 6,
                    backgroundColor: theme.accent2 + '22',
                    borderWidth: 1,
                    borderColor: theme.accent2 + '55',
                  }}>
                  <Text
                    style={{
                      color: theme.accent2,
                      fontSize: 10,
                      fontWeight: '700',
                      letterSpacing: 0.5,
                    }}>
                    ✦ smart
                  </Text>
                </View>
              )}
            </View>
            <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 2 }]}>
              {nudge.source} · L{nudge.level} · {fmtTimeShort(nudge.ts)}
              {llmVerdict ? ` · LLM: ${llmVerdict}` : ''}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PressableScale
              onPress={() => onFeedback(nudge.user_helpful === 1 ? null : 1)}
              hitSlop={8}>
              <Text
                style={{
                  fontSize: 20,
                  opacity: nudge.user_helpful === 1 ? 1 : 0.35,
                  color: nudge.user_helpful === 1 ? theme.ok : theme.text,
                }}>
                ▲
              </Text>
            </PressableScale>
            <PressableScale
              onPress={() => onFeedback(nudge.user_helpful === -1 ? null : -1)}
              hitSlop={8}>
              <Text
                style={{
                  fontSize: 20,
                  opacity: nudge.user_helpful === -1 ? 1 : 0.35,
                  color: nudge.user_helpful === -1 ? theme.err : theme.text,
                }}>
                ▼
              </Text>
            </PressableScale>
          </View>
        </View>
        {expanded && (
          <View
            style={{
              marginTop: 10,
              gap: 6,
              paddingTop: 8,
              borderTopWidth: 1,
              borderColor: theme.cardBorder,
            }}>
            <Text style={s.subLabel}>Reasoning</Text>
            <Text style={[s.tdMono, { color: theme.textMuted }]}>{nudge.reasoning}</Text>
            <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 4 }]}>
              fired at {fmtClock(nudge.ts)}
              {nudge.rule_id ? ` · rule ${nudge.rule_id}` : ''}
              {nudge.llm_call_id ? ` · llm_call ${nudge.llm_call_id}` : ''}
              {nudge.user_action ? ` · action: ${nudge.user_action}` : ''}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

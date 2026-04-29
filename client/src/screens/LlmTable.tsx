import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import {
  listLlmCalls,
  todayLlmSpendUsd,
  type LlmPurposeFilter,
} from '../repos/observability';
import type { LlmCallRow } from '../db/schema';
import { useTheme } from '../theme';
import { fmtTimeShort, makeStyles, useAsyncRunner } from './shared';

const PURPOSES: LlmPurposeFilter[] = [
  'all',
  'nightly_memory',
  'nightly_profile',
  'nightly_nudge',
  'chat',
  'embed',
  'extract',
  'tick',
];

// Short labels for the chip row — the raw purpose names get long.
const PURPOSE_LABELS: Record<LlmPurposeFilter, string> = {
  all: 'all',
  nightly: 'nightly',
  nightly_memory: 'memory',
  nightly_profile: 'profile',
  nightly_nudge: 'nudge',
  chat: 'chat',
  embed: 'embed',
  extract: 'extract',
  tick: 'tick',
};

export function LlmTable() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [purpose, setPurpose] = useState<LlmPurposeFilter>('all');
  const [rows, setRows] = useState<LlmCallRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [spend, setSpend] = useState(0);
  const reqIdRef = useRef(0);

  const refresh = async () => {
    const myReq = ++reqIdRef.current;
    const r = await run(
      'llm calls',
      async () => {
        const [list, sp] = await Promise.all([listLlmCalls(purpose), todayLlmSpendUsd()]);
        return { list, sp };
      },
      setLoading,
    );
    if (myReq !== reqIdRef.current) return;
    setHasFetched(true);
    if (r) {
      setRows(r.list);
      setSpend(r.sp);
    }
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose]);

  return (
    <View style={s.flexFill}>
      <View style={s.toolbar}>
        {PURPOSES.map((p) => (
          <Pressable
            key={p}
            onPress={() => setPurpose(p)}
            style={[s.chipSm, purpose === p && s.chipActive]}>
            <Text style={[s.chipText, purpose === p && s.chipTextActive]}>
              {PURPOSE_LABELS[p]}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.muted}>today's spend: ${spend.toFixed(4)}</Text>
      <View style={s.tableHeader}>
        <Text style={[s.thCell, { flex: 1 }]}>Purpose</Text>
        <Text style={[s.thCell, { flex: 1, textAlign: 'right' }]}>Model</Text>
      </View>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120 }}>
        {loading && rows.length === 0 && (
          <View style={s.inlineLoad}>
            <ActivityIndicator color={theme.accent} />
            <Text style={s.muted}>loading…</Text>
          </View>
        )}
        {!loading && hasFetched && rows.length === 0 && (
          <Text style={s.muted}>no LLM calls yet (Stages 7–9)</Text>
        )}
        {rows.map((r) => {
          const isOpen = expanded === r.id;
          const cost = (r.cost_usd ?? 0).toFixed(4);
          return (
            <Pressable key={r.id} onPress={() => setExpanded(isOpen ? null : r.id)} style={s.tr}>
              <View style={{ flexDirection: 'row', width: '100%', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.td} numberOfLines={1}>
                    {PURPOSE_LABELS[r.purpose as LlmPurposeFilter] ?? r.purpose}
                  </Text>
                  <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 2 }]}>
                    {fmtTimeShort(r.ts)}
                  </Text>
                </View>
                <View style={{ flex: 1, alignItems: 'flex-end' }}>
                  <Text
                    style={[s.tdMono, { color: r.ok ? theme.text : theme.err }]}
                    numberOfLines={1}>
                    {shortModelId(r.model)}
                  </Text>
                  <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 2 }]}>
                    ${cost}
                  </Text>
                </View>
              </View>
              {isOpen && (
                <View style={{ marginTop: 6, gap: 6 }}>
                  <Text style={s.subLabel}>tokens</Text>
                  <Text style={s.tdMono}>
                    in: {r.in_tokens ?? '?'} · out: {r.out_tokens ?? '?'}
                  </Text>
                  <Text style={s.subLabel}>full model id</Text>
                  <Text style={s.tdMono}>{r.model}</Text>
                  {r.error && (
                    <>
                      <Text style={s.subLabel}>error</Text>
                      <Text style={[s.tdMono, { color: theme.err }]}>{r.error}</Text>
                    </>
                  )}
                  <Text style={s.subLabel}>request</Text>
                  <Text style={s.tdMono}>{r.request ?? '—'}</Text>
                  <Text style={s.subLabel}>response</Text>
                  <Text style={s.tdMono}>{r.response ?? '—'}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * Strip trailing date / version suffixes from a model id for compact display.
 * Examples:
 *   gpt-5.4-mini-2026-03-17        → gpt-5.4-mini
 *   claude-sonnet-4-5-20250901     → claude-sonnet-4-5
 *   text-embedding-3-small         → text-embedding-3-small (untouched)
 *   minimax-text-01                → minimax-text-01 (untouched)
 */
function shortModelId(id: string): string {
  if (!id) return '—';
  // Trailing -YYYYMMDD or -YYYY-MM-DD
  return id
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

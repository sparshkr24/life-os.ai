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

const PURPOSES: LlmPurposeFilter[] = ['all', 'nightly', 'tick', 'chat'];

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
            <Text style={[s.chipText, purpose === p && s.chipTextActive]}>{p}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.muted}>today's spend: ${spend.toFixed(4)}</Text>
      <View style={s.tableHeader}>
        <Text style={[s.thCell, { flex: 1.4 }]}>Time</Text>
        <Text style={[s.thCell, { flex: 1 }]}>Purpose</Text>
        <Text style={[s.thCell, { flex: 1.2 }]}>Model</Text>
        <Text style={[s.thCell, { flex: 0.8 }]}>$</Text>
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
          return (
            <Pressable key={r.id} onPress={() => setExpanded(isOpen ? null : r.id)} style={s.tr}>
              <View style={{ flexDirection: 'row', width: '100%' }}>
                <Text style={[s.tdMono, { flex: 1.4 }]}>{fmtTimeShort(r.ts)}</Text>
                <Text style={[s.td, { flex: 1 }]}>{r.purpose}</Text>
                <Text style={[s.tdMono, { flex: 1.2 }]}>{r.model}</Text>
                <Text
                  style={[s.tdMono, { flex: 0.8, color: r.ok ? theme.text : theme.err }]}>
                  {(r.cost_usd ?? 0).toFixed(4)}
                </Text>
              </View>
              {isOpen && (
                <View style={{ marginTop: 6, gap: 6 }}>
                  <Text style={s.subLabel}>tokens</Text>
                  <Text style={s.tdMono}>
                    in: {r.in_tokens ?? '?'} · out: {r.out_tokens ?? '?'}
                  </Text>
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

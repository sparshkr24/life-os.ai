import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { listDailyRollups, listMonthlyRollups } from '../repos/observability';
import { useTheme } from '../theme';
import {
  ActionButton,
  fmtTimeShort,
  makeStyles,
  truncate,
  useAsyncRunner,
} from './shared';

type RollupMode = 'all' | 'daily' | 'monthly';
const ROLLUP_MODES: { id: RollupMode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'daily', label: 'Daily' },
  { id: 'monthly', label: 'Monthly' },
];

interface RollupItem {
  kind: 'daily' | 'monthly';
  key: string; // date or month
  data: string;
  updated_ts: number;
}

export function RollupsScreen() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [mode, setMode] = useState<RollupMode>('all');
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<'asc' | 'desc'>('desc');
  const [items, setItems] = useState<RollupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const refresh = async () => {
    const myReq = ++reqIdRef.current;
    const result = await run(
      'rollups',
      async () => {
        const filter = { text, fromDate: from || undefined, toDate: to || undefined, sort };
        const out: RollupItem[] = [];
        if (mode === 'all' || mode === 'daily') {
          const d = await listDailyRollups(filter);
          d.forEach((r) =>
            out.push({ kind: 'daily', key: r.date, data: r.data, updated_ts: r.updated_ts }),
          );
        }
        if (mode === 'all' || mode === 'monthly') {
          const m = await listMonthlyRollups(filter);
          m.forEach((r) =>
            out.push({ kind: 'monthly', key: r.month, data: r.data, updated_ts: r.updated_ts }),
          );
        }
        // Stable sort by key (descending by default).
        out.sort((a, b) =>
          sort === 'asc' ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key),
        );
        return out;
      },
      setLoading,
    );
    if (myReq !== reqIdRef.current) return;
    setHasFetched(true);
    if (result) setItems(result);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sort]);

  return (
    <View style={s.flexFill}>
      {/* Inner segmented pill: All / Daily / Monthly */}
      <View style={s.segInner}>
        {ROLLUP_MODES.map((m) => {
          const active = mode === m.id;
          return (
            <Pressable
              key={m.id}
              onPress={() => setMode(m.id)}
              style={[s.segInnerItem, active && s.segInnerItemActive]}>
              <Text style={[s.segInnerText, active && s.segInnerTextActive]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={s.toolbar}>
        <TextInput
          placeholder="search…"
          placeholderTextColor={theme.inputPlaceholder}
          value={text}
          onChangeText={setText}
          style={[s.input, { flex: 1 }]}
        />
        <Pressable onPress={() => setSort(sort === 'asc' ? 'desc' : 'asc')} style={s.chipSm}>
          <Text style={s.chipText}>{sort === 'desc' ? '↓' : '↑'}</Text>
        </Pressable>
      </View>
      <View style={s.toolbar}>
        <TextInput
          placeholder="from YYYY-MM-DD"
          placeholderTextColor={theme.inputPlaceholder}
          value={from}
          onChangeText={setFrom}
          style={[s.input, { flex: 1 }]}
        />
        <TextInput
          placeholder="to YYYY-MM-DD"
          placeholderTextColor={theme.inputPlaceholder}
          value={to}
          onChangeText={setTo}
          style={[s.input, { flex: 1 }]}
        />
        <ActionButton onPress={refresh} loading={loading} label="Apply" variant="inline" />
      </View>
      <View style={s.tableHeader}>
        <Text style={[s.thCell, { flex: 0.7 }]}>Type</Text>
        <Text style={[s.thCell, { flex: 1.2 }]}>Key</Text>
        <Text style={[s.thCell, { flex: 1.2 }]}>Updated</Text>
        <Text style={[s.thCell, { flex: 2 }]}>Preview</Text>
      </View>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120 }}>
        {loading && items.length === 0 && (
          <View style={s.inlineLoad}>
            <ActivityIndicator color={theme.accent} />
            <Text style={s.muted}>loading…</Text>
          </View>
        )}
        {!loading && hasFetched && items.length === 0 && (
          <Text style={s.muted}>none yet · populated by aggregator (Stage 5)</Text>
        )}
        {items.map((r) => {
          const id = r.kind + ':' + r.key;
          const isOpen = expanded === id;
          const tint = r.kind === 'daily' ? theme.accent : theme.accent3;
          return (
            <Pressable key={id} onPress={() => setExpanded(isOpen ? null : id)} style={s.tr}>
              <View style={{ flexDirection: 'row' }}>
                <View style={[s.kindBadge, { borderColor: tint }]}>
                  <Text style={[s.kindBadgeText, { color: tint }]}>
                    {r.kind === 'daily' ? 'D' : 'M'}
                  </Text>
                </View>
                <Text style={[s.td, { flex: 1.2, marginLeft: 6 }]}>{r.key}</Text>
                <Text style={[s.tdMono, { flex: 1.2 }]}>{fmtTimeShort(r.updated_ts)}</Text>
                <Text style={[s.tdMono, { flex: 2 }]} numberOfLines={isOpen ? undefined : 1}>
                  {isOpen ? r.data : truncate(r.data, 80)}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

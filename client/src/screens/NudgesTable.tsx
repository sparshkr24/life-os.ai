import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { listNudges } from '../repos/observability';
import type { NudgeRow } from '../db/schema';
import { useTheme } from '../theme';
import { fmtTimeShort, makeStyles, useAsyncRunner } from './shared';

export function NudgesTable() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [rows, setRows] = useState<NudgeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await run('nudges', () => listNudges(), setLoading);
      setHasFetched(true);
      if (r) setRows(r);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={s.flexFill}>
      <View style={s.tableHeader}>
        <Text style={[s.thCell, { flex: 1.3 }]}>Time</Text>
        <Text style={[s.thCell, { flex: 0.8 }]}>Source</Text>
        <Text style={[s.thCell, { flex: 0.5 }]}>Lvl</Text>
        <Text style={[s.thCell, { flex: 2 }]}>Why</Text>
      </View>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120 }}>
        {loading && rows.length === 0 && (
          <View style={s.inlineLoad}>
            <ActivityIndicator color={theme.accent} />
            <Text style={s.muted}>loading…</Text>
          </View>
        )}
        {!loading && hasFetched && rows.length === 0 && (
          <Text style={s.muted}>no nudges yet (Stages 6–7)</Text>
        )}
        {rows.map((r) => (
          <View key={r.id} style={s.tr}>
            <View style={{ flexDirection: 'row', width: '100%' }}>
              <Text style={[s.tdMono, { flex: 1.3 }]}>{fmtTimeShort(r.ts)}</Text>
              <Text style={[s.td, { flex: 0.8 }]}>{r.source}</Text>
              <Text style={[s.td, { flex: 0.5 }]}>L{r.level}</Text>
              <Text style={[s.td, { flex: 2 }]}>{r.message}</Text>
            </View>
            <Text style={s.subLabel}>reasoning</Text>
            <Text style={s.tdMono}>{r.reasoning}</Text>
            <Text style={s.muted}>
              {r.source === 'rule' && r.rule_id ? `rule: ${r.rule_id}` : ''}
              {r.source === 'smart' && r.llm_call_id ? `llm_call_id: ${r.llm_call_id}` : ''}
              {r.user_action ? ` · action: ${r.user_action}` : ''}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

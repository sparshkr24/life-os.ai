import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { eventCounts, todayLlmSpendUsd, getProfile } from '../repos/observability';
import type { BehaviorProfileRow } from '../db/schema';
import { reopenDb } from '../db';
import { useTheme } from '../theme';
import { LifeOsBridge } from '../bridge/lifeOsBridge';
import {
  ActionButton,
  fmtTime,
  makeStyles,
  useAsyncRunner,
  type TabId,
} from './shared';

export function TodayScreen({ onTab }: { onTab: (t: TabId) => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [counts, setCounts] = useState<{ total: number; lastHour: number } | null>(null);
  const [spend, setSpend] = useState(0);
  const [profile, setProfile] = useState<BehaviorProfileRow | null>(null);
  const [svc, setSvc] = useState<{
    totalEvents: number;
    eventsLastHour: number;
    lastInsertTs: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    await run(
      'today refresh',
      async () => {
        // Drop the cached JS handle so we don't read a stale WAL snapshot from
        // before the foreground service's most recent INSERTs.
        await reopenDb();
        const native = Platform.OS === 'android' && !!LifeOsBridge;
        const [c, sp, p, st] = await Promise.all([
          eventCounts(),
          todayLlmSpendUsd(),
          getProfile(),
          native ? LifeOsBridge.getStats() : Promise.resolve(null),
        ]);
        setCounts(c);
        setSpend(sp);
        setProfile(p);
        if (st)
          setSvc({
            totalEvents: st.totalEvents,
            eventsLastHour: st.eventsLastHour,
            lastInsertTs: st.lastInsertTs,
          });
      },
      setLoading,
    );
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Health verdict for the service: if last insert was >5 min ago we flag it.
  const svcHealth = useMemo(() => {
    if (!svc || svc.lastInsertTs === 0) return { label: 'no data yet', color: theme.warn };
    const ageMs = Date.now() - svc.lastInsertTs;
    if (ageMs < 5 * 60_000) return { label: 'live', color: theme.ok };
    if (ageMs < 30 * 60_000) return { label: 'idle', color: theme.warn };
    return { label: 'stalled', color: theme.err };
  }, [svc, theme]);

  return (
    <ScrollView contentContainerStyle={s.body}>
      <View style={s.card}>
        <Text style={s.label}>Events</Text>
        <Text style={s.h2}>{counts ? counts.total : '—'}</Text>
        <Text style={s.muted}>{counts ? counts.lastHour : '—'} in the last hour</Text>
        <Pressable onPress={() => onTab('observe')} style={s.btnGhost}>
          <Text style={s.btnGhostText}>Browse →</Text>
        </Pressable>
      </View>

      {svc && (
        <View style={s.card}>
          <Text style={s.label}>Collector service</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: svcHealth.color,
              }}
            />
            <Text style={[s.body2, { color: svcHealth.color, fontWeight: '700' }]}>
              {svcHealth.label}
            </Text>
          </View>
          <Text style={s.muted}>
            last insert: {svc.lastInsertTs > 0 ? fmtTime(svc.lastInsertTs) : 'never'}
          </Text>
          <Text style={s.muted}>last hour: {svc.eventsLastHour} events</Text>
          {svcHealth.label !== 'live' && (
            <Pressable
              onPress={async () => {
                await run('restart service', async () => {
                  await LifeOsBridge.startService();
                });
                await refresh();
              }}
              style={s.btnGhost}>
              <Text style={s.btnGhostText}>Restart service →</Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={s.card}>
        <Text style={s.label}>LLM spend today</Text>
        <Text style={s.h2}>${spend.toFixed(4)}</Text>
      </View>

      <View style={s.card}>
        <Text style={s.label}>Behavior profile</Text>
        {profile ? (
          <Text style={s.body2}>built {fmtTime(profile.built_ts)}</Text>
        ) : (
          <Text style={s.muted}>not built yet · runs nightly (Stage 8)</Text>
        )}
        <Pressable onPress={() => onTab('settings')} style={s.btnGhost}>
          <Text style={s.btnGhostText}>View in Settings →</Text>
        </Pressable>
      </View>

      <ActionButton onPress={refresh} loading={loading} label="Refresh" />
    </ScrollView>
  );
}

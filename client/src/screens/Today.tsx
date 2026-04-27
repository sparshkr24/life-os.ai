/**
 * Today — the user's only screen 90% of the time.
 *
 * Layout (top → bottom):
 *   1. Date strip + tracking pill
 *   2. Hero card  — productivity score (huge) + delta + 7-day sparkline
 *   3. Sleep card — bedtime → wake, duration
 *   4. Apps card  — top 3 with category tints + colored app avatars
 *   5. Nudges     — last 3 nudges today (with thumbs up/down)
 *   6. System     — collapsed by default; all the "Run … now" buttons
 */
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import {
  eventCounts,
  getProfile,
  getLatestDailyRollup,
  listNudges,
  recentProductivityScores,
  setNudgeUserHelpful,
  todayLlmSpendUsd,
} from '../repos/observability';
import type { BehaviorProfileRow, NudgeRow } from '../db/schema';
import { reopenDb, withDb } from '../db';
import { useTheme } from '../theme';
import { LifeOsBridge } from '../bridge/lifeOsBridge';
import { runAggregatorTick } from '../aggregator';
import { aggregatorTaskStatus } from '../aggregator/worker';
import { evaluateRules } from '../rules/engine';
import { lastRulesTickTs } from '../rules/worker';
import { runSmartNudgeTick } from '../brain/smartNudge';
import { runNightlyRebuild, lastNightlyTs } from '../brain/nightly';
import { useToast } from '../toast';
import {
  ActionButton,
  fmtClock,
  fmtTime,
  makeStyles,
  prettyPkg,
  useAsyncRunner,
  type TabId,
} from './shared';
import {
  AppIcon,
  PressableScale,
  ScoreBar,
  SectionHeader,
  Sparkline,
  StatusDot,
} from './widgets';

interface RollupApps {
  pkg: string;
  minutes: number;
  category?: 'productive' | 'neutral' | 'unproductive' | string;
}
interface RollupSleep {
  start?: string | null;
  end?: string | null;
  duration_min?: number | null;
}
interface ParsedRollup {
  topApps: RollupApps[];
  sleep: RollupSleep | null;
  productivity_score_pct: number | null;
  date: string | null;
}

function parseRollup(json: string | null, score: number | null, date: string): ParsedRollup {
  let v: unknown = null;
  if (json) {
    try {
      v = JSON.parse(json);
    } catch {
      v = null;
    }
  }
  const o = (v ?? {}) as Record<string, unknown>;
  const apps = Array.isArray(o.by_app)
    ? (o.by_app as RollupApps[]).filter((a) => (a.minutes ?? 0) > 0).slice(0, 3)
    : [];
  const sleep = (o.sleep as RollupSleep | undefined) ?? null;
  return {
    topApps: apps,
    sleep,
    productivity_score_pct: score == null ? null : Math.round(score * 100),
    date,
  };
}

function shortHm(s: string): string {
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : s;
}

export function TodayScreen({ onTab }: { onTab: (t: TabId) => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const toast = useToast();

  const [counts, setCounts] = useState<{ total: number; lastHour: number } | null>(null);
  const [spend, setSpend] = useState(0);
  const [profile, setProfile] = useState<BehaviorProfileRow | null>(null);
  const [agg, setAgg] = useState<{ registered: boolean; lastTickTs: number | null } | null>(null);
  const [svc, setSvc] = useState<{ totalEvents: number; eventsLastHour: number; lastInsertTs: number } | null>(null);
  const [nightly, setNightly] = useState<number | null>(null);
  const [rollup, setRollup] = useState<ParsedRollup | null>(null);
  const [scoreHistory, setScoreHistory] = useState<(number | null)[]>([]);
  const [nudgesToday, setNudgesToday] = useState<NudgeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSystem, setShowSystem] = useState(false);

  const refresh = async () => {
    await run(
      'today',
      async () => {
        await reopenDb();
        const native = Platform.OS === 'android' && !!LifeOsBridge;
        const [c, sp, p, st, taskState, lastTick, latest, history, allNudges] = await Promise.all([
          eventCounts(),
          todayLlmSpendUsd(),
          getProfile(),
          native ? LifeOsBridge.getStats() : Promise.resolve(null),
          aggregatorTaskStatus(),
          withDb((db) =>
            db.getFirstAsync<{ value: string } | null>(
              `SELECT value FROM schema_meta WHERE key = ?`,
              ['last_aggregator_ts'],
            ),
          ),
          getLatestDailyRollup(),
          recentProductivityScores(7),
          listNudges(20),
        ]);
        setCounts(c);
        setSpend(sp);
        setProfile(p);
        setAgg({
          registered: taskState.registered,
          lastTickTs: lastTick?.value ? Number(lastTick.value) : null,
        });
        if (st)
          setSvc({
            totalEvents: st.totalEvents,
            eventsLastHour: st.eventsLastHour,
            lastInsertTs: st.lastInsertTs,
          });
        setNightly(await lastNightlyTs());
        setRollup(latest ? parseRollup(latest.data, latest.productivity_score, latest.date) : null);
        setScoreHistory(history.map((h) => (h.score == null ? null : Math.round(h.score * 100))));
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        setNudgesToday(allNudges.filter((n) => n.ts >= startOfDay.getTime()).slice(0, 3));
      },
      setLoading,
    );
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const svcHealth = useMemo(() => {
    if (!svc || svc.lastInsertTs === 0) return { label: 'no data', color: theme.warn };
    const ageMs = Date.now() - svc.lastInsertTs;
    if (ageMs < 5 * 60_000) return { label: 'live', color: theme.ok };
    if (ageMs < 30 * 60_000) return { label: 'idle', color: theme.warn };
    return { label: 'stalled', color: theme.err };
  }, [svc, theme]);

  const score = rollup?.productivity_score_pct;
  const present = scoreHistory.filter((v): v is number => typeof v === 'number');
  const baseline = present.length
    ? Math.round(present.reduce((a, b) => a + b, 0) / present.length)
    : null;
  const delta = score != null && baseline != null ? score - baseline : null;
  const dateLabel = useMemo(() => {
    return new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: '2-digit',
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={s.body}>
      {/* date + live tracking pill */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
        }}>
        <Text style={[s.label, { color: theme.textMuted }]}>{dateLabel}</Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: theme.chipBg,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 999,
          }}>
          <StatusDot color={svcHealth.color} glow={svcHealth.label === 'live'} />
          <Text style={[s.tdMonoSm, { color: svcHealth.color, fontWeight: '700' }]}>
            {svcHealth.label}
          </Text>
        </View>
      </View>

      {/* hero score */}
      <View style={s.card}>
        <Text style={s.label}>Productivity</Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12, marginTop: 4 }}>
          <Text style={[s.h2, { fontSize: 56, lineHeight: 60 }]}>
            {score == null ? '—' : score}
          </Text>
          <Text style={[s.body2, { color: theme.textMuted }]}>/ 100</Text>
          {delta != null && (
            <Text
              style={[
                s.tdMono,
                {
                  marginLeft: 'auto',
                  color: delta >= 0 ? theme.ok : theme.err,
                  fontWeight: '700',
                },
              ]}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}
            </Text>
          )}
        </View>
        <View style={{ marginTop: 8 }}>
          <ScoreBar score={score ?? 0} baseline={baseline ?? undefined} height={8} />
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 10,
          }}>
          <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>
            {baseline != null ? `7-day median ${baseline}` : 'no baseline yet'}
          </Text>
          <Sparkline values={scoreHistory} width={120} height={24} color={theme.accent} />
        </View>
      </View>

      {/* sleep snapshot */}
      {rollup?.sleep && (rollup.sleep.start || rollup.sleep.end) && (
        <View style={s.card}>
          <Text style={s.label}>Sleep</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <Text style={[s.h2, { fontSize: 22 }]}>
              {rollup.sleep.start ? shortHm(rollup.sleep.start) : '—'}
              <Text style={[s.body2, { color: theme.textMuted }]}>{' → '}</Text>
              {rollup.sleep.end ? shortHm(rollup.sleep.end) : '—'}
            </Text>
            <Text style={[s.body2, { color: theme.textMuted, marginLeft: 'auto' }]}>
              {rollup.sleep.duration_min
                ? `${Math.floor(rollup.sleep.duration_min / 60)}h ${Math.round(
                    rollup.sleep.duration_min % 60,
                  )}m`
                : '—'}
            </Text>
          </View>
        </View>
      )}

      {/* top apps */}
      {rollup?.topApps && rollup.topApps.length > 0 && (
        <View style={s.card}>
          <Text style={s.label}>Top apps today</Text>
          <View style={{ marginTop: 6, gap: 10 }}>
            {rollup.topApps.map((a) => {
              const minutes = Math.round(a.minutes ?? 0);
              const pretty = prettyPkg(a.pkg);
              const catColor =
                a.category === 'productive'
                  ? theme.ok
                  : a.category === 'unproductive'
                    ? theme.err
                    : theme.textMuted;
              return (
                <View
                  key={a.pkg}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <AppIcon label={pretty} pkg={a.pkg} fallback={theme.accent} size={32} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.body2, { fontWeight: '600' }]}>{pretty}</Text>
                    <Text style={[s.tdMonoSm, { color: catColor }]}>
                      {a.category ?? 'neutral'}
                    </Text>
                  </View>
                  <Text style={[s.tdMono, { fontWeight: '700' }]}>{minutes}m</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* nudges today */}
      {nudgesToday.length > 0 && (
        <View style={s.card}>
          <Text style={s.label}>Nudges today</Text>
          <View style={{ marginTop: 6, gap: 12 }}>
            {nudgesToday.map((n) => (
              <NudgeRowToday
                key={n.id}
                nudge={n}
                onFeedback={async (val) => {
                  await setNudgeUserHelpful(n.id, val);
                  setNudgesToday((prev) =>
                    prev.map((x) => (x.id === n.id ? { ...x, user_helpful: val } : x)),
                  );
                  toast.ok(
                    val === 1 ? 'marked helpful' : val === -1 ? 'marked annoying' : 'cleared',
                  );
                }}
              />
            ))}
          </View>
        </View>
      )}

      {/* system / debug — collapsed */}
      <Pressable onPress={() => setShowSystem((v) => !v)}>
        <View style={[s.card, { marginTop: 8, opacity: 0.85 }]}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
            <Text style={s.label}>System</Text>
            <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>
              {showSystem ? '▾ hide' : '▸ show'}
            </Text>
          </View>
          <Text style={[s.body2, { color: theme.textMuted }]}>
            ${spend.toFixed(4)} spent · {counts?.total ?? '—'} events · {nudgesToday.length} nudges
          </Text>
        </View>
      </Pressable>
      {showSystem && (
        <View style={{ gap: 10 }}>
          <SystemRow
            title="Aggregator"
            subtitle={agg?.registered ? '15 min · registered' : 'not registered'}
            tail={agg?.lastTickTs ? fmtTime(agg.lastTickTs) : 'never'}
            cta="Run aggregator now"
            onPress={async () => {
              await run('aggregator', async () => {
                const r = await runAggregatorTick();
                if (r.ok) toast.ok(`agg ok ${r.durationMs}ms · score ${r.scoreToday ?? '—'}`);
                else toast.error('agg failed: ' + (r.error ?? 'unknown'));
              });
              await refresh();
            }}
          />
          <SystemRow
            title="Rules"
            subtitle="60 s loop"
            tail={lastRulesTickTs() > 0 ? fmtTime(lastRulesTickTs()) : 'never'}
            cta="Run rules now"
            onPress={async () => {
              await run('rules', async () => {
                const r = await evaluateRules();
                if (r.errors.length > 0) toast.error('rules: ' + r.errors[0]);
                else toast.ok(`rules · ${r.fired.length} fired / ${r.evaluated} evaluated`);
              });
              await refresh();
            }}
          />
          <SystemRow
            title="Smart nudge"
            subtitle="gpt-4o-mini · 15 min"
            tail={`$${spend.toFixed(4)} today`}
            cta="Run smart nudge now"
            onPress={async () => {
              await run('smart', async () => {
                const r = await runSmartNudgeTick();
                if (r.error) toast.error('smart: ' + r.error);
                else if (r.skipped) toast.ok(`smart skipped (${r.skipped})`);
                else if (r.fired) toast.ok(`smart fired L${r.level} · $${r.costUsd.toFixed(5)}`);
                else toast.ok(`smart no-nudge · $${r.costUsd.toFixed(5)}`);
              });
              await refresh();
            }}
          />
          <SystemRow
            title="Nightly profile"
            subtitle="claude-sonnet · 03:00"
            tail={nightly ? fmtTime(nightly) : 'never'}
            cta="Run nightly now"
            onPress={async () => {
              await run('nightly', async () => {
                const r = await runNightlyRebuild();
                if (r.error) toast.error('nightly: ' + r.error);
                else if (r.skipped) toast.ok(`nightly skipped (${r.skipped})`);
                else if (r.ok)
                  toast.ok(`nightly ok · ${r.basedOnDays}d · $${r.costUsd.toFixed(4)}`);
              });
              await refresh();
            }}
          />
          {profile && (
            <SystemRow
              title="Profile"
              subtitle={`built · ${profile.based_on_days}d`}
              tail={fmtTime(profile.built_ts)}
              cta="Open profile tab"
              onPress={() => onTab('profile' as TabId)}
            />
          )}
          {svcHealth.label !== 'live' && (
            <SystemRow
              title="Collector"
              subtitle="foreground service"
              tail={svc?.lastInsertTs ? fmtTime(svc.lastInsertTs) : 'never'}
              cta="Restart service"
              onPress={async () => {
                await run('restart service', async () => {
                  await LifeOsBridge.startService();
                });
                await refresh();
              }}
            />
          )}
        </View>
      )}

      <SectionHeader>Refresh</SectionHeader>
      <ActionButton onPress={refresh} loading={loading} label="Refresh" />
    </ScrollView>
  );
}

function NudgeRowToday({
  nudge,
  onFeedback,
}: {
  nudge: NudgeRow;
  onFeedback: (v: 1 | -1 | null) => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const levelColor = nudge.level === 3 ? theme.err : nudge.level === 2 ? theme.warn : theme.info;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ marginTop: 6 }}>
        <StatusDot color={levelColor} size={9} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.body2, { fontWeight: '700' }]} numberOfLines={2}>
          {nudge.message}
        </Text>
        <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 2 }]}>
          {nudge.source} · {fmtClock(nudge.ts)}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <PressableScale
          onPress={() => onFeedback(nudge.user_helpful === 1 ? null : 1)}
          hitSlop={6}>
          <Text
            style={{
              fontSize: 18,
              opacity: nudge.user_helpful === 1 ? 1 : 0.35,
              color: nudge.user_helpful === 1 ? theme.ok : theme.text,
            }}>
            ▲
          </Text>
        </PressableScale>
        <PressableScale
          onPress={() => onFeedback(nudge.user_helpful === -1 ? null : -1)}
          hitSlop={6}>
          <Text
            style={{
              fontSize: 18,
              opacity: nudge.user_helpful === -1 ? 1 : 0.35,
              color: nudge.user_helpful === -1 ? theme.err : theme.text,
            }}>
            ▼
          </Text>
        </PressableScale>
      </View>
    </View>
  );
}

function SystemRow({
  title,
  subtitle,
  tail,
  cta,
  onPress,
}: {
  title: string;
  subtitle: string;
  tail: string;
  cta: string;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  return (
    <View style={s.card}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}>
        <Text style={[s.body2, { fontWeight: '700' }]}>{title}</Text>
        <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>{tail}</Text>
      </View>
      <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>{subtitle}</Text>
      <Pressable onPress={onPress} style={s.btnGhost}>
        <Text style={s.btnGhostText}>{cta} →</Text>
      </Pressable>
    </View>
  );
}

/**
 * Rollups dashboard.
 *
 * The list shows compact tiles (date + score chip + top app). Tapping a tile
 * opens a buttery bottom sheet anchored at 50% screen height with a real
 * insight dashboard: score-vs-yesterday delta, sleep delta, wake info,
 * top apps with category split, predicted productivity, nudges/todos.
 *
 * Why a bottom sheet (not a collapsible drawer): the drawer pushed the rest
 * of the list around and capped the data on small screens. The sheet floats
 * over the list, can be scrolled internally, and dismisses on backdrop tap.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import { listDailyRollups, listMonthlyRollups } from '../repos/observability';
import { withDb } from '../db';
import { useTheme, type ThemeTokens } from '../theme';
import { ActionButton, fmtTimeShort, makeStyles, prettyPkg, useAsyncRunner } from './shared';
import { AppIcon, ScoreBar, SectionHeader, StatusDot } from './widgets';

type RollupMode = 'daily' | 'monthly';
const ROLLUP_MODES: { id: RollupMode; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'monthly', label: 'Monthly' },
];

interface DailyTile {
  kind: 'daily';
  key: string; // YYYY-MM-DD
  data: string;
  updated_ts: number;
  productivity_score: number | null;
}
interface MonthlyTile {
  kind: 'monthly';
  key: string; // YYYY-MM
  data: string;
  updated_ts: number;
}
type Tile = DailyTile | MonthlyTile;

// ─── shape mirrors aggregator/rollup.ts + monthlyFold.ts (kept loose so a
//     partial / older rollup still renders without throwing).

interface DailyData {
  date?: string;
  sleep?: {
    start?: string | null;
    end?: string | null;
    start_ts?: number | null;
    end_ts?: number | null;
    duration_min?: number;
    confidence?: number;
  };
  wake_first_app?: string | null;
  first_pickup_min_after_wake?: number | null;
  screen_on_minutes?: number;
  by_app?: { pkg: string; minutes: number; sessions?: number; category: string }[];
  by_category?: Record<string, number>;
  late_night_screen_min?: number;
  places?: { id: string; minutes: number }[];
  steps?: number;
  active_minutes?: number;
  todos?: { created: number; completed: number };
  nudges?: { fired: number; acted: number; dismissed: number };
  silences?: { duration_min: number; label: string; confidence: number }[];
  predictive_insights?: PredictiveInsightsBlock;
}

interface PredictiveInsightsBlock {
  generated_ts: number;
  query: string;
  insights: {
    memory_id: string;
    type: string;
    summary: string;
    cause: string | null;
    effect: string | null;
    impact_score: number;
    confidence: number;
    similarity: number;
  }[];
}

interface MonthlyData {
  month?: string;
  days_observed?: number;
  avg_productivity_score?: number | null;
  top_apps?: { pkg: string; total_minutes: number }[];
  by_category_minutes?: Record<string, number>;
  sleep?: { p50_min?: number | null; p90_min?: number | null };
  places?: { id: string; total_minutes: number }[];
  total_steps?: number;
  total_active_minutes?: number;
  totals?: {
    nudges_fired: number;
    nudges_acted: number;
    todos_created: number;
    todos_completed: number;
  };
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function RollupsScreen() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [mode, setMode] = useState<RollupMode>('daily');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [openTile, setOpenTile] = useState<Tile | null>(null);
  const reqIdRef = useRef(0);

  const refresh = async () => {
    const myReq = ++reqIdRef.current;
    const out = await run(
      'rollups',
      async () => {
        const filter = { fromDate: from || undefined, toDate: to || undefined, sort: 'desc' as const };
        if (mode === 'daily') {
          const d = await listDailyRollups(filter);
          return d.map<DailyTile>((r) => ({
            kind: 'daily',
            key: r.date,
            data: r.data,
            updated_ts: r.updated_ts,
            productivity_score: r.productivity_score,
          }));
        }
        const m = await listMonthlyRollups(filter);
        return m.map<MonthlyTile>((r) => ({
          kind: 'monthly',
          key: r.month,
          data: r.data,
          updated_ts: r.updated_ts,
        }));
      },
      setLoading,
    );
    if (myReq !== reqIdRef.current) return;
    setHasFetched(true);
    if (out) setTiles(out);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <View style={s.flexFill}>
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
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 140 }}>
        {loading && tiles.length === 0 && (
          <View style={s.inlineLoad}>
            <ActivityIndicator color={theme.accent} />
            <Text style={s.muted}>loading…</Text>
          </View>
        )}
        {!loading && hasFetched && tiles.length === 0 && (
          <Text style={[s.muted, { padding: 16 }]}>
            no rollups yet · populated by the aggregator (Stage 5)
          </Text>
        )}
        {tiles.map((t) => (
          <CompactTile key={t.key} tile={t} onPress={() => setOpenTile(t)} />
        ))}
      </ScrollView>

      <RollupDetailSheet tile={openTile} onClose={() => setOpenTile(null)} />
    </View>
  );
}

// ────────────────────────────────────────────────────────────── compact tile

function CompactTile({ tile, onPress }: { tile: Tile; onPress: () => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const data = useMemo(
    () =>
      tile.kind === 'daily'
        ? safeParse<DailyData>(tile.data) ?? {}
        : safeParse<MonthlyData>(tile.data) ?? {},
    [tile.data, tile.kind],
  );

  const score = scoreToPct(
    tile.kind === 'daily'
      ? tile.productivity_score
      : (data as MonthlyData).avg_productivity_score ?? null,
  );
  const scoreColor = scoreTint(theme, score);

  let topPkg: string | undefined;
  let topMin = 0;
  if (tile.kind === 'daily') {
    const a = (data as DailyData).by_app?.[0];
    if (a) {
      topPkg = a.pkg;
      topMin = a.minutes;
    }
  } else {
    const a = (data as MonthlyData).top_apps?.[0];
    if (a) {
      topPkg = a.pkg;
      topMin = a.total_minutes;
    }
  }
  const subtitle =
    tile.kind === 'daily'
      ? `updated ${fmtTimeShort(tile.updated_ts)}`
      : `${(data as MonthlyData).days_observed ?? 0} days · updated ${fmtTimeShort(tile.updated_ts)}`;

  return (
    <Pressable onPress={onPress} style={{ marginHorizontal: 14, marginVertical: 4 }}>
      <View style={s.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.body2, { fontWeight: '700' }]}>{tile.key}</Text>
            <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>{subtitle}</Text>
          </View>
          {topPkg && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <AppIcon
                label={prettyPkg(topPkg)}
                pkg={topPkg}
                fallback={theme.accent}
                size={26}
              />
              <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                {Math.round(topMin)}m
              </Text>
            </View>
          )}
          <Text style={[s.h2, { fontSize: 28, color: scoreColor }]}>
            {score == null ? '—' : score}
          </Text>
        </View>
        {score != null && (
          <View style={{ marginTop: 8 }}>
            <ScoreBar score={score} height={6} />
          </View>
        )}
      </View>
    </Pressable>
  );
}

// ────────────────────────────────────────────────────── bottom sheet shell

const SCREEN_H = Dimensions.get('window').height;
const SHEET_H = Math.round(SCREEN_H * 0.5);
const SHEET_DRAG_DISMISS = 80;

function RollupDetailSheet({
  tile,
  onClose,
}: {
  tile: Tile | null;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const visible = !!tile;
  const translateY = useRef(new Animated.Value(SHEET_H)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: 320,
          easing: Easing.bezier(0.22, 1, 0.36, 1), // smooth ease-out
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, translateY, backdrop]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SHEET_H,
        duration: 220,
        easing: Easing.bezier(0.4, 0, 1, 1),
        useNativeDriver: true,
      }),
      Animated.timing(backdrop, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) onClose();
    });
  };

  // drag-to-dismiss on the handle area
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > SHEET_DRAG_DISMISS) {
          dismiss();
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 6,
          }).start();
        }
      },
    }),
  ).current;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss}>
      <Animated.View
        style={{
          flex: 1,
          backgroundColor: backdrop.interpolate({
            inputRange: [0, 1],
            outputRange: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)'],
          }),
        }}>
        <Pressable style={{ flex: 1 }} onPress={dismiss} />
        <Animated.View
          style={{
            height: SHEET_H,
            transform: [{ translateY }],
            backgroundColor: theme.bg,
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
            borderTopWidth: 1,
            borderColor: theme.cardBorder,
            shadowColor: '#000',
            shadowOpacity: 0.35,
            shadowRadius: 24,
            shadowOffset: { width: 0, height: -6 },
            elevation: 18,
          }}>
          <View {...pan.panHandlers} style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
            <View
              style={{
                width: 42,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.cardBorder,
              }}
            />
          </View>
          {tile && (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 28 }}>
              {tile.kind === 'daily' ? (
                <DailyDetail tile={tile} />
              ) : (
                <MonthlyDetail tile={tile} />
              )}
            </ScrollView>
          )}
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <Pressable onPress={dismiss} hitSlop={12}>
              <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>tap to close</Text>
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────── daily detail

function DailyDetail({ tile }: { tile: DailyTile }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const data = useMemo(() => safeParse<DailyData>(tile.data) ?? {}, [tile.data]);
  const [prev, setPrev] = useState<{ score: number | null; data: DailyData } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const row = await withDb((db) =>
        db.getFirstAsync<{ data: string; productivity_score: number | null }>(
          `SELECT data, productivity_score FROM daily_rollup
           WHERE date < ? ORDER BY date DESC LIMIT 1`,
          [tile.key],
        ),
      );
      if (!alive) return;
      if (!row) {
        setPrev(null);
        return;
      }
      setPrev({
        score: row.productivity_score,
        data: safeParse<DailyData>(row.data) ?? {},
      });
    })();
    return () => {
      alive = false;
    };
  }, [tile.key]);

  const score = scoreToPct(tile.productivity_score);
  const prevScore = scoreToPct(prev?.score ?? null);
  const scoreDelta = score != null && prevScore != null ? score - prevScore : null;

  const sleepMin = data.sleep?.duration_min ?? 0;
  const prevSleepMin = prev?.data.sleep?.duration_min ?? 0;
  const sleepDelta = prev && prevSleepMin > 0 ? sleepMin - prevSleepMin : null;

  const screenMin = data.screen_on_minutes ?? 0;
  const prevScreenMin = prev?.data.screen_on_minutes ?? 0;
  const screenDelta = prev && prevScreenMin > 0 ? screenMin - prevScreenMin : null;

  const apps = (data.by_app ?? []).filter((a) => a.minutes > 0).slice(0, 6);
  const cats = Object.entries(data.by_category ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const totalCatMin = cats.reduce((acc, [, v]) => acc + v, 0);

  // Insights here are precomputed by the aggregator (see
  // brain/predictiveInsights.ts) every ~90 min and embedded inside the
  // rollup JSON. We render them straight from `data.predictive_insights`
  // — no DB or LLM call on render.
  const predictive = data.predictive_insights?.insights ?? [];
  const yesterdayWin = useYesterdayWinMemory(tile.key);
  // Don't double-show the same memory if it appears as yesterday's win.
  const dayMemories = yesterdayWin
    ? predictive.filter((m) => m.memory_id !== yesterdayWin.id)
    : predictive;
  const [showAllMemories, setShowAllMemories] = useState(false);
  const visibleMemories = showAllMemories ? dayMemories : dayMemories.slice(0, 2);
  const hiddenCount = Math.max(0, dayMemories.length - visibleMemories.length);

  return (
    <View style={{ gap: 16 }}>
      {/* hero */}
      <View>
        <Text style={[s.h2, { fontSize: 18 }]}>{tile.key}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 6 }}>
          <Text style={{ fontSize: 56, color: scoreTint(theme, score), fontWeight: '700' }}>
            {score == null ? '—' : score}
          </Text>
          {scoreDelta != null && (
            <DeltaPill value={scoreDelta} unit="%" theme={theme} />
          )}
        </View>
        {score != null && (
          <View style={{ marginTop: 8 }}>
            <ScoreBar score={score} height={8} />
          </View>
        )}
        <Text style={[s.tdMonoSm, { color: theme.textFaint, marginTop: 6 }]}>
          updated {fmtTimeShort(tile.updated_ts)}
          {prev?.score != null && ` · vs prev day ${Math.round((prev.score ?? 0) * 100)}`}
        </Text>
      </View>

      {/* wake / first pickup / sleep — most actionable signals */}
      <View>
        <SectionHeader>Morning</SectionHeader>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
          <Stat
            title="Woke up"
            value={data.sleep?.end ? shortClock(data.sleep.end) : '—'}
            sub={data.sleep?.start ? `slept ${shortClock(data.sleep.start)}` : 'no signal'}
          />
          <Stat
            title="Sleep"
            value={fmtMinutesAsHours(sleepMin)}
            sub={sleepDelta != null ? deltaLabel(sleepDelta, 'm') : ''}
            subTone={deltaTone(theme, sleepDelta, 'higher_is_better')}
          />
          <Stat
            title="First pickup"
            value={
              data.first_pickup_min_after_wake != null
                ? `+${data.first_pickup_min_after_wake}m`
                : '—'
            }
            sub={data.wake_first_app ? prettyPkg(data.wake_first_app) : 'after wake'}
          />
        </View>
      </View>

      {/* screen + steps + nudges */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat
          title="Screen on"
          value={fmtMinutesAsHours(screenMin)}
          sub={screenDelta != null ? deltaLabel(screenDelta, 'm') : data.late_night_screen_min ? `${data.late_night_screen_min}m late-night` : ''}
          subTone={deltaTone(theme, screenDelta, 'lower_is_better')}
        />
        <Stat
          title="Steps"
          value={(data.steps ?? 0).toLocaleString()}
          sub={data.active_minutes ? `${data.active_minutes}m active` : ''}
        />
        <Stat
          title="Nudges"
          value={`${data.nudges?.fired ?? 0}`}
          sub={
            data.nudges
              ? `${data.nudges.acted} acted · ${data.nudges.dismissed} dismissed`
              : ''
          }
        />
      </View>

      {/* top apps */}
      {apps.length > 0 && (
        <View>
          <SectionHeader>Top apps</SectionHeader>
          <View style={{ gap: 8, marginTop: 4 }}>
            {apps.map((a) => {
              const pretty = prettyPkg(a.pkg);
              const catColor = catTint(theme, a.category);
              return (
                <View
                  key={a.pkg}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <AppIcon label={pretty} pkg={a.pkg} fallback={theme.accent} size={28} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.body2, { fontWeight: '600' }]} numberOfLines={1}>
                      {pretty}
                    </Text>
                    <Text style={[s.tdMonoSm, { color: catColor }]}>{a.category}</Text>
                  </View>
                  <Text style={[s.tdMono, { fontWeight: '700' }]}>
                    {Math.round(a.minutes)}m
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* category split */}
      {cats.length > 0 && (
        <View>
          <SectionHeader>Time split</SectionHeader>
          <View
            style={{
              flexDirection: 'row',
              height: 10,
              borderRadius: 5,
              overflow: 'hidden',
              backgroundColor: theme.chipBg,
              marginTop: 4,
            }}>
            {cats.map(([cat, min]) => (
              <View
                key={cat}
                style={{
                  flex: min / Math.max(totalCatMin, 1),
                  backgroundColor: catTint(theme, cat),
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {cats.map(([cat, min]) => (
              <View
                key={cat}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <StatusDot color={catTint(theme, cat)} size={7} />
                <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                  {cat} · {Math.round(min)}m
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* insights — predictive RAG hits the aggregator computed for today
          (similar past patterns and what they led to), plus yesterday's
          biggest personalised win. Both come from the memory store; no
          generic fallback. */}
      {(visibleMemories.length > 0 || yesterdayWin) && (
        <View>
          <SectionHeader>Insights</SectionHeader>
          <View style={{ gap: 8, marginTop: 4 }}>
            {visibleMemories.map((memory) => (
              <InsightLine
                key={memory.memory_id}
                theme={theme}
                icon={memoryIcon(memory.type)}
                text={formatPredictiveInsight(memory)}
              />
            ))}
            {hiddenCount > 0 && (
              <Pressable onPress={() => setShowAllMemories(true)}>
                <Text
                  style={{
                    color: theme.accent,
                    fontSize: 12,
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                  }}>
                  Show {hiddenCount} more memor{hiddenCount === 1 ? 'y' : 'ies'}
                </Text>
              </Pressable>
            )}
            {showAllMemories && dayMemories.length > 2 && (
              <Pressable onPress={() => setShowAllMemories(false)}>
                <Text
                  style={{
                    color: theme.textMuted,
                    fontSize: 12,
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                  }}>
                  Show less
                </Text>
              </Pressable>
            )}
            {yesterdayWin && (
              <InsightLine
                theme={theme}
                icon="✓"
                text={`Yesterday's win: ${formatYesterdayWin(yesterdayWin)}`}
              />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ────────────────────────────────────────────────────────── monthly detail

function MonthlyDetail({ tile }: { tile: MonthlyTile }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const data = useMemo(() => safeParse<MonthlyData>(tile.data) ?? {}, [tile.data]);
  const avg = scoreToPct(data.avg_productivity_score ?? null);
  const cats = Object.entries(data.by_category_minutes ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const catTotal = cats.reduce((a, [, v]) => a + v, 0);
  const apps = (data.top_apps ?? []).filter((a) => a.total_minutes > 0).slice(0, 6);

  return (
    <View style={{ gap: 16 }}>
      <View>
        <Text style={[s.h2, { fontSize: 18 }]}>{tile.key}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 6 }}>
          <Text style={{ fontSize: 56, color: scoreTint(theme, avg), fontWeight: '700' }}>
            {avg ?? '—'}
          </Text>
          <Text style={[s.tdMonoSm, { color: theme.textFaint, paddingBottom: 12 }]}>
            avg score · {data.days_observed ?? 0} days observed
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat
          title="Avg sleep"
          value={fmtMinutesAsHours(data.sleep?.p50_min ?? null)}
          sub={data.sleep?.p90_min ? `p90 ${fmtMinutesAsHours(data.sleep.p90_min)}` : ''}
        />
        <Stat
          title="Steps"
          value={(data.total_steps ?? 0).toLocaleString()}
          sub={`${data.total_active_minutes ?? 0}m active`}
        />
        <Stat
          title="Nudges"
          value={`${data.totals?.nudges_fired ?? 0}`}
          sub={`${data.totals?.nudges_acted ?? 0} acted`}
        />
      </View>

      {apps.length > 0 && (
        <View>
          <SectionHeader>Top apps this month</SectionHeader>
          <View style={{ gap: 8, marginTop: 4 }}>
            {apps.map((a) => {
              const pretty = prettyPkg(a.pkg);
              return (
                <View
                  key={a.pkg}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <AppIcon label={pretty} pkg={a.pkg} fallback={theme.accent} size={28} />
                  <Text style={[s.body2, { flex: 1 }]} numberOfLines={1}>
                    {pretty}
                  </Text>
                  <Text style={[s.tdMono, { fontWeight: '700' }]}>
                    {Math.round(a.total_minutes)}m
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {cats.length > 0 && (
        <View>
          <SectionHeader>Category split</SectionHeader>
          <View
            style={{
              flexDirection: 'row',
              height: 10,
              borderRadius: 5,
              overflow: 'hidden',
              backgroundColor: theme.chipBg,
              marginTop: 4,
            }}>
            {cats.map(([cat, min]) => (
              <View
                key={cat}
                style={{
                  flex: min / Math.max(catTotal, 1),
                  backgroundColor: catTint(theme, cat),
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {cats.map(([cat, min]) => (
              <View
                key={cat}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <StatusDot color={catTint(theme, cat)} size={7} />
                <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                  {cat} · {Math.round(min)}m
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────── small atoms

function Stat({
  title,
  value,
  sub,
  subTone,
}: {
  title: string;
  value: string;
  sub?: string;
  subTone?: string;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.chipBg,
        borderRadius: 10,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.cardBorder,
      }}>
      <Text style={[s.tdMonoSm, { color: theme.textFaint, textTransform: 'uppercase' }]}>
        {title}
      </Text>
      <Text style={[s.h2, { fontSize: 18, marginTop: 2 }]} numberOfLines={1}>
        {value}
      </Text>
      {sub ? (
        <Text
          style={[s.tdMonoSm, { color: subTone ?? theme.textMuted, marginTop: 1 }]}
          numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function DeltaPill({ value, unit, theme }: { value: number; unit: string; theme: ThemeTokens }) {
  const positive = value >= 0;
  const color = positive ? theme.ok : theme.err;
  const arrow = positive ? '▲' : '▼';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        backgroundColor: color + '22',
        marginBottom: 12,
      }}>
      <Text style={{ color, fontWeight: '700', fontSize: 12 }}>{arrow}</Text>
      <Text style={{ color, fontWeight: '700', fontSize: 13 }}>
        {Math.abs(value).toFixed(0)}{unit}
      </Text>
    </View>
  );
}

function InsightLine({
  theme,
  icon,
  text,
}: {
  theme: ThemeTokens;
  icon: string;
  text: string;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: theme.chipBg,
        borderWidth: 1,
        borderColor: theme.cardBorder,
      }}>
      <Text style={{ color: theme.accent, fontSize: 14, marginTop: 1 }}>{icon}</Text>
      <Text style={{ color: theme.text, fontSize: 13, lineHeight: 18, flex: 1 }}>{text}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────── helpers

function scoreToPct(s: number | null | undefined): number | null {
  if (s == null || !isFinite(s)) return null;
  return Math.round(s * 100);
}

function scoreTint(theme: ThemeTokens, score: number | null): string {
  if (score == null) return theme.textMuted;
  if (score >= 75) return theme.ok;
  if (score >= 50) return theme.accent;
  if (score >= 25) return theme.warn;
  return theme.err;
}

function fmtMinutesAsHours(min: number | null | undefined): string {
  if (min == null || !isFinite(min) || min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function shortClock(s: string): string {
  if (!s) return '—';
  // Accept "HH:MM" or full ISO; return "HH:MM".
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : s;
}

function deltaLabel(delta: number, unit: string): string {
  if (Math.abs(delta) < 0.5) return `flat vs prev`;
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(delta))}${unit} vs prev`;
}

type DeltaDirection = 'higher_is_better' | 'lower_is_better';
function deltaTone(theme: ThemeTokens, delta: number | null, dir: DeltaDirection): string {
  if (delta == null || Math.abs(delta) < 0.5) return theme.textMuted;
  const good = dir === 'higher_is_better' ? delta > 0 : delta < 0;
  return good ? theme.ok : theme.err;
}

function catTint(theme: ThemeTokens, cat: string): string {
  if (cat === 'productive') return theme.ok;
  if (cat === 'unproductive') return theme.err;
  if (cat === 'neutral') return theme.accent;
  return theme.textMuted;
}

function memoryIcon(type: string): string {
  if (type === 'causal') return '→';
  if (type === 'habit') return '○';
  if (type === 'prediction') return '◈';
  if (type === 'preference') return '♡';
  if (type === 'identity') return '★';
  return '•';
}

/**
 * Yesterday's biggest personalised win: the single highest positive-impact
 * memory the memory pass extracted from the previous day. Returns null when
 * the prior day has no positive-impact memory yet (e.g. nightly pass hasn't
 * run, or the day was unremarkable). Never falls back to a generic heuristic.
 */
function useYesterdayWinMemory(date: string): RollupMemoryRow | null {
  const [memory, setMemory] = useState<RollupMemoryRow | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const prevDate = isoPrevDate(date);
      if (!prevDate) {
        setMemory(null);
        return;
      }
      const row = await withDb((db) =>
        db.getFirstAsync<RollupMemoryRow>(
          `SELECT id, type, summary, cause, effect, impact_score, confidence,
                  occurrences, was_correct, predicted_outcome, actual_outcome
           FROM memories
           WHERE archived_ts IS NULL
             AND rollup_date = ?
             AND impact_score > 0
           ORDER BY impact_score * confidence DESC
           LIMIT 1`,
          [prevDate],
        ),
      );
      if (!alive) return;
      setMemory(row ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [date]);
  return memory;
}

function isoPrevDate(date: string): string | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface RollupMemoryRow {
  id: string;
  type: string;
  summary: string;
  cause: string | null;
  effect: string | null;
  impact_score: number;
  confidence: number;
  occurrences: number;
  was_correct: 0 | 1 | null;
  predicted_outcome: string | null;
  actual_outcome: string | null;
}

function formatPredictiveInsight(memory: PredictiveInsightsBlock['insights'][number]): string {
  const impactPercent = Math.round(memory.impact_score * 100);
  const sign = memory.impact_score >= 0 ? '+' : '';
  const confidencePercent = Math.round(memory.confidence * 100);
  const matchPercent = Math.round(memory.similarity * 100);
  const chain =
    memory.cause && memory.effect ? ` (${memory.cause} → ${memory.effect})` : '';
  return `${memory.summary}${chain} · match ${matchPercent}% · impact ${sign}${impactPercent}% · conf ${confidencePercent}%`;
}

function formatYesterdayWin(memory: RollupMemoryRow): string {
  const impactPercent = Math.round(memory.impact_score * 100);
  const sign = memory.impact_score >= 0 ? '+' : '';
  const confidencePercent = Math.round(memory.confidence * 100);
  const chain =
    memory.cause && memory.effect ? ` (${memory.cause} → ${memory.effect})` : '';
  const verdict =
    memory.was_correct === null
      ? ''
      : memory.was_correct === 1
        ? ' — confirmed'
        : ' — contradicted';
  return `${memory.summary}${chain} · impact ${sign}${impactPercent}% · conf ${confidencePercent}%${verdict}`;
}

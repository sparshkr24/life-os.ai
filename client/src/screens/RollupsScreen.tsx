/**
 * Rollups dashboard.
 *
 * The list shows compact daily/monthly tiles (date + score + top app); tap
 * one to expand into a full dashboard rendering of the rollup JSON. We
 * never show raw JSON — every field is parsed and surfaced as a readable
 * card so the user can actually understand their day at a glance.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { ActionButton, fmtTimeShort, makeStyles, prettyPkg, useAsyncRunner } from './shared';
import { AppIcon, ScoreBar, SectionHeader, StatusDot } from './widgets';

type RollupMode = 'daily' | 'monthly';
const ROLLUP_MODES: { id: RollupMode; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'monthly', label: 'Monthly' },
];

interface DailyTile {
  kind: 'daily';
  key: string;
  data: string;
  updated_ts: number;
  productivity_score: number | null;
}
interface MonthlyTile {
  kind: 'monthly';
  key: string;
  data: string;
  updated_ts: number;
}
type Tile = DailyTile | MonthlyTile;

// ── Shape of the persisted JSON (mirrors aggregator/rollup.ts +
//    monthlyFold.ts; kept loose so a partial old rollup still renders).
interface DailyData {
  date?: string;
  sleep?: {
    start?: string | null;
    end?: string | null;
    duration_min?: number;
    confidence?: number;
  };
  wake_first_app?: string | null;
  first_pickup_min_after_wake?: number | null;
  screen_on_minutes?: number;
  by_app?: { pkg: string; total_ms: number; category: string }[];
  by_category?: Record<string, number>;
  late_night_screen_min?: number;
  places?: { id: string; minutes: number }[];
  steps?: number;
  active_minutes?: number;
  todos?: { created: number; completed: number };
  nudges?: { fired: number; acted: number; dismissed: number };
  silences?: { duration_min: number; label: string; confidence: number }[];
}
interface MonthlyData {
  month?: string;
  days_observed?: number;
  avg_productivity_score?: number | null;
  top_apps?: { pkg: string; total_min: number }[];
  by_category_minutes?: Record<string, number>;
  sleep?: { p50_min?: number | null; p90_min?: number | null };
  places?: { id: string; minutes: number }[];
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
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const refresh = async () => {
    const myReq = ++reqIdRef.current;
    const out = await run(
      'rollups',
      async () => {
        const filter = { text, fromDate: from || undefined, toDate: to || undefined, sort: 'desc' as const };
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
              onPress={() => {
                setMode(m.id);
                setOpenKey(null);
              }}
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
      {text.length > 0 && (
        <Text style={[s.muted, { marginHorizontal: 14 }]}>
          (text filter is applied via the search box; date range filters override)
        </Text>
      )}
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
        {tiles.map((t) =>
          t.kind === 'daily' ? (
            <DailyCard
              key={t.key}
              tile={t}
              expanded={openKey === t.key}
              onToggle={() => setOpenKey(openKey === t.key ? null : t.key)}
            />
          ) : (
            <MonthlyCard
              key={t.key}
              tile={t}
              expanded={openKey === t.key}
              onToggle={() => setOpenKey(openKey === t.key ? null : t.key)}
            />
          ),
        )}
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────── DAILY tile

function DailyCard({
  tile,
  expanded,
  onToggle,
}: {
  tile: DailyTile;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const data = useMemo(() => safeParse<DailyData>(tile.data) ?? {}, [tile.data]);
  const score = tile.productivity_score == null ? null : Math.round(tile.productivity_score * 100);
  const scoreColor =
    score == null ? theme.textMuted : score >= 75 ? theme.ok : score >= 50 ? theme.accent : score >= 25 ? theme.warn : theme.err;
  const topApp = data.by_app?.[0];
  return (
    <Pressable onPress={onToggle} style={{ marginHorizontal: 14, marginVertical: 4 }}>
      <View style={s.card}>
        {/* header row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.body2, { fontWeight: '700' }]}>{tile.key}</Text>
            <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>
              updated {fmtTimeShort(tile.updated_ts)}
            </Text>
          </View>
          {topApp && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <AppIcon
                label={prettyPkg(topApp.pkg)}
                pkg={topApp.pkg}
                fallback={theme.accent}
                size={26}
              />
              <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                {Math.round(topApp.total_ms / 60_000)}m
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
        {expanded && <DailyDashboard data={data} />}
      </View>
    </Pressable>
  );
}

function DailyDashboard({ data }: { data: DailyData }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const apps = (data.by_app ?? []).slice(0, 6);
  const totalCatMin = Object.values(data.by_category ?? {}).reduce((a, b) => a + b, 0);
  const cats = Object.entries(data.by_category ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const silences = (data.silences ?? []).slice(0, 4);

  return (
    <View
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTopWidth: 1,
        borderColor: theme.cardBorder,
        gap: 14,
      }}>
      {/* sleep + screen + steps */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat
          title="Sleep"
          value={fmtMinutesAsHours(data.sleep?.duration_min)}
          sub={
            data.sleep?.start && data.sleep.end
              ? `${shortClock(data.sleep.start)} → ${shortClock(data.sleep.end)}`
              : 'no signal'
          }
        />
        <Stat
          title="Screen on"
          value={fmtMinutesAsHours(data.screen_on_minutes)}
          sub={
            data.late_night_screen_min
              ? `${data.late_night_screen_min}m late-night`
              : ''
          }
        />
        <Stat
          title="Steps"
          value={(data.steps ?? 0).toLocaleString()}
          sub={data.active_minutes ? `${data.active_minutes}m active` : ''}
        />
      </View>

      {/* top apps */}
      {apps.length > 0 && (
        <View>
          <SectionHeader>Top apps</SectionHeader>
          <View style={{ gap: 8, marginTop: 4 }}>
            {apps.map((a) => {
              const minutes = Math.round(a.total_ms / 60_000);
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
                  <AppIcon label={pretty} pkg={a.pkg} fallback={theme.accent} size={28} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.body2, { fontWeight: '600' }]} numberOfLines={1}>
                      {pretty}
                    </Text>
                    <Text style={[s.tdMonoSm, { color: catColor }]}>{a.category}</Text>
                  </View>
                  <Text style={[s.tdMono, { fontWeight: '700' }]}>{minutes}m</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* category split as a stacked bar */}
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
                  {cat} · {min}m
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* nudges + todos quick stats */}
      {(data.nudges || data.todos) && (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {data.nudges && (
            <Stat
              title="Nudges"
              value={`${data.nudges.fired}`}
              sub={`${data.nudges.acted} acted · ${data.nudges.dismissed} dismissed`}
            />
          )}
          {data.todos && (
            <Stat
              title="Todos"
              value={`${data.todos.completed}/${data.todos.created}`}
              sub="completed"
            />
          )}
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
      )}

      {/* silences */}
      {silences.length > 0 && (
        <View>
          <SectionHeader>Silences (inferred)</SectionHeader>
          <View style={{ gap: 6, marginTop: 4 }}>
            {silences.map((sil, i) => (
              <View
                key={i}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}>
                <Text style={[s.body2, { color: theme.text }]}>{sil.label.replace(/_/g, ' ')}</Text>
                <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                  {Math.round(sil.duration_min)}m · {Math.round((sil.confidence ?? 0) * 100)}%
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────── MONTHLY tile

function MonthlyCard({
  tile,
  expanded,
  onToggle,
}: {
  tile: MonthlyTile;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const data = useMemo(() => safeParse<MonthlyData>(tile.data) ?? {}, [tile.data]);
  const avg =
    data.avg_productivity_score == null ? null : Math.round(data.avg_productivity_score * 100);
  const avgColor =
    avg == null ? theme.textMuted : avg >= 75 ? theme.ok : avg >= 50 ? theme.accent : theme.warn;
  const catEntries = Object.entries(data.by_category_minutes ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const catTotal = catEntries.reduce((a, [, v]) => a + v, 0);

  return (
    <Pressable onPress={onToggle} style={{ marginHorizontal: 14, marginVertical: 4 }}>
      <View style={s.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.body2, { fontWeight: '700' }]}>{tile.key}</Text>
            <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>
              {data.days_observed ?? 0} days observed · updated {fmtTimeShort(tile.updated_ts)}
            </Text>
          </View>
          <Text style={[s.h2, { fontSize: 28, color: avgColor }]}>{avg ?? '—'}</Text>
        </View>
        {expanded && (
          <View
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTopWidth: 1,
              borderColor: theme.cardBorder,
              gap: 14,
            }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Stat
                title="Avg sleep"
                value={fmtMinutesAsHours(data.sleep?.p50_min ?? null)}
                sub={
                  data.sleep?.p90_min ? `p90 ${fmtMinutesAsHours(data.sleep.p90_min)}` : ''
                }
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
            {(data.top_apps ?? []).length > 0 && (
              <View>
                <SectionHeader>Top apps</SectionHeader>
                <View style={{ gap: 8, marginTop: 4 }}>
                  {(data.top_apps ?? []).slice(0, 5).map((a) => {
                    const pretty = prettyPkg(a.pkg);
                    return (
                      <View
                        key={a.pkg}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <AppIcon
                          label={pretty}
                          pkg={a.pkg}
                          fallback={theme.accent}
                          size={28}
                        />
                        <Text style={[s.body2, { flex: 1 }]} numberOfLines={1}>
                          {pretty}
                        </Text>
                        <Text style={[s.tdMono, { fontWeight: '700' }]}>
                          {Math.round(a.total_min)}m
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}
            {catEntries.length > 0 && (
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
                  {catEntries.map(([cat, min]) => (
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
                  {catEntries.map(([cat, min]) => (
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
        )}
      </View>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────── helpers

function Stat({ title, value, sub }: { title: string; value: string; sub?: string }) {
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
        <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 1 }]} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function fmtMinutesAsHours(min: number | null | undefined): string {
  if (min == null || !isFinite(min) || min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function shortClock(s: string): string {
  // Accepts "HH:MM" or full ISO; returns "HH:MM".
  if (!s) return '—';
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : s;
}

function catTint(theme: ReturnType<typeof useTheme>['theme'], cat: string): string {
  if (cat === 'productive') return theme.ok;
  if (cat === 'unproductive') return theme.err;
  if (cat === 'neutral') return theme.accent;
  return theme.textMuted;
}

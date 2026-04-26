/**
 * All screens. Tabs: Today, Observability, Chat, Settings.
 *
 * Reliability rules used everywhere here:
 *  - Every async repo call is wrapped in try/catch and surfaces errors via
 *    `useToast()` so the user always sees feedback.
 *  - Every refresh button has a `loading` state with an inline spinner and
 *    is disabled while in flight, so taps are never silent.
 *  - When a list is "loading" we still keep the previous rows visible if we
 *    have any, to avoid the "stuck on spinner" feeling when re-entering a tab.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  listEvents,
  eventCounts,
  listDailyRollups,
  listMonthlyRollups,
  listLlmCalls,
  todayLlmSpendUsd,
  listNudges,
  getProfile,
  type LlmPurposeFilter,
} from '../repos/observability';
import {
  loadSnapshot,
  setAnthropicKey,
  setOpenAiKey,
  setDailyCap,
  type SecureSnapshot,
} from '../secure/keys';
import type {
  EventKind,
  EventRow,
  DailyRollupRow,
  MonthlyRollupRow,
  LlmCallRow,
  NudgeRow,
  BehaviorProfileRow,
} from '../db/schema';
import { useTheme, THEME_NAMES, type ThemeTokens } from '../theme';
import { useToast } from '../toast';

export type TabId = 'today' | 'observe' | 'chat' | 'settings';

const fmtTime = (ts: number): string => new Date(ts).toLocaleString();
const fmtTimeShort = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + '…');

// Small wrapper used everywhere: runs an async fn, shows a toast on failure,
// flips a boolean loading flag for UI feedback.
function useAsyncRunner() {
  const toast = useToast();
  return async <T,>(label: string, fn: () => Promise<T>, setLoading?: (b: boolean) => void): Promise<T | null> => {
    setLoading?.(true);
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[' + label + ']', msg);
      toast.error(label + ' failed: ' + truncate(msg, 80));
      return null;
    } finally {
      setLoading?.(false);
    }
  };
}

// Spinner button used by every refresh action.
function ActionButton({
  onPress,
  loading,
  label,
  variant = 'primary',
  style,
}: {
  onPress: () => void;
  loading: boolean;
  label: string;
  variant?: 'primary' | 'secondary' | 'inline';
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const baseStyle = variant === 'secondary' ? s.btnSecondary : variant === 'inline' ? s.btnInline : s.btn;
  return (
    <Pressable
      onPress={loading ? undefined : onPress}
      disabled={loading}
      style={[baseStyle, loading && { opacity: 0.7 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {loading && <ActivityIndicator color={theme.accentText} size="small" />}
        <Text style={s.btnText}>{loading ? 'working…' : label}</Text>
      </View>
    </Pressable>
  );
}

// ─── Today ──────────────────────────────────────────────────────────────────

export function TodayScreen({ onTab }: { onTab: (t: TabId) => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [counts, setCounts] = useState<{ total: number; lastHour: number } | null>(null);
  const [spend, setSpend] = useState(0);
  const [profile, setProfile] = useState<BehaviorProfileRow | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    await run(
      'today refresh',
      async () => {
        const [c, sp, p] = await Promise.all([eventCounts(), todayLlmSpendUsd(), getProfile()]);
        setCounts(c);
        setSpend(sp);
        setProfile(p);
      },
      setLoading,
    );
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

// ─── Observability ──────────────────────────────────────────────────────────

type ObsSection = 'events' | 'daily' | 'monthly' | 'llm' | 'nudges';
const OBS_SECTIONS: { id: ObsSection; label: string }[] = [
  { id: 'events', label: 'Raw events' },
  { id: 'daily', label: 'Daily rollups' },
  { id: 'monthly', label: 'Monthly rollups' },
  { id: 'llm', label: 'LLM calls' },
  { id: 'nudges', label: 'Nudges' },
];

export function ObservabilityScreen() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [section, setSection] = useState<ObsSection>('events');

  return (
    <View style={s.bodyTight}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow} style={s.chipScroll}>
        {OBS_SECTIONS.map((o) => (
          <Pressable
            key={o.id}
            onPress={() => setSection(o.id)}
            style={[s.chip, section === o.id && s.chipActive]}>
            <Text style={[s.chipText, section === o.id && s.chipTextActive]}>{o.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={{ flex: 1 }}>
        {section === 'events' && <EventsTable />}
        {section === 'daily' && <RollupsGeneric mode="daily" />}
        {section === 'monthly' && <RollupsGeneric mode="monthly" />}
        {section === 'llm' && <LlmTable />}
        {section === 'nudges' && <NudgesTable />}
      </View>
    </View>
  );
}

const EVENT_KINDS: ('all' | EventKind)[] = ['all', 'app_fg', 'app_bg', 'screen_on', 'screen_off', 'sleep', 'wake', 'geo_enter', 'geo_exit', 'activity', 'steps', 'notif'];

function EventsTable() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [kind, setKind] = useState<'all' | EventKind>('all');
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  // Guard against stale responses overwriting newer ones (e.g. user flips
  // filter chip while a previous query is still in flight).
  const reqIdRef = useRef(0);

  const refresh = async () => {
    const myReq = ++reqIdRef.current;
    const result = await run(
      'events',
      () => listEvents({ kind, limit: 200 }),
      setLoading,
    );
    if (myReq !== reqIdRef.current) return; // a newer request already won
    setHasFetched(true);
    if (result) setRows(result);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return (
    <View style={s.flexFill}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
        {EVENT_KINDS.map((k) => (
          <Pressable key={k} onPress={() => setKind(k)} style={[s.chipSm, kind === k && s.chipActive]}>
            <Text style={[s.chipText, kind === k && s.chipTextActive]}>{k}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={s.tableHeader}>
        <Text style={[s.thCell, { flex: 1.4 }]}>Time</Text>
        <Text style={[s.thCell, { flex: 1 }]}>Kind</Text>
        <Text style={[s.thCell, { flex: 2.4 }]}>Payload</Text>
      </View>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120 }}>
        {loading && rows.length === 0 && (
          <View style={s.inlineLoad}>
            <ActivityIndicator color={theme.accent} />
            <Text style={s.muted}>loading events…</Text>
          </View>
        )}
        {!loading && hasFetched && rows.length === 0 && <Text style={s.muted}>no events for this filter</Text>}
        {rows.map((r) => {
          const isOpen = expanded === r.id;
          return (
            <Pressable key={r.id} onPress={() => setExpanded(isOpen ? null : r.id)} style={s.tr}>
              <View style={{ flexDirection: 'row' }}>
                <Text style={[s.tdMono, { flex: 1.4 }]}>{fmtTimeShort(r.ts)}</Text>
                <Text style={[s.td, { flex: 1 }]}>{r.kind}</Text>
                <Text style={[s.tdMono, { flex: 2.4 }]} numberOfLines={isOpen ? undefined : 1}>
                  {r.payload}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      <ActionButton
        onPress={refresh}
        loading={loading}
        label={`Refresh (${rows.length})`}
        variant="secondary"
      />
    </View>
  );
}

function RollupsGeneric({ mode }: { mode: 'daily' | 'monthly' }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<'asc' | 'desc'>('desc');
  const [daily, setDaily] = useState<DailyRollupRow[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRollupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const refresh = async () => {
    const myReq = ++reqIdRef.current;
    if (mode === 'daily') {
      const r = await run(
        'daily rollups',
        () => listDailyRollups({ text, fromDate: from || undefined, toDate: to || undefined, sort }),
        setLoading,
      );
      if (myReq !== reqIdRef.current) return;
      setHasFetched(true);
      if (r) setDaily(r);
    } else {
      const r = await run(
        'monthly rollups',
        () => listMonthlyRollups({ text, fromDate: from || undefined, toDate: to || undefined, sort }),
        setLoading,
      );
      if (myReq !== reqIdRef.current) return;
      setHasFetched(true);
      if (r) setMonthly(r);
    }
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sort]);

  const keyLabel = mode === 'daily' ? 'Date' : 'Month';
  const rowsLen = mode === 'daily' ? daily.length : monthly.length;

  return (
    <View style={s.flexFill}>
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
        <TextInput placeholder="from YYYY-MM-DD" placeholderTextColor={theme.inputPlaceholder} value={from} onChangeText={setFrom} style={[s.input, { flex: 1 }]} />
        <TextInput placeholder="to YYYY-MM-DD" placeholderTextColor={theme.inputPlaceholder} value={to} onChangeText={setTo} style={[s.input, { flex: 1 }]} />
        <ActionButton onPress={refresh} loading={loading} label="Apply" variant="inline" />
      </View>
      <View style={s.tableHeader}>
        <Text style={[s.thCell, { flex: 1.2 }]}>{keyLabel}</Text>
        <Text style={[s.thCell, { flex: 1.4 }]}>Updated</Text>
        <Text style={[s.thCell, { flex: 2 }]}>Preview</Text>
      </View>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120 }}>
        {loading && rowsLen === 0 && (
          <View style={s.inlineLoad}>
            <ActivityIndicator color={theme.accent} />
            <Text style={s.muted}>loading…</Text>
          </View>
        )}
        {!loading && hasFetched && rowsLen === 0 && (
          <Text style={s.muted}>none yet · populated by aggregator (Stage 5)</Text>
        )}
        {mode === 'daily' &&
          daily.map((r) => {
            const isOpen = expanded === r.date;
            return (
              <Pressable key={r.date} onPress={() => setExpanded(isOpen ? null : r.date)} style={s.tr}>
                <View style={{ flexDirection: 'row' }}>
                  <Text style={[s.td, { flex: 1.2 }]}>{r.date}</Text>
                  <Text style={[s.tdMono, { flex: 1.4 }]}>{fmtTimeShort(r.updated_ts)}</Text>
                  <Text style={[s.tdMono, { flex: 2 }]} numberOfLines={isOpen ? undefined : 1}>
                    {isOpen ? r.data : truncate(r.data, 80)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        {mode === 'monthly' &&
          monthly.map((r) => {
            const isOpen = expanded === r.month;
            return (
              <Pressable key={r.month} onPress={() => setExpanded(isOpen ? null : r.month)} style={s.tr}>
                <View style={{ flexDirection: 'row' }}>
                  <Text style={[s.td, { flex: 1.2 }]}>{r.month}</Text>
                  <Text style={[s.tdMono, { flex: 1.4 }]}>{fmtTimeShort(r.updated_ts)}</Text>
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

const PURPOSES: LlmPurposeFilter[] = ['all', 'nightly', 'tick', 'chat'];

function LlmTable() {
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
          <Pressable key={p} onPress={() => setPurpose(p)} style={[s.chipSm, purpose === p && s.chipActive]}>
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
                <Text style={[s.tdMono, { flex: 0.8, color: r.ok ? theme.text : theme.err }]}>{(r.cost_usd ?? 0).toFixed(4)}</Text>
              </View>
              {isOpen && (
                <View style={{ marginTop: 6, gap: 6 }}>
                  <Text style={s.subLabel}>tokens</Text>
                  <Text style={s.tdMono}>in: {r.in_tokens ?? '?'} · out: {r.out_tokens ?? '?'}</Text>
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

function NudgesTable() {
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
        {!loading && hasFetched && rows.length === 0 && <Text style={s.muted}>no nudges yet (Stages 6–7)</Text>}
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

// ─── Chat ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export function ChatScreen() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');

  const send = () => {
    const text = input.trim();
    if (!text) return;
    const now = Date.now();
    setMessages((m) => [
      ...m,
      { role: 'user', text, ts: now },
      {
        role: 'assistant',
        text: 'Chat is wired in Stage 9. Set the Anthropic key in Settings, and once Sonnet tool-calling lands, replies will render here.',
        ts: now + 1,
      },
    ]);
    setInput('');
  };

  return (
    <View style={[s.body, { paddingBottom: 0 }]}>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120 }}>
        {messages.length === 0 && <Text style={s.muted}>Shell only — Stage 9 wires Sonnet with tools.</Text>}
        {messages.map((m, i) => (
          <View
            key={i}
            style={[
              s.bubble,
              m.role === 'user' ? s.bubbleUser : s.bubbleAssistant,
              { alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start' },
            ]}>
            <Text style={m.role === 'user' ? s.bubbleTextUser : s.bubbleText}>{m.text}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={[s.toolbar, { paddingBottom: 110 }]}>
        <TextInput
          placeholder="Ask anything…"
          placeholderTextColor={theme.inputPlaceholder}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={send}
          style={[s.input, { flex: 1 }]}
        />
        <Pressable onPress={send} style={s.btnInline}>
          <Text style={s.btnText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Settings (includes Profile section) ────────────────────────────────────

export function SettingsScreen() {
  const { theme, setTheme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const toast = useToast();
  const [snap, setSnap] = useState<SecureSnapshot | null>(null);
  const [aIn, setAIn] = useState('');
  const [oIn, setOIn] = useState('');
  const [capIn, setCapIn] = useState('');
  const [profile, setProfile] = useState<BehaviorProfileRow | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    await run('settings load', async () => {
      const [sn, p] = await Promise.all([loadSnapshot(), getProfile()]);
      setSnap(sn);
      setProfile(p);
    });
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async () => {
    const ok = await run(
      'save settings',
      async () => {
        if (aIn) await setAnthropicKey(aIn);
        if (oIn) await setOpenAiKey(oIn);
        if (capIn) await setDailyCap(Number(capIn));
        return true;
      },
      setSaving,
    );
    if (ok) {
      setAIn('');
      setOIn('');
      setCapIn('');
      toast.ok('Saved');
      await refresh();
    }
  };

  const summary = useMemo(() => {
    if (!profile) return null;
    const p = safeJson(profile.data);
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : null;
  }, [profile]);

  return (
    <ScrollView contentContainerStyle={s.body}>
      <View style={s.card}>
        <Text style={s.label}>Theme</Text>
        <View style={s.toolbar}>
          {THEME_NAMES.map((n) => (
            <Pressable
              key={n}
              onPress={() => setTheme(n)}
              style={[s.chipSm, theme.name === n && s.chipActive]}>
              <Text style={[s.chipText, theme.name === n && s.chipTextActive]}>{n}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.label}>Anthropic API key (Sonnet)</Text>
        <Text style={s.body2}>{snap?.anthropicSet ? `set ${snap.anthropicTail}` : 'not set'}</Text>
        <TextInput
          placeholder="sk-ant-..."
          placeholderTextColor={theme.inputPlaceholder}
          value={aIn}
          onChangeText={setAIn}
          secureTextEntry
          autoCapitalize="none"
          style={s.input}
        />
      </View>

      <View style={s.card}>
        <Text style={s.label}>OpenAI API key (gpt-4o-mini)</Text>
        <Text style={s.body2}>{snap?.openaiSet ? `set ${snap.openaiTail}` : 'not set'}</Text>
        <TextInput
          placeholder="sk-..."
          placeholderTextColor={theme.inputPlaceholder}
          value={oIn}
          onChangeText={setOIn}
          secureTextEntry
          autoCapitalize="none"
          style={s.input}
        />
      </View>

      <View style={s.card}>
        <Text style={s.label}>Daily LLM cost cap (USD)</Text>
        <Text style={s.body2}>current: ${snap?.dailyCapUsd.toFixed(2) ?? '0.30'}</Text>
        <TextInput
          placeholder="0.30"
          placeholderTextColor={theme.inputPlaceholder}
          value={capIn}
          onChangeText={setCapIn}
          keyboardType="decimal-pad"
          style={s.input}
        />
      </View>

      <ActionButton onPress={onSave} loading={saving} label="Save" />

      <View style={s.card}>
        <Text style={s.label}>Behavior profile</Text>
        {!profile && <Text style={s.muted}>not built yet · runs nightly (Stage 8)</Text>}
        {profile && summary && (
          <>
            <Text style={s.body2}>built {fmtTime(profile.built_ts)}</Text>
            <Text style={s.muted}>{profile.based_on_days} days · {profile.model} · confidence {String(summary.confidence ?? '?')}</Text>
            <ProfileSection title="schedule" data={summary.schedule} />
            <ProfileSection title="habits (good)" data={summary.habits_good} />
            <ProfileSection title="habits (bad)" data={summary.habits_bad} />
            <ProfileSection title="time wasters" data={summary.time_wasters} />
            <ProfileSection title="predictions" data={summary.predictions} />
            <ProfileSection title="deviations" data={summary.deviations} />
            <ProfileSection title="self-eval" data={summary.model_self_eval} />
            <Pressable onPress={() => setShowRaw((v) => !v)} style={s.btnGhost}>
              <Text style={s.btnGhostText}>{showRaw ? 'hide' : 'show'} full JSON</Text>
            </Pressable>
            {showRaw && <Text style={s.tdMono}>{JSON.stringify(summary, null, 2)}</Text>}
          </>
        )}
      </View>
    </ScrollView>
  );
}

function ProfileSection({ title, data }: { title: string; data: unknown }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  if (data == null) return null;
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={s.subLabel}>{title}</Text>
      <Text style={s.tdMono}>{JSON.stringify(data, null, 2)}</Text>
    </View>
  );
}

// ─── Theme-driven styles ────────────────────────────────────────────────────

// Bottom padding so floating nav (~80px tall + 18px gap) never covers content.
const NAV_CLEAR = 120;

export function makeStyles(t: ThemeTokens) {
  return StyleSheet.create({
    body: { flexGrow: 1, padding: 16, gap: 12, paddingBottom: NAV_CLEAR },
    bodyTight: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 0, gap: 10 },
    flexFill: { flex: 1 },
    h2: { color: t.text, fontSize: 28, fontWeight: '700' },
    label: { color: t.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
    subLabel: { color: t.textMuted, fontSize: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
    body2: { color: t.text, fontSize: 14 },
    muted: { color: t.textFaint, fontStyle: 'italic', marginVertical: 6, fontSize: 12 },
    inlineLoad: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16 },
    card: {
      backgroundColor: t.card,
      borderRadius: t.radius + 4,
      padding: 14,
      gap: 6,
      borderWidth: t.name === 'modern' ? 1 : 0,
      borderColor: t.cardBorder,
    },
    chipScroll: { flexGrow: 0, marginBottom: 4 },
    chipRow: { flexDirection: 'row', gap: 6, paddingVertical: 4 },
    chip: { backgroundColor: t.chipBg, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
    chipSm: { backgroundColor: t.chipBg, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
    chipActive: { backgroundColor: t.accent },
    chipText: { color: t.chipText, fontSize: 12, fontWeight: '500' },
    chipTextActive: { color: t.accentText, fontWeight: '700' },
    input: {
      backgroundColor: t.inputBg,
      color: t.inputText,
      borderRadius: t.radius,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    btn: { backgroundColor: t.accent, paddingVertical: 12, borderRadius: t.radius, alignItems: 'center' },
    btnSecondary: { backgroundColor: t.accent, paddingVertical: 10, borderRadius: t.radius, alignItems: 'center', marginTop: 6, marginBottom: NAV_CLEAR - 16 },
    btnInline: { backgroundColor: t.accent, paddingHorizontal: 14, paddingVertical: 10, borderRadius: t.radius },
    btnText: { color: t.accentText, fontWeight: '700' },
    btnGhost: { alignSelf: 'flex-start', paddingVertical: 6 },
    btnGhostText: { color: t.accent, fontWeight: '600', fontSize: 13 },
    list: { flex: 1 },
    tableHeader: {
      flexDirection: 'row',
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderColor: t.rowBorder,
      marginTop: 6,
    },
    thCell: { color: t.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    tr: {
      paddingHorizontal: 10,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderColor: t.rowBorder,
      backgroundColor: t.rowBg,
    },
    td: { color: t.text, fontSize: 12 },
    tdMono: { color: t.text, fontSize: 11, fontFamily: t.monoFont },
    bubble: {
      maxWidth: '85%',
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: t.radius + 6,
      marginVertical: 4,
    },
    bubbleUser: { backgroundColor: t.accent },
    bubbleAssistant: { backgroundColor: t.card, borderWidth: 1, borderColor: t.cardBorder },
    bubbleText: { color: t.text, fontSize: 14 },
    bubbleTextUser: { color: t.accentText, fontSize: 14 },
  });
}

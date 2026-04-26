/**
 * Shared helpers, styles, and the ActionButton used by every screen.
 *
 * Reliability rules used across screens:
 *  - Every async repo call is wrapped in try/catch and surfaces errors via
 *    `useToast()` so the user always sees feedback.
 *  - Every refresh button has a `loading` state with an inline spinner and
 *    is disabled while in flight, so taps are never silent.
 *  - When a list is "loading" we still keep the previous rows visible if we
 *    have any, to avoid the "stuck on spinner" feeling when re-entering a tab.
 */
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { EventRow } from '../db/schema';
import { useTheme, type ThemeTokens } from '../theme';
import { useToast } from '../toast';

export type TabId = 'today' | 'observe' | 'chat' | 'settings';

export const fmtTime = (ts: number): string => new Date(ts).toLocaleString();
export const fmtTimeShort = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
export const fmtClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
export const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n) + '…';

/** Pretty short package name: com.instagram.android → Instagram. */
export function prettyPkg(pkg: string): string {
  const parts = pkg.split('.').filter((p) => p && p !== 'android' && p !== 'app');
  const last = parts[parts.length - 1] || pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** Formats a duration in ms as e.g. '12s', '4m 20s', '1h 03m'. */
export function fmtDur(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs.toString().padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm.toString().padStart(2, '0')}m`;
}

/**
 * Parsed event payload. The Kotlin foreground service writes
 * `{pkg, start_ts, end_ts, duration_ms, source}` for app_fg events.
 * Older rows (pre-dedup) only have `pkg`. We tolerate both.
 */
export interface ParsedEvent {
  pkg?: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  source?: string;
}
export function parseEvent(row: EventRow): ParsedEvent {
  const v = safeJson(row.payload);
  if (typeof v !== 'object' || v === null) {
    return { startTs: row.ts, endTs: row.ts, durationMs: 0 };
  }
  const o = v as Record<string, unknown>;
  const pkg = typeof o.pkg === 'string' ? o.pkg : undefined;
  const startTs = typeof o.start_ts === 'number' ? o.start_ts : row.ts;
  const endTs = typeof o.end_ts === 'number' ? o.end_ts : startTs;
  const durationMs =
    typeof o.duration_ms === 'number' ? o.duration_ms : Math.max(0, endTs - startTs);
  const source = typeof o.source === 'string' ? o.source : undefined;
  return { pkg, startTs, endTs, durationMs, source };
}

/**
 * Wrapper used everywhere: runs an async fn, shows a toast on failure,
 * flips a boolean loading flag for UI feedback.
 */
export function useAsyncRunner() {
  const toast = useToast();
  return async <T,>(
    label: string,
    fn: () => Promise<T>,
    setLoading?: (b: boolean) => void,
  ): Promise<T | null> => {
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

/** Spinner button used by every refresh action. */
export function ActionButton({
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
  const baseStyle =
    variant === 'secondary' ? s.btnSecondary : variant === 'inline' ? s.btnInline : s.btn;
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

// Bottom padding so floating nav (~80px tall + 18px gap) never covers content.
export const NAV_CLEAR = 120;

export function makeStyles(t: ThemeTokens) {
  return StyleSheet.create({
    body: { flexGrow: 1, padding: 16, gap: 12, paddingBottom: NAV_CLEAR },
    bodyTight: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 0, gap: 10 },
    flexFill: { flex: 1 },
    h2: {
      color: t.text,
      fontSize: 28,
      fontWeight: '700',
      fontFamily: t.monoFont,
      letterSpacing: 0.5,
    },
    label: {
      color: t.textMuted,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 1,
      fontFamily: t.monoFont,
    },
    subLabel: {
      color: t.textMuted,
      fontSize: 10,
      marginTop: 4,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontFamily: t.monoFont,
    },
    body2: { color: t.text, fontSize: 14, fontFamily: t.monoFont },
    muted: {
      color: t.textFaint,
      fontStyle: 'italic',
      marginVertical: 6,
      fontSize: 12,
      fontFamily: t.monoFont,
    },
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
    chip: {
      backgroundColor: t.chipBg,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
    },
    chipSm: {
      backgroundColor: t.chipBg,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
    },
    chipActive: { backgroundColor: t.accent },
    seg: {
      flexDirection: 'row',
      backgroundColor: t.segBg,
      borderRadius: 12,
      padding: 4,
      marginBottom: 10,
    },
    segItem: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 9 },
    segItemActive: { backgroundColor: t.segActiveBg },
    segText: {
      color: t.segText,
      fontSize: 12,
      fontFamily: t.monoFont,
      letterSpacing: 0.4,
    },
    segTextActive: { color: t.segActiveText, fontWeight: '700' },
    segInner: {
      flexDirection: 'row',
      backgroundColor: t.segBg,
      borderRadius: 10,
      padding: 3,
      marginBottom: 8,
      alignSelf: 'flex-start',
    },
    segInnerItem: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
    segInnerItemActive: { backgroundColor: t.accent2 },
    segInnerText: {
      color: t.segText,
      fontSize: 11,
      fontFamily: t.monoFont,
      letterSpacing: 0.4,
    },
    segInnerTextActive: { color: t.accentText, fontWeight: '700' },
    eventRow: {
      flexDirection: 'row',
      backgroundColor: t.rowBg,
      borderBottomWidth: 1,
      borderColor: t.rowBorder,
      minHeight: 64,
    },
    eventTint: { width: 4 },
    eventInner: {
      flex: 1,
      paddingHorizontal: 12,
      paddingVertical: 12,
      justifyContent: 'center',
    },
    eventApp: { color: t.text, fontSize: 14, fontWeight: '700', fontFamily: t.monoFont },
    kvKey: {
      color: t.textMuted,
      fontSize: 10,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    kindBadge: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'flex-start',
    },
    kindBadgeText: { fontSize: 10, fontWeight: '700', fontFamily: t.monoFont },
    chipText: {
      color: t.chipText,
      fontSize: 12,
      fontWeight: '500',
      fontFamily: t.monoFont,
    },
    chipTextActive: { color: t.accentText, fontWeight: '700', fontFamily: t.monoFont },
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
    btn: {
      backgroundColor: t.accent,
      paddingVertical: 12,
      borderRadius: t.radius,
      alignItems: 'center',
    },
    btnSecondary: {
      backgroundColor: t.accent,
      paddingVertical: 10,
      borderRadius: t.radius,
      alignItems: 'center',
      marginTop: 6,
      marginBottom: NAV_CLEAR - 16,
    },
    btnInline: {
      backgroundColor: t.accent,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: t.radius,
    },
    btnGhost: { alignSelf: 'flex-start', paddingVertical: 6 },
    list: { flex: 1 },
    tableHeader: {
      flexDirection: 'row',
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderColor: t.rowBorder,
      marginTop: 6,
    },
    thCell: {
      color: t.textMuted,
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontFamily: t.monoFont,
    },
    tr: {
      paddingHorizontal: 10,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderColor: t.rowBorder,
      backgroundColor: t.rowBg,
      minHeight: 52,
    },
    td: { color: t.text, fontSize: 13, fontFamily: t.monoFont },
    tdMono: { color: t.text, fontSize: 12, fontFamily: t.monoFont },
    tdMonoSm: { color: t.text, fontSize: 11, fontFamily: t.monoFont },
    btnText: {
      color: t.accentText,
      fontWeight: '700',
      fontFamily: t.monoFont,
      letterSpacing: 0.4,
    },
    btnGhostText: {
      color: t.accent,
      fontWeight: '600',
      fontSize: 13,
      fontFamily: t.monoFont,
    },
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

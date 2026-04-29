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

export type TabId = 'today' | 'observe' | 'chat' | 'profile' | 'settings' | 'aimodels';

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
 *
 * v3: every event payload also carries a `_ctx` block stamped by
 * `PhoneState.stamp` at insert time: `{place_id?, batt?, charging?, net?,
 * audio?}`. Surfaced here so any debug screen / tool can show it.
 */
export interface PhoneCtx {
  placeId?: string;
  batt?: number;
  charging?: boolean;
  net?: string;
  audio?: string;
}
export interface ParsedEvent {
  pkg?: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  source?: string;
  ctx?: PhoneCtx;
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
  let ctx: PhoneCtx | undefined;
  const rawCtx = o._ctx;
  if (typeof rawCtx === 'object' && rawCtx !== null) {
    const c = rawCtx as Record<string, unknown>;
    ctx = {
      placeId: typeof c.place_id === 'string' ? c.place_id : undefined,
      batt: typeof c.batt === 'number' ? c.batt : undefined,
      charging: typeof c.charging === 'boolean' ? c.charging : undefined,
      net: typeof c.net === 'string' ? c.net : undefined,
      audio: typeof c.audio === 'string' ? c.audio : undefined,
    };
  }
  return { pkg, startTs, endTs, durationMs, source, ctx };
}

/**
 * Wrapper used everywhere: runs an async fn, shows a toast on failure,
 * flips a boolean loading flag for UI feedback.
 *
 * `opts.expectedSeconds`: when set, immediately fires an info toast
 * "<label>… (~Xs)" so the user knows the tap registered even when the
 * action takes a while (e.g. restart service: 30–90 s before the FG
 * notification re-appears).
 */
export interface AsyncRunOpts {
  expectedSeconds?: number;
  setLoading?: (b: boolean) => void;
}
export function useAsyncRunner() {
  const toast = useToast();
  return async <T,>(
    label: string,
    fn: () => Promise<T>,
    opts?: AsyncRunOpts | ((b: boolean) => void),
  ): Promise<T | null> => {
    // Back-compat: old call-sites pass a `setLoading` function as the 3rd arg.
    const norm: AsyncRunOpts = typeof opts === 'function' ? { setLoading: opts } : opts ?? {};
    norm.setLoading?.(true);
    if (norm.expectedSeconds !== undefined) {
      toast.info(`${label}… ~${norm.expectedSeconds}s`);
    }
    try {
      return await fn();
    } catch (e) {
      const parsed = parseError(e);
      console.error('[' + label + ']', parsed.full);
      toast.error(label + ' failed: ' + truncate(parsed.summary, 200));
      return null;
    } finally {
      norm.setLoading?.(false);
    }
  };
}

/**
 * Strip the noise out of native error chains so the user sees a useful
 * one-liner in toasts and the full picture in logcat.
 *
 * Handles common shapes:
 *  - expo-sqlite native rejections: "Call to function 'NativeStatement.X'
 *    has been rejected. Caused by: <real msg>"
 *  - SQLite errors: "Error code N: SQLITE_X: <text>"
 *  - Bridge promise rejections: "<code>: <message>"
 *  - Plain Error / non-Error rejections.
 */
export interface ParsedError {
  /** One-line, human-readable. Safe to show in a toast. */
  summary: string;
  /** Multi-line detail with codes, native cause chain, etc. For logs/dialogs. */
  full: string;
  /** Best-guess error category. */
  kind: 'db_corrupt' | 'db_io' | 'db_busy' | 'db_other' | 'native' | 'network' | 'unknown';
}
export function parseError(e: unknown): ParsedError {
  const raw = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error && e.stack ? e.stack : '';
  const lower = raw.toLowerCase();

  // SQLite signatures.
  if (
    lower.includes('database disk image is malformed') ||
    lower.includes('sqlite_corrupt') ||
    lower.includes('not a database')
  ) {
    return {
      summary: 'database file is corrupt — tap System → Repair',
      full: raw + (stack ? '\n' + stack : ''),
      kind: 'db_corrupt',
    };
  }
  if (lower.includes('database is locked') || lower.includes('sqlite_busy')) {
    return { summary: 'database busy — try again', full: raw, kind: 'db_busy' };
  }
  if (lower.includes('disk i/o error') || lower.includes('sqlite_ioerr')) {
    return { summary: 'disk I/O error — retry', full: raw, kind: 'db_io' };
  }

  // Native bridge: "Call to function 'X' has been rejected.\nCaused by: <Y>"
  // The interesting part is after "Caused by:".
  const causedBy = raw.match(/Caused by:\s*(.+?)(?:\n|$)/);
  if (causedBy) {
    const inner = causedBy[1].trim();
    return {
      summary: inner.length > 0 ? inner : raw,
      full: raw,
      kind: lower.includes('native') ? 'native' : 'unknown',
    };
  }

  // Generic SQLite error code line.
  const sqlite = raw.match(/Error code (\d+):\s*(.+?)(?:\n|$)/);
  if (sqlite) {
    return { summary: sqlite[2].trim(), full: raw, kind: 'db_other' };
  }

  // Network-ish.
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('timeout')) {
    return { summary: raw.split('\n')[0] || raw, full: raw, kind: 'network' };
  }

  // Default: first non-empty line.
  const firstLine = raw.split('\n').find((l) => l.trim().length > 0) || raw;
  return { summary: firstLine, full: raw, kind: 'unknown' };
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

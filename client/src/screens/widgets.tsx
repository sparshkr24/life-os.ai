/**
 * Tiny presentational primitives shared across the redesigned screens.
 * Kept dependency-free (no SVG / Reanimated) so we don't break hard rule #3.
 *
 *   AppIcon     — colored circular avatar with the app's first letter.
 *                 The icon itself is colored (per `kindColors`); the row
 *                 around it stays neutral. Used in the Events table so a
 *                 user can spot Instagram / Slack / etc. instantly.
 *   ScoreBar    — 100-step progress bar with delta vs. baseline. Replaces
 *                 the SVG ring on the Today screen so we keep deps clean.
 *   Sparkline   — tiny bar-chart of the last N values. Pure View bars.
 *   Section     — section header used on Settings + Profile.
 *   StatusDot   — colored dot for live/idle/stalled or nudge level.
 *   PressableScale — Pressable with built-in 92%-scale press animation
 *                    (the iOS-y tap feedback the user asked for).
 */
import { useRef } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useTheme, type ThemeTokens } from '../theme';
import type { EventKind } from '../db/schema';

// ───────────────────────────────────────────────────── AppIcon

/**
 * Real brand glyph + brand color for the apps the user is most likely to
 * see. Substring-matched against pkg + display label (case-insensitive).
 *
 * `icon` is the FontAwesome5 brand name (rendered with `<FontAwesome5
 * brand />`). When no entry matches we render the first letter on a
 * tinted square instead.
 */
type Brand = { color: string; icon?: string };
const APP_BRANDS: Record<string, Brand> = {
  snapchat: { color: '#FFFC00', icon: 'snapchat' },
  instagram: { color: '#E1306C', icon: 'instagram' },
  youtube: { color: '#FF0033', icon: 'youtube' },
  whatsapp: { color: '#25D366', icon: 'whatsapp' },
  slack: { color: '#4A154B', icon: 'slack' },
  twitter: { color: '#1DA1F2', icon: 'twitter' },
  // 'x' alone is too generic to safely substring-match — handled below.
  spotify: { color: '#1DB954', icon: 'spotify' },
  chrome: { color: '#4285F4', icon: 'chrome' },
  gmail: { color: '#EA4335', icon: 'google' },
  discord: { color: '#5865F2', icon: 'discord' },
  reddit: { color: '#FF4500', icon: 'reddit-alien' },
  telegram: { color: '#26A5E4', icon: 'telegram' },
  github: { color: '#9CA3AF', icon: 'github' },
  linkedin: { color: '#0A66C2', icon: 'linkedin-in' },
  facebook: { color: '#1877F2', icon: 'facebook' },
  twitch: { color: '#9146FF', icon: 'twitch' },
  pinterest: { color: '#E60023', icon: 'pinterest' },
  // Below entries have no FA5 brand glyph — letter fallback w/ brand color.
  netflix: { color: '#E50914' },
  zoom: { color: '#2D8CFF' },
  cursor: { color: '#7C9CFF' },
  vscode: { color: '#007ACC' },
  notion: { color: '#FFFFFF' },
  googlequicksearch: { color: '#4285F4', icon: 'google' },
  search: { color: '#4285F4', icon: 'google' },
};

function brandFor(pkgOrLabel: string): Brand | null {
  const k = pkgOrLabel.toLowerCase();
  for (const key of Object.keys(APP_BRANDS)) {
    if (k.includes(key)) return APP_BRANDS[key];
  }
  // 'twitter/x' rebrand — match standalone "x" only when pkg looks
  // like com.twitter.android or similar.
  if (/\b(com\.)?(twitter|x)\.android/.test(k)) return APP_BRANDS.twitter;
  return null;
}

export function appColorFor(pkgOrLabel: string, fallback: string): string {
  return brandFor(pkgOrLabel)?.color ?? fallback;
}

export function AppIcon({
  label,
  pkg,
  fallback,
  size = 36,
}: {
  /** Display name like "Instagram". Used for substring match + first-letter fallback. */
  label: string;
  /** Optional package name for matching. */
  pkg?: string;
  /** Color used when no app-specific match found (usually kind-tint). */
  fallback: string;
  size?: number;
}) {
  const brand = brandFor(pkg ?? label) ?? brandFor(label);
  const color = brand?.color ?? fallback;
  // Yellow brand on dark theme — fade the square so the glyph stays legible.
  const bg = color + '22';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: color + '55',
      }}>
      {brand?.icon ? (
        <FontAwesome5 name={brand.icon} size={size * 0.55} color={color} brand />
      ) : (
        <Text
          style={{
            color,
            fontSize: size * 0.42,
            fontWeight: '800',
            letterSpacing: -0.5,
          }}>
          {(label[0] ?? '?').toUpperCase()}
        </Text>
      )}
    </View>
  );
}

// ───────────────────────────────────────────────────── ScoreBar

export function ScoreBar({
  score,
  baseline,
  height = 10,
}: {
  /** 0–100. Shown as the filled portion. */
  score: number;
  /** 0–100. Optional. Drawn as a vertical tick on the bar. */
  baseline?: number;
  height?: number;
}) {
  const { theme } = useTheme();
  const pct = Math.max(0, Math.min(100, score));
  const fill =
    pct >= 75 ? theme.ok : pct >= 50 ? theme.accent : pct >= 25 ? theme.warn : theme.err;
  return (
    <View style={{ width: '100%' }}>
      <View
        style={{
          width: '100%',
          height,
          backgroundColor: theme.chipBg,
          borderRadius: height / 2,
          overflow: 'hidden',
        }}>
        <View
          style={{
            width: `${pct}%`,
            height: '100%',
            backgroundColor: fill,
            borderRadius: height / 2,
          }}
        />
        {typeof baseline === 'number' && (
          <View
            style={{
              position: 'absolute',
              top: -2,
              bottom: -2,
              left: `${Math.max(0, Math.min(100, baseline))}%`,
              width: 2,
              backgroundColor: theme.text,
              opacity: 0.5,
            }}
          />
        )}
      </View>
    </View>
  );
}

// ───────────────────────────────────────────────────── Sparkline

export function Sparkline({
  values,
  width = 80,
  height = 22,
  color,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const { theme } = useTheme();
  const c = color ?? theme.accent;
  const present = values.filter((v): v is number => typeof v === 'number');
  const max = present.length ? Math.max(...present, 1) : 1;
  const slot = values.length ? width / values.length : 0;
  return (
    <View style={{ width, height, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
      {values.map((v, i) => {
        const h = v == null ? 2 : Math.max(2, (v / max) * height);
        return (
          <View
            key={i}
            style={{
              width: Math.max(2, slot - 2),
              height: h,
              backgroundColor: v == null ? theme.chipBg : c,
              opacity: v == null ? 0.4 : 0.85,
              borderRadius: 2,
            }}
          />
        );
      })}
    </View>
  );
}

// ───────────────────────────────────────────────────── Section header

export function SectionHeader({ children }: { children: string }) {
  const { theme } = useTheme();
  return (
    <Text
      style={{
        color: theme.textFaint,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        fontFamily: theme.monoFont,
        marginTop: 18,
        marginBottom: 6,
        paddingHorizontal: 4,
      }}>
      {children}
    </Text>
  );
}

// ───────────────────────────────────────────────────── StatusDot

export function StatusDot({
  color,
  size = 8,
  glow = false,
}: {
  color: string;
  size?: number;
  glow?: boolean;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        ...(glow && {
          shadowColor: color,
          shadowOpacity: 0.8,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 0 },
          elevation: 4,
        }),
      }}
    />
  );
}

// ───────────────────────────────────────────────────── PressableScale

/**
 * Pressable with the iOS-style "tap drops to 96%" animation. Uses the
 * built-in Animated API so we don't need react-native-reanimated.
 */
export function PressableScale({
  onPress,
  style,
  children,
  disabled,
  hitSlop,
}: {
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  disabled?: boolean;
  hitSlop?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onPressIn={() =>
        Animated.spring(scale, { toValue: 0.96, useNativeDriver: true, friction: 8 }).start()
      }
      onPressOut={() =>
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 6 }).start()
      }
      hitSlop={hitSlop}
      style={style}>
      <Animated.View style={{ transform: [{ scale }], opacity: disabled ? 0.5 : 1 }}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

// ───────────────────────────────────────────────────── colorForKind

/**
 * Centralized lookup for kind tints. Kept here so EventsTable + Today share.
 */
export function kindTint(theme: ThemeTokens, kind: EventKind): string {
  return theme.kindColors[kind] ?? theme.accent;
}

// styles export so screens can compose with shared.makeStyles
export const widgetStyles = StyleSheet.create({
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  spaceBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});

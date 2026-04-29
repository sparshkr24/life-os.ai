/**
 * Three themes: dark / light / modern. Adds a richer color palette
 * (`accent2`, `accent3`, `kindColors`) so the UI isn't black-white-blue.
 *
 * Mono font is `JetBrainsMono_400Regular` (loaded once in App.tsx via
 * `useFonts` from @expo-google-fonts/jetbrains-mono). Until it's loaded,
 * components fall back to the platform default so nothing crashes.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import type { EventKind } from './db/schema';

export type ThemeName = 'dark' | 'light' | 'modern';

/** Per-event-kind tint used in the events table (left bar + kind chip). */
export type KindColors = Record<EventKind, string>;

export interface ThemeTokens {
  name: ThemeName;
  bg: string;
  bgElev: string;
  card: string;
  cardBorder: string;
  text: string;
  textMuted: string;
  textFaint: string;

  accent: string;       // primary
  accent2: string;      // secondary (used on chips, highlights)
  accent3: string;      // tertiary (rare, for special states)
  accentText: string;

  chipBg: string;
  chipText: string;
  inputBg: string;
  inputText: string;
  inputPlaceholder: string;
  rowBg: string;
  rowBorder: string;

  warn: string;
  ok: string;
  err: string;
  info: string;

  radius: number;
  statusBarStyle: 'light' | 'dark';
  monoFont: string;

  // header / floating bottom nav
  glassBg: string;
  glassBorder: string;
  glassShadow: string;
  headerGradTop: string;
  headerGradBottom: string;

  // sub-tab strip (lighter than bottom nav)
  segBg: string;
  segActiveBg: string;
  segActiveText: string;
  segText: string;

  kindColors: KindColors;
}

const MONO = 'JetBrainsMono_400Regular';

const darkKindColors: KindColors = {
  app_fg: '#3794ff',
  app_bg: '#64748b',
  screen_on: '#fbbf24',
  screen_off: '#475569',
  sleep: '#a78bfa',
  wake: '#f472b6',
  geo_enter: '#34d399',
  geo_exit: '#f87171',
  activity: '#fb923c',
  steps: '#22d3ee',
  notif: '#e879f9',
  heart_rate: '#ef4444',
  inferred_activity: '#14b8a6',
  user_clarification: '#facc15',
  ai_question: '#c084fc',
  ai_question_response: '#a78bfa',
};

const lightKindColors: KindColors = {
  app_fg: '#2563eb',
  app_bg: '#64748b',
  screen_on: '#d97706',
  screen_off: '#475569',
  sleep: '#7c3aed',
  wake: '#db2777',
  geo_enter: '#059669',
  geo_exit: '#dc2626',
  activity: '#ea580c',
  steps: '#0891b2',
  notif: '#a21caf',
  heart_rate: '#b91c1c',
  inferred_activity: '#0d9488',
  user_clarification: '#ca8a04',
  ai_question: '#9333ea',
  ai_question_response: '#7c3aed',
};

const modernKindColors: KindColors = {
  app_fg: '#a855f7',
  app_bg: '#94a3b8',
  screen_on: '#f59e0b',
  screen_off: '#64748b',
  sleep: '#6366f1',
  wake: '#ec4899',
  geo_enter: '#10b981',
  geo_exit: '#ef4444',
  activity: '#f97316',
  steps: '#06b6d4',
  notif: '#d946ef',
  heart_rate: '#e11d48',
  inferred_activity: '#2dd4bf',
  user_clarification: '#fde047',
  ai_question: '#d8b4fe',
  ai_question_response: '#c4b5fd',
};

const dark: ThemeTokens = {
  name: 'dark',
  bg: '#15171c',
  bgElev: '#1d2027',
  card: '#1d2027',
  cardBorder: '#2a2f3a',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#64748b',
  accent: '#3794ff',
  accent2: '#22d3ee',
  accent3: '#f472b6',
  accentText: '#ffffff',
  chipBg: '#252a36',
  chipText: '#cbd5e1',
  inputBg: '#1f232c',
  inputText: '#e5e7eb',
  inputPlaceholder: '#64748b',
  rowBg: '#1a1d24',
  rowBorder: '#262b35',
  warn: '#f59e0b',
  ok: '#10b981',
  err: '#f87171',
  info: '#22d3ee',
  radius: 10,
  statusBarStyle: 'light',
  monoFont: MONO,
  glassBg: 'rgba(29,32,39,0.78)',
  glassBorder: 'rgba(148,163,184,0.18)',
  glassShadow: 'rgba(0,0,0,0.55)',
  headerGradTop: '#232734',
  headerGradBottom: '#15171c',
  segBg: 'rgba(37,42,54,0.55)',
  segActiveBg: '#3794ff',
  segActiveText: '#ffffff',
  segText: '#94a3b8',
  kindColors: darkKindColors,
};

const light: ThemeTokens = {
  name: 'light',
  bg: '#f6f8fb',
  bgElev: '#ffffff',
  card: '#ffffff',
  cardBorder: '#e5e7eb',
  text: '#0f172a',
  textMuted: '#475569',
  textFaint: '#94a3b8',
  accent: '#2563eb',
  accent2: '#0d9488',
  accent3: '#db2777',
  accentText: '#ffffff',
  chipBg: '#e0e7ff',
  chipText: '#1e3a8a',
  inputBg: '#ffffff',
  inputText: '#0f172a',
  inputPlaceholder: '#94a3b8',
  rowBg: '#ffffff',
  rowBorder: '#e5e7eb',
  warn: '#d97706',
  ok: '#059669',
  err: '#dc2626',
  info: '#0284c7',
  radius: 10,
  statusBarStyle: 'dark',
  monoFont: MONO,
  glassBg: 'rgba(255,255,255,0.82)',
  glassBorder: 'rgba(15,23,42,0.10)',
  glassShadow: 'rgba(15,23,42,0.18)',
  headerGradTop: '#ffffff',
  headerGradBottom: '#eef2f7',
  segBg: 'rgba(15,23,42,0.06)',
  segActiveBg: '#2563eb',
  segActiveText: '#ffffff',
  segText: '#475569',
  kindColors: lightKindColors,
};

const modern: ThemeTokens = {
  name: 'modern',
  bg: '#fdf4ff',
  bgElev: '#ffffff',
  card: '#ffffff',
  cardBorder: '#f0d4ff',
  text: '#3b1e4a',
  textMuted: '#7e3a98',
  textFaint: '#b08abf',
  accent: '#a855f7',
  accent2: '#06b6d4',
  accent3: '#f59e0b',
  accentText: '#ffffff',
  chipBg: '#f5e1ff',
  chipText: '#6b21a8',
  inputBg: '#ffffff',
  inputText: '#3b1e4a',
  inputPlaceholder: '#c4a3d4',
  rowBg: '#ffffff',
  rowBorder: '#f0d4ff',
  warn: '#d97706',
  ok: '#059669',
  err: '#e11d48',
  info: '#0ea5e9',
  radius: 14,
  statusBarStyle: 'dark',
  monoFont: MONO,
  glassBg: 'rgba(255,255,255,0.72)',
  glassBorder: 'rgba(168,85,247,0.20)',
  glassShadow: 'rgba(168,85,247,0.28)',
  headerGradTop: '#fbe8ff',
  headerGradBottom: '#fdf4ff',
  segBg: 'rgba(168,85,247,0.10)',
  segActiveBg: '#a855f7',
  segActiveText: '#ffffff',
  segText: '#7e3a98',
  kindColors: modernKindColors,
};

export const THEMES: Record<ThemeName, ThemeTokens> = { dark, light, modern };
export const THEME_NAMES: ThemeName[] = ['dark', 'light', 'modern'];

const K_THEME = 'UI_THEME';

const Ctx = createContext<{ theme: ThemeTokens; setTheme: (n: ThemeName) => void }>({
  theme: dark,
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<ThemeName>('dark');

  useEffect(() => {
    SecureStore.getItemAsync(K_THEME).then((v) => {
      if (v === 'dark' || v === 'light' || v === 'modern') setName(v);
    });
  }, []);

  const value = useMemo(
    () => ({
      theme: THEMES[name],
      setTheme: (n: ThemeName) => {
        setName(n);
        SecureStore.setItemAsync(K_THEME, n).catch(() => {});
      },
    }),
    [name],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): { theme: ThemeTokens; setTheme: (n: ThemeName) => void } {
  return useContext(Ctx);
}

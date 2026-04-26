/**
 * Three themes: dark (low-contrast like VSCode dark+), light (whitish/blue),
 * modern (pinkish/purple, slightly larger radii). Active theme persisted in
 * SecureStore under a non-secret key. Components read tokens via useTheme().
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

export type ThemeName = 'dark' | 'light' | 'modern';

export interface ThemeTokens {
  name: ThemeName;
  bg: string;
  bgElev: string;       // top app bar / bottom nav
  card: string;
  cardBorder: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
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
  radius: number;       // base; modern uses larger
  statusBarStyle: 'light' | 'dark';
  monoFont: string;
  // Header / floating bottom nav (semi-translucent over bg).
  glassBg: string;
  glassBorder: string;
  glassShadow: string;
  // Subtle gradient stops for header band (top, bottom).
  headerGradTop: string;
  headerGradBottom: string;
}

const dark: ThemeTokens = {
  name: 'dark',
  bg: '#1e1e1e',
  bgElev: '#252526',
  card: '#252526',
  cardBorder: '#333',
  text: '#d4d4d4',
  textMuted: '#9ca3af',
  textFaint: '#6b7280',
  accent: '#3794ff',
  accentText: '#ffffff',
  chipBg: '#2d2d30',
  chipText: '#cbd5e1',
  inputBg: '#2d2d30',
  inputText: '#e5e7eb',
  inputPlaceholder: '#6b7280',
  rowBg: '#252526',
  rowBorder: '#333',
  warn: '#f59e0b',
  ok: '#10b981',
  err: '#f87171',
  radius: 8,
  statusBarStyle: 'light',
  monoFont: 'Courier',
  glassBg: 'rgba(37,37,38,0.78)',
  glassBorder: 'rgba(255,255,255,0.08)',
  glassShadow: 'rgba(0,0,0,0.55)',
  headerGradTop: '#2a2a2d',
  headerGradBottom: '#1e1e1e',
};

const light: ThemeTokens = {
  name: 'light',
  bg: '#f7f9fc',
  bgElev: '#ffffff',
  card: '#ffffff',
  cardBorder: '#e5e7eb',
  text: '#0f172a',
  textMuted: '#475569',
  textFaint: '#94a3b8',
  accent: '#2563eb',
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
  radius: 8,
  statusBarStyle: 'dark',
  monoFont: 'Courier',
  glassBg: 'rgba(255,255,255,0.78)',
  glassBorder: 'rgba(15,23,42,0.08)',
  glassShadow: 'rgba(15,23,42,0.18)',
  headerGradTop: '#ffffff',
  headerGradBottom: '#eef2f7',
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
  radius: 14,
  statusBarStyle: 'dark',
  monoFont: 'Courier',
  glassBg: 'rgba(255,255,255,0.72)',
  glassBorder: 'rgba(168,85,247,0.20)',
  glassShadow: 'rgba(168,85,247,0.28)',
  headerGradTop: '#fbe8ff',
  headerGradBottom: '#fdf4ff',
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

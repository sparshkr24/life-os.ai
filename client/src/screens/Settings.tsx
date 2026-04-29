/**
 * Settings — sectioned card layout matching the design mock.
 *
 * Sections (top → bottom):
 *   • PROFILE       — single-row entry that opens the Profile screen
 *   • THEME
 *   • TRACKING PERMISSIONS — delegated to <PermissionsCard />
 *   • API KEYS      — Anthropic + OpenAI inline editors
 *   • COST & LIMITS — daily cap with a fill bar showing today's spend
 *   • DATA          — local storage size + retention sweeps placeholder
 *   • SYSTEM DEBUG  — collector status + raw profile JSON toggle
 *
 * Profile detail is a separate screen reachable via `onOpenProfile`. We
 * removed it from the bottom nav per user request.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  loadSnapshot,
  setDailyCap,
  type SecureSnapshot,
} from '../secure/keys';
import { listProviderKeys } from '../llm/keys';
import { getProfile, todayLlmSpendUsd } from '../repos/observability';
import type { BehaviorProfileRow } from '../db/schema';
import { useTheme, THEME_NAMES } from '../theme';
import { useToast } from '../toast';
import { ActionButton, fmtTime, makeStyles, useAsyncRunner } from './shared';
import { PermissionsCard } from './PermissionsCard';
import { SectionHeader, StatusDot } from './widgets';

export function SettingsScreen({
  onOpenProfile,
  onOpenAiModels,
  onOpenPlaces,
}: {
  onOpenProfile: () => void;
  onOpenAiModels: () => void;
  onOpenPlaces: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const toast = useToast();
  const [snap, setSnap] = useState<SecureSnapshot | null>(null);
  const [spend, setSpend] = useState(0);
  const [capIn, setCapIn] = useState('');
  const [profile, setProfile] = useState<BehaviorProfileRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [keysConfigured, setKeysConfigured] = useState(false);

  const refresh = async () => {
    await run('settings load', async () => {
      const [sn, p, sp, ks] = await Promise.all([
        loadSnapshot(),
        getProfile(),
        todayLlmSpendUsd(),
        listProviderKeys(),
      ]);
      setSnap(sn);
      setProfile(p);
      setSpend(sp);
      setKeysConfigured(ks.some((k) => k.hasKey));
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
        if (capIn) await setDailyCap(Number(capIn));
        return true;
      },
      setSaving,
    );
    if (ok) {
      setCapIn('');
      toast.ok('Saved');
      await refresh();
    }
  };

  const cap = snap?.dailyCapUsd ?? 0.3;
  const spendPct = useMemo(() => Math.min(100, Math.round((spend / cap) * 100)), [spend, cap]);
  const profileConfPct = useMemo(() => {
    if (!profile) return null;
    try {
      const obj = JSON.parse(profile.data) as Record<string, unknown>;
      const c = typeof obj.confidence === 'number' ? obj.confidence : null;
      return c == null ? null : Math.round(c * 100);
    } catch {
      return null;
    }
  }, [profile]);

  return (
    <ScrollView contentContainerStyle={s.body}>
      {/* PROFILE entry — opens the dedicated Profile screen. */}
      <SectionHeader>Profile</SectionHeader>
      <Pressable onPress={onOpenProfile}>
        <View style={s.card}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
            <View style={{ flex: 1 }}>
              <Text style={[s.body2, { fontWeight: '700' }]}>Behavior profile</Text>
              <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 2 }]}>
                {profile
                  ? `built ${fmtTime(profile.built_ts)} · ${profile.based_on_days}d${
                      profileConfPct != null ? ` · ${profileConfPct}% conf` : ''
                    }`
                  : 'not built yet · runs nightly'}
              </Text>
            </View>
            <Text style={[s.tdMono, { color: theme.accent, fontWeight: '700' }]}>View →</Text>
          </View>
        </View>
      </Pressable>

      {/* THEME */}
      <SectionHeader>Theme</SectionHeader>
      <View style={s.card}>
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

      {/* TRACKING PERMISSIONS */}
      <SectionHeader>Tracking permissions</SectionHeader>
      <PermissionsCard />

      {/* PLACES — geofenced locations (v7) */}
      <SectionHeader>Places &amp; geofences</SectionHeader>
      <Pressable onPress={onOpenPlaces}>
        <View style={s.card}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
            <View style={{ flex: 1 }}>
              <Text style={[s.body2, { fontWeight: '700' }]}>Places</Text>
              <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 2 }]}>
                Add Home / Office / Gym so the AI learns your routine
              </Text>
            </View>
            <Text style={[s.tdMono, { color: theme.accent, fontWeight: '700' }]}>Open →</Text>
          </View>
        </View>
      </Pressable>

      {/* AI MODELS — navigates to AiModels screen for providers + routing */}
      <SectionHeader>AI models</SectionHeader>
      <Pressable onPress={onOpenAiModels}>
        <View style={s.card}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
            <View style={{ flex: 1 }}>
              <Text style={[s.body2, { fontWeight: '700' }]}>Providers &amp; routing</Text>
              <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 2 }]}>
                {keysConfigured ? 'configured' : 'add OpenAI / OpenRouter keys'}
              </Text>
            </View>
            <Text style={[s.tdMono, { color: theme.accent, fontWeight: '700' }]}>Open →</Text>
          </View>
        </View>
      </Pressable>

      {/* COST & LIMITS */}
      <SectionHeader>Cost &amp; limits</SectionHeader>
      <View style={s.card}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
          }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.body2, { fontWeight: '700' }]}>Daily compute cap</Text>
            <Text style={[s.tdMonoSm, { color: theme.textMuted, marginTop: 2 }]}>
              resets at local midnight
            </Text>
          </View>
          <Text style={[s.h2, { fontSize: 20 }]}>
            ${spend.toFixed(3)}
            <Text style={[s.body2, { color: theme.textMuted }]}> / ${cap.toFixed(2)}</Text>
          </Text>
        </View>
        {/* spend fill bar */}
        <View
          style={{
            marginTop: 10,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.chipBg,
            overflow: 'hidden',
          }}>
          <View
            style={{
              width: `${spendPct}%`,
              height: '100%',
              backgroundColor: spendPct >= 90 ? theme.err : spendPct >= 60 ? theme.warn : theme.ok,
            }}
          />
        </View>
        <TextInput
          placeholder={`new cap (current ${cap.toFixed(2)})`}
          placeholderTextColor={theme.inputPlaceholder}
          value={capIn}
          onChangeText={setCapIn}
          keyboardType="decimal-pad"
          style={s.input}
        />
      </View>

      <ActionButton onPress={onSave} loading={saving} label="Save changes" />

      {/* SYSTEM DEBUG */}
      <SectionHeader>System debug</SectionHeader>
      <View style={s.card}>
        <DebugRow
          title="Service"
          value={profile?.model ?? 'idle'}
          dotColor={profile ? theme.ok : theme.warn}
        />
        <DebugRow
          title="Last profile rebuild"
          value={profile ? fmtTime(profile.built_ts) : 'never'}
          dotColor={profile ? theme.ok : theme.textFaint}
        />
        <DebugRow
          title="Profile sample size"
          value={profile ? `${profile.based_on_days} days` : '—'}
          dotColor={theme.info}
        />
      </View>
    </ScrollView>
  );
}

function DebugRow({
  title,
  value,
  dotColor,
}: {
  title: string;
  value: string;
  dotColor: string;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 6,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
        <StatusDot color={dotColor} size={7} />
        <Text style={[s.body2, { color: theme.text }]}>{title}</Text>
      </View>
      <Text style={[s.tdMonoSm, { color: theme.textFaint }]}>{value}</Text>
    </View>
  );
}

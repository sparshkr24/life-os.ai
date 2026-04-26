import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  loadSnapshot,
  setAnthropicKey,
  setOpenAiKey,
  setDailyCap,
  type SecureSnapshot,
} from '../secure/keys';
import { getProfile } from '../repos/observability';
import type { BehaviorProfileRow } from '../db/schema';
import { useTheme, THEME_NAMES } from '../theme';
import { useToast } from '../toast';
import { ActionButton, fmtTime, makeStyles, safeJson, useAsyncRunner } from './shared';
import { PermissionsCard } from './PermissionsCard';

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

      <PermissionsCard />

      <View style={s.card}>
        <Text style={s.label}>Anthropic API key (Sonnet)</Text>
        <Text style={s.body2}>
          {snap?.anthropicSet ? `set ${snap.anthropicTail}` : 'not set'}
        </Text>
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
            <Text style={s.muted}>
              {profile.based_on_days} days · {profile.model} · confidence{' '}
              {String(summary.confidence ?? '?')}
            </Text>
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

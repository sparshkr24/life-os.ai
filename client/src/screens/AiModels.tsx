/**
 * AI Models — single screen that owns:
 *  - Provider keys for openai / anthropic / minimax / deepseek
 *  - Task → model assignment matrix (rows=tasks, cols=models)
 *
 * Layout (top → bottom):
 *   1. Header with back ←
 *   2. Providers section: 4 cards (label, key tail, secure-text input)
 *      Bulk save button writes any non-empty inputs.
 *   3. Routing matrix: per task, list every chat model from a provider that
 *      has a key set. Tap a row to assign. Default-when-unset is shown.
 *   4. Help footnote linking to the docs.
 *
 * Why a single screen: keeping providers + routing together makes the cause/
 * effect ("why is my chat using model X?") obvious at one glance.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { useToast } from '../toast';
import { ActionButton, makeStyles, useAsyncRunner } from './shared';
import { SectionHeader } from './widgets';
import {
  ALL_PROVIDERS,
  PROVIDER_KEY_HINT,
  PROVIDER_LABELS,
} from '../llm/providers/registry';
import {
  listProviderKeys,
  setProviderKey,
  deleteProviderKey,
  type ProviderKeyStatus,
} from '../llm/keys';
import {
  loadAssignments,
  setAssignment,
  type TaskAssignmentMap,
} from '../llm/assignments';
import {
  ASSIGNABLE_TASKS,
  DEFAULT_TASK_MODELS,
  TASK_DESCRIPTIONS,
  TASK_LABELS,
  chatModels,
  findModel,
} from '../llm/models';
import type { ProviderId, TaskKind } from '../llm/types';

export function AiModelsScreen({ onBack }: { onBack: () => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const run = useAsyncRunner();
  const toast = useToast();

  const [keys, setKeys] = useState<ProviderKeyStatus[]>([]);
  const [assignments, setAssignmentsState] = useState<TaskAssignmentMap>({});
  const [drafts, setDrafts] = useState<Partial<Record<ProviderId, string>>>({});
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    await run('aimodels load', async () => {
      const [k, a] = await Promise.all([listProviderKeys(), loadAssignments()]);
      setKeys(k);
      setAssignmentsState(a);
    });
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSaveKeys = async () => {
    const ok = await run(
      'save keys',
      async () => {
        for (const p of ALL_PROVIDERS) {
          const v = drafts[p];
          if (typeof v === 'string' && v.length > 0) {
            await setProviderKey(p, v);
          }
        }
        return true;
      },
      setSaving,
    );
    if (ok) {
      setDrafts({});
      toast.ok('Keys saved');
      await refresh();
    }
  };

  const onClearKey = async (p: ProviderId) => {
    await run('clear key', async () => {
      await deleteProviderKey(p);
      return true;
    });
    toast.ok(`${PROVIDER_LABELS[p]} cleared`);
    await refresh();
  };

  const onPickModel = async (task: TaskKind, modelId: string) => {
    await run('assign model', async () => {
      await setAssignment(task, modelId);
      return true;
    });
    setAssignmentsState((prev) => ({ ...prev, [task]: modelId }));
  };

  const enabledProviders = useMemo(
    () => new Set(keys.filter((k) => k.hasKey).map((k) => k.provider)),
    [keys],
  );

  // Models we can actually call (chat-only, provider key present).
  const usableModels = useMemo(
    () => chatModels().filter((m) => enabledProviders.has(m.provider)),
    [enabledProviders],
  );

  return (
    <ScrollView contentContainerStyle={s.body}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={[s.h2, { fontSize: 22, color: theme.accent }]}>←</Text>
        </Pressable>
        <Text style={[s.h2, { marginLeft: 12 }]}>AI Models</Text>
      </View>

      {/* PROVIDERS */}
      <SectionHeader>Providers</SectionHeader>
      <Text style={[s.tdMonoSm, { color: theme.textMuted, marginBottom: 8 }]}>
        Keys are stored in the device&apos;s secure store and never leave the phone except
        inside HTTPS request headers to the chosen provider.
      </Text>
      {ALL_PROVIDERS.map((p) => {
        const k = keys.find((x) => x.provider === p);
        return (
          <View key={p} style={s.card}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
              <Text style={[s.body2, { fontWeight: '700' }]}>{PROVIDER_LABELS[p]}</Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: k?.hasKey ? theme.ok : theme.textFaint,
                  }}
                />
                <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                  {k?.hasKey ? `set · ${k.tail}` : 'not set'}
                </Text>
              </View>
            </View>
            <TextInput
              placeholder={PROVIDER_KEY_HINT[p]}
              placeholderTextColor={theme.inputPlaceholder}
              value={drafts[p] ?? ''}
              onChangeText={(t) => setDrafts((d) => ({ ...d, [p]: t }))}
              secureTextEntry
              autoCapitalize="none"
              style={s.input}
            />
            {k?.hasKey ? (
              <Pressable onPress={() => onClearKey(p)} style={{ marginTop: 6 }}>
                <Text style={[s.tdMonoSm, { color: theme.err }]}>Remove key</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      <ActionButton onPress={onSaveKeys} loading={saving} label="Save keys" />

      {/* ROUTING MATRIX */}
      <SectionHeader>Routing</SectionHeader>
      <Text style={[s.tdMonoSm, { color: theme.textMuted, marginBottom: 8 }]}>
        Pick which model handles each task. Only models from providers with a key are
        listed; everything else falls back to the default.
      </Text>

      {usableModels.length === 0 ? (
        <View style={s.card}>
          <Text style={[s.body2, { color: theme.textMuted }]}>
            Add at least one provider key above to enable routing.
          </Text>
        </View>
      ) : (
        ASSIGNABLE_TASKS.map((task) => {
          const current = assignments[task] ?? DEFAULT_TASK_MODELS[task];
          const currentModel = findModel(current);
          const currentUsable = currentModel && enabledProviders.has(currentModel.provider);
          return (
            <View key={task} style={s.card}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}>
                <Text style={[s.body2, { fontWeight: '700' }]}>{TASK_LABELS[task]}</Text>
                <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                  {currentUsable ? '' : 'fallback'}
                </Text>
              </View>
              <Text style={[s.tdMonoSm, { color: theme.textMuted, marginBottom: 8 }]}>
                {TASK_DESCRIPTIONS[task]}
              </Text>
              {usableModels.map((m) => {
                const selected = current === m.id;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => onPickModel(task, m.id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 8,
                      paddingHorizontal: 4,
                      borderTopWidth: 1,
                      borderTopColor: theme.rowBorder,
                    }}>
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        borderWidth: 2,
                        borderColor: selected ? theme.accent : theme.cardBorder,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: 10,
                      }}>
                      {selected ? (
                        <View
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: 5,
                            backgroundColor: theme.accent,
                          }}
                        />
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.body2, { color: theme.text }]}>{m.label}</Text>
                      <Text style={[s.tdMonoSm, { color: theme.textMuted }]}>
                        {PROVIDER_LABELS[m.provider]} · ${m.pricePerMInput.toFixed(2)} in / $
                        {m.pricePerMOutput.toFixed(2)} out per 1M
                        {!m.capabilities.toolCalls && task === 'chat' ? ' · ⚠ no tools' : ''}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          );
        })
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

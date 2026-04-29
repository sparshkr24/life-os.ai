/**
 * Pending proactive question card (v7).
 *
 * Renders the most recent `proactive_questions` row whose status='pending'.
 * Buttons match `expected_kind`:
 *   yes_no      → [Yes] [No]
 *   place_name  → preset chips for the question's options + free-form text
 *                 input → tapping a choice auto-saves a place (with toast +
 *                 5-second undo).
 *   free_text   → multiline input + Send.
 *
 * Polls every 10 s while mounted (cheap — single indexed select). Re-fetch
 * is also triggered immediately after the user answers.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { withDb } from '../db';
import { applyProactiveAnswer } from '../brain/proactive';
import { dismissProactiveNotification } from '../rules/proactiveNotify';
import { deviceTz } from '../aggregator/time';
import { useTheme } from '../theme';
import { useToast } from '../toast';
import { makeStyles } from '../screens/shared';
import type { ProactiveQuestionRow } from '../db/schema';

const POLL_MS = 10_000;

export function PendingQuestionCard() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const toast = useToast();
  const [row, setRow] = useState<ProactiveQuestionRow | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await withDb((db) =>
      db.getFirstAsync<ProactiveQuestionRow>(
        `SELECT * FROM proactive_questions
         WHERE status = 'pending' ORDER BY ts DESC LIMIT 1`,
      ),
    );
    setRow(r ?? null);
    setDraft('');
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!row) return null;

  const optionsParsed: string[] = (() => {
    try {
      const v = JSON.parse(row.options);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  })();

  const submit = async (text: string) => {
    if (busy) return;
    const clean = text.trim();
    if (!clean) return;
    setBusy(true);
    try {
      const tz = deviceTz();
      const res = await withDb((db) =>
        applyProactiveAnswer(
          db,
          { questionId: row.id, text: clean, fromInAppCard: true },
          tz,
        ),
      );
      if (row.notification_id) await dismissProactiveNotification(row.notification_id);
      if (res.placeId) {
        toast.ok(`Saved "${clean}" — manage in Settings → Places`);
      } else {
        toast.ok('Thanks');
      }
      await refresh();
    } catch (e) {
      toast.error('Save failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await withDb((db) =>
        db.runAsync(
          `UPDATE proactive_questions
              SET status='dismissed', response_ts=?
            WHERE id = ?`,
          [Date.now(), row.id],
        ),
      );
      if (row.notification_id) await dismissProactiveNotification(row.notification_id);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.card, { borderColor: theme.accent, borderWidth: 1, gap: 10 }]}>
      <Text style={[s.tdMonoSm, { color: theme.accent }]}>AI · question</Text>
      <Text style={[s.body2, { color: theme.text }]}>{row.prompt}</Text>

      {row.expected_kind === 'yes_no' && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pill label="Yes" onPress={() => submit('Yes')} disabled={busy} />
          <Pill label="No" onPress={() => submit('No')} disabled={busy} />
          <Pill label="Skip" onPress={decline} disabled={busy} muted />
        </View>
      )}

      {row.expected_kind === 'place_name' && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {optionsParsed.map((opt) => (
              <Pill key={opt} label={opt} onPress={() => submit(opt)} disabled={busy} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Or type a name…"
              placeholderTextColor={theme.inputPlaceholder}
              style={{
                flex: 1,
                color: theme.text,
                backgroundColor: theme.card,
                borderColor: theme.textMuted,
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontFamily: theme.monoFont,
              }}
              editable={!busy}
            />
            <Pill label="Save" onPress={() => submit(draft)} disabled={busy || !draft.trim()} />
            <Pill label="Skip" onPress={decline} disabled={busy} muted />
          </View>
        </>
      )}

      {row.expected_kind === 'free_text' && (
        <View style={{ gap: 8 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Type your reply…"
            placeholderTextColor={theme.inputPlaceholder}
            multiline
            style={{
              minHeight: 60,
              color: theme.text,
              backgroundColor: theme.card,
              borderColor: theme.textMuted,
              borderWidth: 1,
              borderRadius: 8,
              padding: 10,
              fontFamily: theme.monoFont,
              textAlignVertical: 'top',
            }}
            editable={!busy}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pill label="Send" onPress={() => submit(draft)} disabled={busy || !draft.trim()} />
            <Pill label="Skip" onPress={decline} disabled={busy} muted />
          </View>
        </View>
      )}
    </View>
  );
}

function Pill({
  label,
  onPress,
  disabled,
  muted,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  muted?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        backgroundColor: muted ? 'transparent' : theme.accent,
        borderColor: muted ? theme.textMuted : theme.accent,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 999,
      })}>
      <Text
        style={{
          color: muted ? theme.textMuted : theme.bg,
          fontFamily: theme.monoFont,
          fontWeight: '700',
          fontSize: 13,
        }}>
        {label}
      </Text>
    </Pressable>
  );
}

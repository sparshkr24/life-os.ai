/**
 * Stage-9 chat. Calls Sonnet via `runChatTurn` (brain/chat.ts), which exposes
 * read-only tools over the local DB. Renders user/assistant bubbles plus a
 * subtle footer showing today's LLM spend and the cost of the latest reply.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from './shared';
import { runChatTurn, type ChatTurn } from '../brain/chat';
import { todayLlmSpendUsd } from '../repos/observability';
import { useToast } from '../toast';

export function ChatScreen() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const toast = useToast();
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [spend, setSpend] = useState(0);
  const [lastCost, setLastCost] = useState<number | null>(null);
  const [kbUp, setKbUp] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    todayLlmSpendUsd().then(setSpend).catch(() => {});
  }, [messages.length]);

  // The Shell already shrinks the viewport above the keyboard. We only need
  // to know whether the keyboard is up so the toolbar can drop its FloatingNav
  // clearance (110 px) and sit flush against the keyboard.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setKbUp(true));
    const b = Keyboard.addListener(hideEvt, () => setKbUp(false));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const now = Date.now();
    const next: ChatTurn[] = [...messages, { role: 'user', text, ts: now }];
    setMessages(next);
    setInput('');
    setSending(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 30);
    try {
      const r = await runChatTurn(next);
      if (r.skipped === 'cost_cap') {
        toast.error('daily LLM cap reached — bump it in Settings');
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            text: 'Daily LLM spend cap is exhausted. Increase the cap in Settings or wait until tomorrow.',
            ts: Date.now(),
          },
        ]);
      } else if (r.skipped === 'no_key') {
        toast.error('add an Anthropic key in Settings');
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            text: 'No Anthropic key set. Add one in Settings → API Keys to enable chat.',
            ts: Date.now(),
          },
        ]);
      } else if (r.error) {
        toast.error('chat: ' + r.error);
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            text: `Error: ${r.error}`,
            ts: Date.now(),
          },
        ]);
      } else {
        setLastCost(r.costUsd);
        setMessages((m) => [
          ...m,
          { role: 'assistant', text: r.text, ts: Date.now() },
        ]);
      }
    } catch (e) {
      toast.error('chat: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSending(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 30);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        style={s.list}
        contentContainerStyle={{ padding: 14, paddingBottom: 16, gap: 8 }}>
        {messages.length === 0 && (
          <View style={[s.card, { marginHorizontal: 0 }]}>
            <Text style={s.label}>Chat</Text>
            <Text style={[s.body2, { marginTop: 6, color: theme.textMuted }]}>
              Ask about your day, sleep, top apps, or what your profile says about you.
              Replies use real numbers from your local data — never invented.
            </Text>
          </View>
        )}
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
        {sending && (
          <View style={[s.bubble, s.bubbleAssistant, { alignSelf: 'flex-start' }]}>
            <ActivityIndicator color={theme.accent} />
          </View>
        )}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: 6,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}>
        <Text style={[s.tdMonoSm, { color: theme.textFaint, flex: 1 }]}>
          today: ${spend.toFixed(4)}
          {lastCost != null && ` · last reply $${lastCost.toFixed(5)}`}
        </Text>
      </View>
      <View style={[s.toolbar, { paddingBottom: kbUp ? 10 : 110 }]}>
        <TextInput
          placeholder="Ask anything…"
          placeholderTextColor={theme.inputPlaceholder}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={send}
          editable={!sending}
          style={[s.input, { flex: 1 }]}
        />
        <Pressable
          onPress={send}
          disabled={sending || !input.trim()}
          style={[s.btnInline, (sending || !input.trim()) && { opacity: 0.5 }]}>
          <Text style={s.btnText}>{sending ? '…' : 'Send'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

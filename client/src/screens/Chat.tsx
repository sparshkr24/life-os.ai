import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from './shared';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export function ChatScreen() {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');

  const send = () => {
    const text = input.trim();
    if (!text) return;
    const now = Date.now();
    setMessages((m) => [
      ...m,
      { role: 'user', text, ts: now },
      {
        role: 'assistant',
        text:
          'Chat is wired in Stage 9. Set the Anthropic key in Settings, and once Sonnet ' +
          'tool-calling lands, replies will render here.',
        ts: now + 1,
      },
    ]);
    setInput('');
  };

  return (
    <View style={[s.body, { paddingBottom: 0 }]}>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 120 }}>
        {messages.length === 0 && (
          <Text style={s.muted}>Shell only — Stage 9 wires Sonnet with tools.</Text>
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
      </ScrollView>
      <View style={[s.toolbar, { paddingBottom: 110 }]}>
        <TextInput
          placeholder="Ask anything…"
          placeholderTextColor={theme.inputPlaceholder}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={send}
          style={[s.input, { flex: 1 }]}
        />
        <Pressable onPress={send} style={s.btnInline}>
          <Text style={s.btnText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

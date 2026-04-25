import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

// Default to localhost for web; on a real device set EXPO_PUBLIC_SERVER_URL
// to your laptop's LAN IP, e.g. http://192.168.1.42:3000
const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type Health = {
  ok: boolean;
  service: string;
  version: string;
  now: string;
};

export default function App() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'err'>(
    'idle',
  );
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ping = async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Health;
      setData(json);
      setStatus('ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('err');
    }
  };

  useEffect(() => {
    ping();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>AI Life OS</Text>
      <Text style={styles.subtitle}>v0.0.1 · client running</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Server</Text>
        <Text style={styles.mono}>{SERVER_URL}</Text>

        {status === 'loading' && <ActivityIndicator style={{ marginTop: 12 }} />}
        {status === 'ok' && data && (
          <>
            <Text style={[styles.badge, styles.badgeOk]}>OK</Text>
            <Text style={styles.mono}>{data.service}</Text>
            <Text style={styles.mono}>{data.now}</Text>
          </>
        )}
        {status === 'err' && (
          <>
            <Text style={[styles.badge, styles.badgeErr]}>UNREACHABLE</Text>
            <Text style={styles.error}>{error}</Text>
            <Text style={styles.hint}>
              On a real device, set EXPO_PUBLIC_SERVER_URL to your laptop's LAN
              IP (run `ipconfig getifaddr en0`).
            </Text>
          </>
        )}

        <Pressable onPress={ping} style={styles.button}>
          <Text style={styles.buttonText}>Ping /health</Text>
        </Pressable>
      </View>

      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: { color: '#fff', fontSize: 32, fontWeight: '700' },
  subtitle: { color: '#888', marginTop: 4, marginBottom: 32 },
  card: {
    width: '100%',
    backgroundColor: '#16161d',
    borderRadius: 12,
    padding: 20,
    gap: 6,
  },
  label: { color: '#888', fontSize: 12, textTransform: 'uppercase' },
  mono: { color: '#ddd', fontFamily: 'Courier', fontSize: 13 },
  badge: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '700',
    fontSize: 11,
    overflow: 'hidden',
  },
  badgeOk: { backgroundColor: '#10b981', color: '#000' },
  badgeErr: { backgroundColor: '#ef4444', color: '#fff' },
  error: { color: '#fca5a5', marginTop: 4 },
  hint: { color: '#888', marginTop: 8, fontSize: 12, lineHeight: 18 },
  button: {
    marginTop: 16,
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
});

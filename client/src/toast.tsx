/**
 * Tiny toast system. One-line API: const toast = useToast(); toast.error('...')
 * Auto-dismisses. No deps. Stacked at the bottom of the screen above the nav.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from './theme';

type ToastKind = 'info' | 'error' | 'ok';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  info(text: string): void;
  error(text: string): void;
  ok(text: string): void;
}

const Ctx = createContext<ToastApi>({ info: () => {}, error: () => {}, ok: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++idRef.current;
    setItems((arr) => [...arr, { id, kind, text }]);
    setTimeout(() => setItems((arr) => arr.filter((t) => t.id !== id)), 2800);
  }, []);

  const api: ToastApi = {
    info: (t) => push('info', t),
    error: (t) => push('error', t),
    ok: (t) => push('ok', t),
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      <View pointerEvents="none" style={styles.host}>
        {items.map((t) => (
          <ToastBubble key={t.id} item={t} />
        ))}
      </View>
    </Ctx.Provider>
  );
}

function ToastBubble({ item }: { item: ToastItem }) {
  const { theme } = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(ty, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [opacity, ty]);

  const bg =
    item.kind === 'error' ? theme.err : item.kind === 'ok' ? theme.ok : theme.bgElev;
  const fg = item.kind === 'info' ? theme.text : '#ffffff';

  return (
    <Animated.View
      style={[
        styles.bubble,
        {
          backgroundColor: bg,
          borderColor: theme.cardBorder,
          opacity,
          transform: [{ translateY: ty }],
        },
      ]}>
      <Text style={[styles.text, { color: fg }]} numberOfLines={3}>
        {item.text}
      </Text>
    </Animated.View>
  );
}

export function useToast(): ToastApi {
  return useContext(Ctx);
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 100,
    alignItems: 'center',
    gap: 6,
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    maxWidth: '88%',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  text: { fontSize: 13, fontWeight: '600' },
});

/**
 * Root shell. ThemeProvider + ToastProvider wrap a 4-tab layout:
 * Today / Observe / Chat / Settings.
 *
 * Header is a layered band (two stacked translucent rectangles fake a soft
 * gradient without expo-linear-gradient).
 *
 * Bottom nav is a floating glass-style pill detached from screen edges.
 * The active item slides under an Animated accent pill (no extra deps).
 */
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  useFonts,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import { migrate } from './src/db';
import { LifeOsBridge } from './src/bridge/lifeOsBridge';
import { registerAggregatorTask } from './src/aggregator/worker';
import { startRulesForegroundLoop } from './src/rules/worker';
import {
  TodayScreen,
  ObservabilityScreen,
  ChatScreen,
  ProfileScreen,
  SettingsScreen,
  AiModelsScreen,
  type TabId,
} from './src/screens';
import { ThemeProvider, useTheme } from './src/theme';
import { ToastProvider, useToast } from './src/toast';
import { ErrorBoundary, reportFatal } from './src/ErrorBoundary';

// Global handler for unhandled JS errors AND unhandled promise rejections.
// React's ErrorBoundary only catches render-time errors; this catches the
// rest (async callbacks, setTimeout, untracked promises) and forwards them
// to the boundary so the user sees a crash card instead of a white screen.
installGlobalErrorHandlers();

function installGlobalErrorHandlers(): void {
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (e: Error, isFatal?: boolean) => void;
      setGlobalHandler?: (fn: (e: Error, isFatal?: boolean) => void) => void;
    };
    process?: { on?: (ev: string, fn: (e: unknown) => void) => void };
  };
  const eu = g.ErrorUtils;
  if (eu?.getGlobalHandler && eu.setGlobalHandler) {
    const prev = eu.getGlobalHandler();
    eu.setGlobalHandler((e, isFatal) => {
      try {
        reportFatal(e instanceof Error ? e : new Error(String(e)));
      } catch {
        /* ignore */
      }
      try {
        prev(e, isFatal);
      } catch {
        /* ignore */
      }
    });
  }
  // RN's HermesPromiseRejectionTracker fires this on unhandled rejections.
  if (g.process?.on) {
    g.process.on('unhandledRejection', (reason: unknown) => {
      reportFatal(reason instanceof Error ? reason : new Error(String(reason)));
    });
  }
}

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: '◐' },
  { id: 'observe', label: 'Observe', icon: '☰' },
  { id: 'chat', label: 'Chat', icon: '✦' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [fontsLoaded] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });
  return (
    <ThemeProvider>
      <ToastProvider>
        <ErrorBoundary>
          {fontsLoaded ? <Shell /> : <FontGate />}
        </ErrorBoundary>
      </ToastProvider>
    </ThemeProvider>
  );
}

function FontGate() {
  const { theme } = useTheme();
  return (
    <View style={[styles.shell, { backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }]}>
      <ActivityIndicator color={theme.accent} />
    </View>
  );
}

function Shell() {
  const { theme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('today');
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [usageGranted, setUsageGranted] = useState<boolean | null>(null);

  const native = Platform.OS === 'android' && !!LifeOsBridge;

  useEffect(() => {
    (async () => {
      try {
        await migrate();
        registerAggregatorTask().catch((e: unknown) => {
          console.error('[boot] registerAggregatorTask failed:', e);
        });
        startRulesForegroundLoop();
        if (native) {
          setUsageGranted(await LifeOsBridge.hasUsageAccess());
          await LifeOsBridge.startService().catch((e: unknown) => {
            toast.error('Service start failed: ' + (e instanceof Error ? e.message : String(e)));
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBootErr(msg);
        toast.error('Boot failed: ' + msg);
      }
    })();
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (bootErr) {
    return (
      <View style={[styles.shell, { backgroundColor: theme.bg, padding: 24, gap: 12 }]}>
        <Text style={[styles.title, { color: theme.text }]}>Life OS</Text>
        <Text style={[styles.bootErr, { color: theme.err }]}>boot error: {bootErr}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.shell, { backgroundColor: theme.bg }]}>
      {/* Layered header band (fake gradient via two stacked layers). */}
      <View style={[styles.headerWrap, { backgroundColor: theme.headerGradBottom }]}>
        <View style={[styles.headerOverlay, { backgroundColor: theme.headerGradTop, opacity: 0.55 }]} />
        <View style={styles.headerContent}>
          <View style={styles.headerLeft}>
            <View style={[styles.brandDot, { backgroundColor: theme.accent, shadowColor: theme.accent }]} />
            <View>
              <Text style={[styles.title, { color: theme.text, fontFamily: theme.monoFont }]}>life.os</Text>
              <Text style={[styles.subtitle, { color: theme.textMuted, fontFamily: theme.monoFont }]}>
                {tabSubtitle(tab)}
              </Text>
            </View>
          </View>
          {native && usageGranted === false && (
            <Pressable
              onPress={() =>
                LifeOsBridge.openUsageAccessSettings().then(async () =>
                  setUsageGranted(await LifeOsBridge.hasUsageAccess()),
                )
              }
              style={[styles.warnBtn, { backgroundColor: theme.warn }]}>
              <Text style={styles.warnText}>Grant Usage</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.content}>
        {tab === 'today' && <TodayScreen onTab={setTab} />}
        {tab === 'observe' && <ObservabilityScreen />}
        {tab === 'chat' && <ChatScreen />}
        {tab === 'profile' && <ProfileScreen onBack={() => setTab('settings')} />}
        {tab === 'aimodels' && <AiModelsScreen onBack={() => setTab('settings')} />}
        {tab === 'settings' && (
          <SettingsScreen
            onOpenProfile={() => setTab('profile')}
            onOpenAiModels={() => setTab('aimodels')}
          />
        )}
      </View>

      <FloatingNav
        tab={tab === 'profile' || tab === 'aimodels' ? 'settings' : tab}
        onTab={setTab}
      />

      <StatusBar style={theme.statusBarStyle} />
    </View>
  );
}

function tabSubtitle(t: TabId): string {
  switch (t) {
    case 'today':
      return 'at a glance';
    case 'observe':
      return 'raw data · rollups · llm · nudges';
    case 'chat':
      return 'ask anything (stage 9)';
    case 'profile':
      return "the AI's model of you";
    case 'aimodels':
      return 'providers · routing';
    case 'settings':
      return 'theme · keys · profile';
  }
}

function FloatingNav({ tab, onTab }: { tab: TabId; onTab: (t: TabId) => void }) {
  const { theme } = useTheme();
  const idx = TABS.findIndex((t) => t.id === tab);
  const [navW, setNavW] = useState(0);
  const slot = useRef(new Animated.Value(idx)).current;

  useEffect(() => {
    Animated.spring(slot, { toValue: idx, useNativeDriver: false, friction: 9, tension: 120 }).start();
  }, [idx, slot]);

  const innerW = Math.max(0, navW - 12); // minus horizontal padding (6 + 6)
  const slotW = innerW / TABS.length;
  const pillTranslate = slot.interpolate({
    inputRange: [0, Math.max(1, TABS.length - 1)],
    outputRange: [0, slotW * (TABS.length - 1)],
  });

  return (
    <View pointerEvents="box-none" style={styles.navOuter}>
      <View
        onLayout={(e) => setNavW(e.nativeEvent.layout.width)}
        style={[
          styles.nav,
          {
            backgroundColor: theme.glassBg,
            borderColor: theme.glassBorder,
            shadowColor: theme.glassShadow,
            borderRadius: 32,
          },
        ]}>
        {/* sliding accent pill */}
        {slotW > 0 && (
          <Animated.View
            style={[
              styles.pill,
              {
                width: slotW,
                backgroundColor: theme.accent,
                transform: [{ translateX: pillTranslate }],
                borderRadius: 26,
              },
            ]}
          />
        )}
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <Pressable
              key={t.id}
              onPress={() => onTab(t.id)}
              style={styles.navItem}
              hitSlop={6}>
              <Text style={[styles.navIcon, { color: active ? theme.accentText : theme.textMuted }]}>
                {t.icon}
              </Text>
              <Text
                style={[
                  styles.navLabel,
                  {
                    color: active ? theme.accentText : theme.textMuted,
                    fontWeight: active ? '700' : '500',
                    fontFamily: theme.monoFont,
                  },
                ]}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  headerWrap: {
    paddingTop: 48,
    paddingBottom: 14,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(127,127,127,0.15)',
    overflow: 'hidden',
  },
  headerOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  headerContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  brandDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    shadowOpacity: 0.8,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: 0.3 },
  subtitle: { fontSize: 11, marginTop: 1, letterSpacing: 0.4 },
  warnBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999 },
  warnText: { color: '#000', fontWeight: '700', fontSize: 11 },
  content: { flex: 1 },

  navOuter: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 18,
  },
  nav: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
    overflow: 'hidden',
  },
  pill: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    left: 6,
    marginLeft: 0,
  },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 6 },
  navIcon: { fontSize: 18 },
  navLabel: { fontSize: 11 },
  bootErr: { fontFamily: 'Courier' },
});

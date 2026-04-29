/**
 * Global error boundary. Catches any uncaught render-time exception in the
 * descendant tree, shows a crash card with the error message + stack +
 * "Try again" button (which remounts children by bumping a key).
 *
 * Note: React error boundaries catch render / lifecycle / constructor
 * errors only. They do NOT catch:
 *   - errors thrown inside async callbacks (Promises, setTimeout, fetch)
 *   - errors thrown in event handlers
 *   - errors thrown in the boundary itself
 *
 * For those we install a global `ErrorUtils.setGlobalHandler` in App.tsx
 * which forwards to a module-level `reportFatal` function the boundary
 * subscribes to.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from './theme';

interface Props {
  children: React.ReactNode;
}

interface State {
  err: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo): void {
    console.error('[boundary] caught:', err.message, info.componentStack);
  }

  reset = (): void => {
    this.setState({ err: null });
  };

  componentDidMount(): void {
    setFatalReporter((err) => this.setState({ err }));
  }

  componentWillUnmount(): void {
    setFatalReporter(null);
  }

  render(): React.ReactNode {
    if (this.state.err) {
      return <CrashScreen err={this.state.err} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

// ── module-level bridge so App's global handler can push into the boundary
let fatalReporter: ((err: Error) => void) | null = null;
function setFatalReporter(fn: ((err: Error) => void) | null): void {
  fatalReporter = fn;
}
export function reportFatal(err: Error): void {
  if (fatalReporter) fatalReporter(err);
  else console.error('[boundary] no reporter mounted yet:', err.message);
}

function CrashScreen({ err, onReset }: { err: Error; onReset: () => void }): React.ReactElement {
  const { theme } = useTheme();
  return (
    <View style={[s.shell, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={[s.title, { color: theme.err, fontFamily: theme.monoFont }]}>
          ✗ LifeOs.ai crashed
        </Text>
        <Text style={[s.subtitle, { color: theme.textMuted, fontFamily: theme.monoFont }]}>
          The app caught an unhandled error. Tap retry to try again, or paste the trace below
          when reporting.
        </Text>

        <View style={[s.card, { backgroundColor: theme.bgElev, borderColor: theme.glassBorder }]}>
          <Text style={[s.label, { color: theme.textMuted, fontFamily: theme.monoFont }]}>
            message
          </Text>
          <Text style={[s.body, { color: theme.text, fontFamily: theme.monoFont }]}>
            {err.message || '(no message)'}
          </Text>
        </View>

        {err.stack ? (
          <View style={[s.card, { backgroundColor: theme.bgElev, borderColor: theme.glassBorder }]}>
            <Text style={[s.label, { color: theme.textMuted, fontFamily: theme.monoFont }]}>
              stack
            </Text>
            <Text style={[s.stack, { color: theme.text, fontFamily: theme.monoFont }]}>
              {err.stack}
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={onReset}
          style={[s.btn, { backgroundColor: theme.accent }]}>
          <Text style={[s.btnText, { color: theme.bg, fontFamily: theme.monoFont }]}>retry</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1 },
  scroll: { padding: 24, gap: 16, paddingTop: 64 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 13, lineHeight: 18 },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  label: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  body: { fontSize: 13, lineHeight: 18 },
  stack: { fontSize: 11, lineHeight: 16 },
  btn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { fontSize: 14, fontWeight: '700', letterSpacing: 1 },
});

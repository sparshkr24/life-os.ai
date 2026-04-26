/**
 * Rule-engine worker. Two surfaces:
 *
 *   - `startRulesForegroundLoop()` — JS setInterval, 60s, while the app is
 *     mounted. The architecture spec asks for 60s ticks; this is the only
 *     practical way to hit that on Android without writing a Kotlin
 *     evaluator. Quietly does nothing while the app is killed.
 *
 *   - `runRulesOnceFromBackground()` — called from the 15-min aggregator
 *     tick (worker.ts) so users still get nudges when the app is closed,
 *     albeit at coarser granularity.
 *
 * Both call into the same pure `evaluateRules()`.
 */
import { AppState, type AppStateStatus } from 'react-native';
import { ensureNotificationChannels } from './notify';
import { evaluateRules } from './engine';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let lastTick = 0;

export function startRulesForegroundLoop(): void {
  if (timer) return;
  void ensureNotificationChannels();

  const tick = () => {
    const now = Date.now();
    if (now - lastTick < TICK_MS - 1000) return;
    lastTick = now;
    void evaluateRules();
  };

  timer = setInterval(tick, TICK_MS);
  // Also fire on resume so users get an immediate evaluation when the app
  // comes back to the foreground.
  appStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') tick();
  });
  // Initial fire on registration.
  tick();
  console.log('[rules-worker] foreground loop started @ 60s');
}

export async function runRulesOnceFromBackground(): Promise<void> {
  await ensureNotificationChannels();
  await evaluateRules();
}

export function stopRulesForegroundLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  appStateSub?.remove();
  appStateSub = null;
}

export function lastRulesTickTs(): number {
  return lastTick;
}

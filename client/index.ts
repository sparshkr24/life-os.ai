import { AppRegistry } from 'react-native';
import { registerRootComponent } from 'expo';

import App from './App';
import { runAggregatorTick } from './src/aggregator';
import { migrate } from './src/db';

// Headless JS task fired by AggregatorHeadlessTaskService (Kotlin) every
// 15 min from inside our FG service. Runs even when the app UI is killed
// — that's the whole point. The Kotlin side enforces the 15-min cadence
// via `schema_meta.last_aggregator_ts`, so this body just runs one tick.
//
// Registration MUST happen at module load (before App mounts) so the
// runtime can dispatch into it on a cold start.
const HEADLESS_TASK_NAME = 'LifeOsAggregator';

AppRegistry.registerHeadlessTask(HEADLESS_TASK_NAME, () => async () => {
  const t0 = Date.now();
  console.log('[headless-aggregator] start');
  try {
    // Ensure schema is at the latest version. Migrate is idempotent and
    // ~instant when no work is needed. Required because the headless task
    // can run before App.tsx ever mounts (cold start while app is killed).
    await migrate();
    const r = await runAggregatorTick();
    console.log(
      `[headless-aggregator] done ok=${r.ok} dur=${Date.now() - t0}ms` +
        (r.error ? ` err=${r.error}` : ''),
    );
  } catch (e) {
    console.error(
      '[headless-aggregator] crashed:',
      e instanceof Error ? e.message : String(e),
    );
  }
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App).
// The headless task registered above runs without ever mounting App.
registerRootComponent(App);

/**
 * 15-minute aggregator worker. Wraps `runAggregatorTick` in expo-task-manager
 * + expo-background-fetch (Android backs this with WorkManager).
 *
 * Lifecycle:
 *   - The task name is registered at module load (must be before App mounts)
 *     so it's available across cold starts triggered by the OS scheduler.
 *   - `registerAggregatorTask()` is called from App.tsx after `migrate()` —
 *     it sets the periodic task with a 15-minute floor.
 *   - The task itself calls `runAggregatorTick()` and returns a status code.
 *
 * iOS support is irrelevant (sideload-only Android app), but the API is
 * cross-platform; it just won't fire on iOS without UIBackgroundModes setup.
 */
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { AppState, type AppStateStatus } from 'react-native';
import { withDb } from '../db';
import { runAggregatorTick } from './index';

export const AGGREGATOR_TASK = 'lifeos.aggregator.tick';
const INTERVAL_SEC = 15 * 60;
const INTERVAL_MS = INTERVAL_SEC * 1000;
// Foreground self-drive: 60s probes; fire only when 15 min have elapsed
// since the last successful tick. Cheap — one schema_meta read per probe.
const FOREGROUND_PROBE_MS = 60_000;

// Register the task body at module load. expo-task-manager requires this
// happen at import time so the OS can re-instantiate the JS runtime and
// dispatch into it on a scheduled wake.
TaskManager.defineTask(AGGREGATOR_TASK, async () => {
  try {
    const r = await runAggregatorTick();
    return r.ok
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.Failed;
  } catch (e) {
    console.error('[aggregator-task] error:', e instanceof Error ? e.message : String(e));
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/**
 * Registers the periodic task. Idempotent — re-registering with the same name
 * is a no-op for expo-background-fetch.
 */
export async function registerAggregatorTask(): Promise<void> {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
        status === BackgroundFetch.BackgroundFetchStatus.Denied) {
      console.warn('[aggregator-task] background fetch disabled by OS, status=' + status);
      return;
    }
    await BackgroundFetch.registerTaskAsync(AGGREGATOR_TASK, {
      minimumInterval: INTERVAL_SEC,
      stopOnTerminate: false,
      startOnBoot: true,
    });
    console.log('[aggregator-task] registered, interval=' + INTERVAL_SEC + 's');
  } catch (e) {
    console.error('[aggregator-task] register failed:', e instanceof Error ? e.message : String(e));
  }
}

/** Returns the OS-reported status of the periodic task. Used by Today screen. */
export async function aggregatorTaskStatus(): Promise<{
  registered: boolean;
  status: BackgroundFetch.BackgroundFetchStatus | null;
}> {
  const registered = await TaskManager.isTaskRegisteredAsync(AGGREGATOR_TASK);
  let status: BackgroundFetch.BackgroundFetchStatus | null = null;
  try {
    status = await BackgroundFetch.getStatusAsync();
  } catch {
    /* ignore */
  }
  return { registered, status };
}

// ── Foreground driver ──────────────────────────────────────────────────────
// expo-background-fetch / WorkManager is wildly unreliable on Android —
// the OS regularly defers a "15 min minimum" job to 25–60 min under Doze,
// battery saver, or just bad luck. While the app is open we drive the tick
// ourselves on a 60s probe so the user always sees fresh rollups within a
// minute of when they're due. Background fetches remain registered as a
// best-effort fallback for when the app is killed.

let probeTimer: ReturnType<typeof setInterval> | null = null;
let probeAppStateSub: { remove: () => void } | null = null;
let probeRunning = false;

export function startAggregatorForegroundLoop(): void {
  if (probeTimer) return;

  const probe = async () => {
    if (probeRunning) return;
    probeRunning = true;
    try {
      const last = await readLastTickTs();
      const due = last === null || Date.now() - last >= INTERVAL_MS;
      if (!due) return;
      console.log('[aggregator-fg] firing tick (last=' + (last ?? 'never') + ')');
      await runAggregatorTick();
    } catch (e) {
      console.error('[aggregator-fg] probe failed:', e instanceof Error ? e.message : String(e));
    } finally {
      probeRunning = false;
    }
  };

  probeTimer = setInterval(probe, FOREGROUND_PROBE_MS);
  // Re-probe on resume so a long sleep doesn't leave the user with stale
  // rollups after they unlock the phone.
  probeAppStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') void probe();
  });
  // Initial probe on mount.
  void probe();
  console.log('[aggregator-fg] foreground loop started @ 60s, due-floor=' + INTERVAL_SEC + 's');
}

async function readLastTickTs(): Promise<number | null> {
  try {
    return await withDb(async (db) => {
      const row = await db.getFirstAsync<{ value: string } | null>(
        `SELECT value FROM schema_meta WHERE key = ?`,
        ['last_aggregator_ts'],
      );
      const n = row?.value ? Number(row.value) : NaN;
      return Number.isFinite(n) ? n : null;
    });
  } catch {
    return null;
  }
}

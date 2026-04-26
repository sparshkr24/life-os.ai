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
import { runAggregatorTick } from './index';

export const AGGREGATOR_TASK = 'lifeos.aggregator.tick';
const INTERVAL_SEC = 15 * 60;

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

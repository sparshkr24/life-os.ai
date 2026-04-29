package com.lifeos

import android.content.Intent
import android.os.Bundle
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Boots the JS runtime headless and runs the registered aggregator task.
 *
 * Why this exists: `expo-background-fetch` (WorkManager-backed) is wildly
 * unreliable on aggressive OEMs (ColorOS / RealmeUI / OneUI / MIUI). The
 * 15-min "minimum interval" routinely stretches to 30–90 min, and JS may
 * never even be loaded if the app was swiped away. Our Kotlin foreground
 * service runs forever, so we drive the aggregator from there: every 15
 * min the FG service starts THIS service, which boots a JS context just
 * long enough to run `runAggregatorTick()` and then shuts itself down.
 *
 * The matching JS task is registered in `client/index.ts` via
 * `AppRegistry.registerHeadlessTask('LifeOsAggregator', ...)`.
 *
 * Timeout: 4 min. The aggregator typically completes in <5 s. The cap
 * exists so a stuck JS turn can't hold a wakelock forever.
 */
class AggregatorHeadlessTaskService : HeadlessJsTaskService() {

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    Log.i(TAG, "headless task starting")
    val data: Bundle = intent?.extras ?: Bundle()
    return HeadlessJsTaskConfig(
      TASK_NAME,
      Arguments.fromBundle(data),
      TIMEOUT_MS,
      true, // allowedInForeground — fine to also run when app UI is open
    )
  }

  companion object {
    private const val TAG = "LifeOsHeadless"
    const val TASK_NAME = "LifeOsAggregator"
    private const val TIMEOUT_MS = 4L * 60_000L // 4 min hard cap
  }
}

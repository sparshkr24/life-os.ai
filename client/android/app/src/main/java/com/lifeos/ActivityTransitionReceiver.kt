package com.lifeos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * Receives Activity Transitions (still / walking / running / on-bicycle / in-vehicle).
 *
 * Registered by `LifeOsForegroundService.registerActivityTransitions()` against
 * a PendingIntent that targets this receiver. Writes one `activity` event per
 * transition with the detected type and whether it was an enter or exit.
 */
class ActivityTransitionReceiver : BroadcastReceiver() {

  override fun onReceive(ctx: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    for (ev in result.transitionEvents) {
      val typeName = activityName(ev.activityType)
      val direction = if (ev.transitionType == 0) "enter" else "exit"
      val nowMs = System.currentTimeMillis()
      val payload =
        """{"activity":"$typeName","direction":"$direction","source":"activity_recognition"}"""
      EventDb.insert(ctx, "activity", nowMs, payload)
      Log.i(TAG, "transition $direction $typeName")
    }
  }

  private fun activityName(t: Int): String = when (t) {
    DetectedActivity.IN_VEHICLE -> "in_vehicle"
    DetectedActivity.ON_BICYCLE -> "on_bicycle"
    DetectedActivity.ON_FOOT -> "on_foot"
    DetectedActivity.RUNNING -> "running"
    DetectedActivity.STILL -> "still"
    DetectedActivity.TILTING -> "tilting"
    DetectedActivity.WALKING -> "walking"
    else -> "unknown"
  }

  companion object {
    private const val TAG = "LifeOsActivity"
    const val ACTION = "com.lifeos.ACTIVITY_TRANSITIONS"
  }
}

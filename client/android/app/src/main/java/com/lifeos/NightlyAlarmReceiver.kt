package com.lifeos

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.util.Calendar

/**
 * Stage 8 — daily 03:05 AlarmManager kicker.
 *
 * What it does: at 03:05 local time every day, this receiver fires and
 * starts the foreground service (no-op if already running). That's it.
 *
 * Why so minimal: the actual nightly Sonnet rebuild lives in JS. We can't
 * reliably re-enter the JS runtime from a broadcast receiver if the app
 * was killed, so we don't try. Instead, the JS-side watchdog inside
 * `runAggregatorTick` checks whether a nightly is due and runs it itself.
 * The alarm's only job is to make sure the FG service is alive, which keeps
 * `expo-background-fetch` ticking, which lets the watchdog fire promptly.
 *
 * Doze mode: setAlarmClock survives Doze. We use it because reliability
 * trumps battery for one alarm per day at 03:05.
 */
class NightlyAlarmReceiver : BroadcastReceiver() {

  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action != ACTION) {
      // setAlarmClock pending intent fires with our action; ignore others.
      return
    }
    Log.i(TAG, "nightly alarm fired — starting FG service")
    try {
      ctx.startForegroundService(Intent(ctx, LifeOsForegroundService::class.java))
    } catch (e: Exception) {
      Log.e(TAG, "startForegroundService failed: ${e.message}")
    }
    // Reschedule for tomorrow. setAlarmClock is one-shot.
    schedule(ctx)
  }

  companion object {
    private const val TAG = "LifeOsNightly"
    const val ACTION = "com.lifeos.NIGHTLY_KICK"
    private const val REQUEST_CODE = 4321
    private const val NIGHTLY_HOUR = 3
    private const val NIGHTLY_MINUTE = 5

    /**
     * Schedules the next 03:05 alarm. Idempotent — re-scheduling overwrites
     * the prior PendingIntent. Call from the FG service's onCreate.
     */
    fun schedule(ctx: Context) {
      val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val triggerAt = nextNightlyMillis()
      val pi = pendingIntent(ctx)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
          // SCHEDULE_EXACT_ALARM not granted (Android 12+); fall back to
          // setAndAllowWhileIdle. Less precise but still survives Doze.
          am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
          Log.i(TAG, "scheduled (inexact) for $triggerAt")
        } else {
          am.setAlarmClock(AlarmManager.AlarmClockInfo(triggerAt, null), pi)
          Log.i(TAG, "scheduled (exact) for $triggerAt")
        }
      } catch (e: Exception) {
        Log.e(TAG, "schedule failed: ${e.message}")
      }
    }

    private fun pendingIntent(ctx: Context): PendingIntent {
      val intent = Intent(ctx, NightlyAlarmReceiver::class.java).apply { action = ACTION }
      return PendingIntent.getBroadcast(
        ctx, REQUEST_CODE, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun nextNightlyMillis(): Long {
      val cal = Calendar.getInstance().apply {
        timeInMillis = System.currentTimeMillis()
        set(Calendar.HOUR_OF_DAY, NIGHTLY_HOUR)
        set(Calendar.MINUTE, NIGHTLY_MINUTE)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
      }
      // If we're already past 03:05 today, schedule for tomorrow.
      if (cal.timeInMillis <= System.currentTimeMillis()) {
        cal.add(Calendar.DAY_OF_YEAR, 1)
      }
      return cal.timeInMillis
    }
  }
}

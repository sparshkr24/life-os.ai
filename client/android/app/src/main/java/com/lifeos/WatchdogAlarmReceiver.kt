package com.lifeos

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.util.Log
import java.io.File

/**
 * Reliability watchdog. Fires every 15 min via AlarmManager (chained
 * one-shot, survives Doze via setExactAndAllowWhileIdle). On each fire:
 *   1. Reads `schema_meta.service_heartbeat_ts` from the DB.
 *   2. If stale (> STALE_THRESHOLD_MS), starts the FG service AND raises
 *      a high-importance notification telling the user the collector
 *      stopped and offering a one-tap restart.
 *   3. If fresh, cancels any prior dead-service notification.
 *   4. Re-schedules the next watchdog tick.
 *
 * Why not WorkManager: `expo-background-fetch` (WorkManager-backed) is
 * deferred 25-60 min on most OEMs under Doze. setExactAndAllowWhileIdle
 * is honored more aggressively — exactly the opposite tradeoff we want
 * for a liveness check.
 *
 * Why a separate notification channel: the user MUST see the alert when
 * the collector dies; the silent low-importance FG notification channel
 * won't pop a heads-up. We use a dedicated IMPORTANCE_HIGH channel.
 */
class WatchdogAlarmReceiver : BroadcastReceiver() {

  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action != ACTION) return
    Log.i(TAG, "watchdog tick")

    val now = System.currentTimeMillis()
    val heartbeatMs = readHeartbeatMs(ctx)
    val ageMs = if (heartbeatMs > 0L) now - heartbeatMs else Long.MAX_VALUE
    val stale = ageMs > STALE_THRESHOLD_MS

    if (stale) {
      Log.w(TAG, "STALE: heartbeat age=${ageMs}ms — restarting service + alerting user")
      try {
        ctx.startForegroundService(Intent(ctx, LifeOsForegroundService::class.java))
      } catch (e: Exception) {
        Log.e(TAG, "startForegroundService failed: ${e.message}")
      }
      showStaleNotification(ctx, ageMs)
    } else {
      Log.i(TAG, "alive: heartbeat age=${ageMs}ms")
      cancelStaleNotification(ctx)
    }

    schedule(ctx)
  }

  private fun readHeartbeatMs(ctx: Context): Long {
    val f = File(ctx.filesDir, "SQLite/lifeos.db")
    if (!f.exists()) return 0L
    val db = try {
      SQLiteDatabase.openDatabase(f.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
    } catch (e: Exception) {
      Log.e(TAG, "db open failed: ${e.message}")
      return 0L
    }
    return try {
      db.rawQuery(
        "SELECT value FROM schema_meta WHERE key = ?",
        arrayOf("service_heartbeat_ts"),
      ).use { c ->
        if (c.moveToFirst()) c.getString(0)?.toLongOrNull() ?: 0L else 0L
      }
    } catch (e: Exception) {
      Log.e(TAG, "read heartbeat failed: ${e.message}")
      0L
    } finally {
      try { db.close() } catch (_: Exception) {}
    }
  }

  private fun showStaleNotification(ctx: Context, ageMs: Long) {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(
        ALERT_CHANNEL_ID,
        "Life OS alerts",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply { description = "Fires when the background collector has stopped" }
    )
    val tapIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
    val tapPi = if (tapIntent != null) {
      PendingIntent.getActivity(
        ctx, 0, tapIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    } else null

    val ageMin = ageMs / 60_000L
    val notif = android.app.Notification.Builder(ctx, ALERT_CHANNEL_ID)
      .setContentTitle("Life OS collector stopped")
      .setContentText("No data for ${ageMin}m. Tap to restart.")
      .setSmallIcon(android.R.drawable.stat_notify_error)
      .setAutoCancel(true)
      .also { if (tapPi != null) it.setContentIntent(tapPi) }
      .build()
    nm.notify(ALERT_NOTIF_ID, notif)
  }

  private fun cancelStaleNotification(ctx: Context) {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    nm.cancel(ALERT_NOTIF_ID)
  }

  companion object {
    private const val TAG = "LifeOsWatchdog"
    const val ACTION = "com.lifeos.WATCHDOG_TICK"
    private const val REQUEST_CODE = 4322
    private const val ALERT_CHANNEL_ID = "lifeos_alerts"
    private const val ALERT_NOTIF_ID = 1001

    /** How often the watchdog runs. 15 min is the sweet spot for Doze. */
    private const val INTERVAL_MS = 15L * 60_000L

    /**
     * If the heartbeat is older than this, the FG service is considered
     * dead. 3 min = 3 missed 60s polls — long enough to ride out one or
     * two SQL contention skips, short enough to catch real death fast.
     */
    private const val STALE_THRESHOLD_MS = 3L * 60_000L

    fun schedule(ctx: Context) {
      val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val triggerAt = System.currentTimeMillis() + INTERVAL_MS
      val pi = pendingIntent(ctx)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            Log.i(TAG, "scheduled (inexact) for $triggerAt")
          } else {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            Log.i(TAG, "scheduled (exact) for $triggerAt")
          }
        } else {
          am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi)
        }
      } catch (e: Exception) {
        Log.e(TAG, "schedule failed: ${e.message}")
      }
    }

    private fun pendingIntent(ctx: Context): PendingIntent {
      val intent = Intent(ctx, WatchdogAlarmReceiver::class.java).apply { action = ACTION }
      return PendingIntent.getBroadcast(
        ctx, REQUEST_CODE, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }
}

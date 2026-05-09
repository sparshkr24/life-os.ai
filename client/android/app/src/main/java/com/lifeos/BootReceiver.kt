package com.lifeos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    Log.i("LifeOsBoot", "boot completed; starting service + scheduling watchdog")
    try {
      ctx.startForegroundService(Intent(ctx, LifeOsForegroundService::class.java))
    } catch (e: Exception) {
      Log.e("LifeOsBoot", "startForegroundService failed: ${e.message}")
    }
    // Schedule watchdog independently of the service start — if the
    // service start failed, the watchdog will retry it in 15 min and
    // alert the user via notification.
    try {
      WatchdogAlarmReceiver.schedule(ctx)
    } catch (e: Exception) {
      Log.e("LifeOsBoot", "watchdog schedule failed: ${e.message}")
    }
  }
}

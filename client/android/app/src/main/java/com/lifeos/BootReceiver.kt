package com.lifeos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    Log.i("LifeOsBoot", "boot completed; starting service")
    ctx.startForegroundService(Intent(ctx, LifeOsForegroundService::class.java))
  }
}

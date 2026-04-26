package com.lifeos

import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap

class LifeOsBridgeModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "LifeOsBridge"

  @ReactMethod
  fun startService(promise: Promise) {
    Log.i(TAG, "startService called")
    try {
      // POST_NOTIFICATIONS is a runtime permission on Android 13+; without it
      // the foreground notification doesn't render even though the service runs.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getCurrentActivity()?.requestPermissions(
          arrayOf("android.permission.POST_NOTIFICATIONS"), 1001
        )
      }
      val intent = Intent(ctx, LifeOsForegroundService::class.java)
      ctx.startForegroundService(intent)
      Log.i(TAG, "startForegroundService ok")
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "startService failed", e)
      promise.reject("start_failed", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun hasUsageAccess(promise: Promise) {
    try {
      val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
      val mode = appOps.unsafeCheckOpNoThrow(
        AppOpsManager.OPSTR_GET_USAGE_STATS,
        Process.myUid(),
        ctx.packageName
      )
      promise.resolve(mode == AppOpsManager.MODE_ALLOWED)
    } catch (e: Exception) {
      Log.e(TAG, "hasUsageAccess failed", e)
      promise.reject("usage_check_failed", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun openUsageAccessSettings(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
      intent.data = Uri.parse("package:${ctx.packageName}")
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "openUsageAccessSettings failed", e)
      promise.reject("settings_failed", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun getStats(promise: Promise) {
    try {
      val map: WritableMap = Arguments.createMap()
      val dbFile = java.io.File(ctx.filesDir, "SQLite/lifeos.db")
      var eventsLastHour = 0
      var lastInsertTs: Long = 0
      var totalEvents = 0
      if (dbFile.exists()) {
        val db = android.database.sqlite.SQLiteDatabase.openDatabase(
          dbFile.absolutePath, null, android.database.sqlite.SQLiteDatabase.OPEN_READONLY
        )
        try {
          val sinceMs = System.currentTimeMillis() - 60 * 60 * 1000
          db.rawQuery(
            "SELECT count(*), coalesce(max(ts),0) FROM events WHERE ts >= ?",
            arrayOf(sinceMs.toString())
          ).use { c ->
            if (c.moveToFirst()) {
              eventsLastHour = c.getInt(0)
              lastInsertTs = c.getLong(1)
            }
          }
          db.rawQuery("SELECT count(*) FROM events", null).use { c ->
            if (c.moveToFirst()) totalEvents = c.getInt(0)
          }
        } finally {
          db.close()
        }
      }
      map.putInt("eventsLastHour", eventsLastHour)
      map.putInt("totalEvents", totalEvents)
      map.putDouble("lastInsertTs", lastInsertTs.toDouble())
      map.putBoolean("dbExists", dbFile.exists())
      Log.i(TAG, "getStats: total=$totalEvents lastHour=$eventsLastHour dbExists=${dbFile.exists()}")
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e(TAG, "getStats failed", e)
      promise.reject("stats_failed", e.message ?: "unknown", e)
    }
  }

  companion object {
    private const val TAG = "LifeOsBridge"
    private const val REQ_AR = 1101
    private const val REQ_LOC_FG = 1102
    private const val REQ_LOC_BG = 1103
  }

  // ─── Stage 3b: Activity Recognition permission ────────────────────────────

  @ReactMethod
  fun hasActivityRecognitionPermission(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.resolve(true); return
    }
    val granted = ContextCompat.checkSelfPermission(
      ctx, "android.permission.ACTIVITY_RECOGNITION",
    ) == PackageManager.PERMISSION_GRANTED
    promise.resolve(granted)
  }

  @ReactMethod
  fun requestActivityRecognitionPermission(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.resolve(true); return
      }
      val activity = getCurrentActivity()
      if (activity == null) {
        promise.reject("no_activity", "No foreground activity")
        return
      }
      activity.requestPermissions(
        arrayOf("android.permission.ACTIVITY_RECOGNITION"), REQ_AR
      )
      // Result lands in Activity.onRequestPermissionsResult which we don't
      // observe here. JS should re-check `hasActivityRecognitionPermission`
      // after a short delay.
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "requestActivityRecognitionPermission failed", e)
      promise.reject("perm_failed", e.message ?: "unknown", e)
    }
  }

  // ─── Stage 3c: Location + Geofences ───────────────────────────────────────

  @ReactMethod
  fun hasLocationPermissions(promise: Promise) {
    val map: WritableMap = Arguments.createMap()
    map.putBoolean("fine", check("android.permission.ACCESS_FINE_LOCATION"))
    map.putBoolean(
      "background",
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        check("android.permission.ACCESS_BACKGROUND_LOCATION")
      else true,
    )
    promise.resolve(map)
  }

  @ReactMethod
  fun requestForegroundLocation(promise: Promise) {
    try {
      val act = getCurrentActivity()
        ?: return promise.reject("no_activity", "No foreground activity")
      act.requestPermissions(
        arrayOf("android.permission.ACCESS_FINE_LOCATION"), REQ_LOC_FG,
      )
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("perm_failed", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun requestBackgroundLocation(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.resolve(true); return
      }
      val act = getCurrentActivity()
        ?: return promise.reject("no_activity", "No foreground activity")
      act.requestPermissions(
        arrayOf("android.permission.ACCESS_BACKGROUND_LOCATION"), REQ_LOC_BG,
      )
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("perm_failed", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun setGeofences(places: ReadableArray, promise: Promise) {
    try {
      val list = mutableListOf<GeofenceManager.Place>()
      for (i in 0 until places.size()) {
        val m = places.getMap(i) ?: continue
        list.add(
          GeofenceManager.Place(
            id = m.getString("id") ?: continue,
            lat = m.getDouble("lat"),
            lng = m.getDouble("lng"),
            radiusM = m.getDouble("radiusM").toFloat(),
          )
        )
      }
      GeofenceManager.setGeofences(ctx, list) { err ->
        if (err == null) promise.resolve(list.size)
        else promise.reject("geofence_failed", err.message ?: "unknown", err)
      }
    } catch (e: Exception) {
      Log.e(TAG, "setGeofences failed", e)
      promise.reject("geofence_failed", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun removeAllGeofences(promise: Promise) {
    GeofenceManager.removeAll(ctx) { err ->
      if (err == null) promise.resolve(null)
      else promise.reject("geofence_remove_failed", err.message ?: "unknown", err)
    }
  }

  // ─── Stage 3c: NotificationListener access ────────────────────────────────

  @ReactMethod
  fun hasNotificationListenerAccess(promise: Promise) {
    val cn = ComponentName(ctx, LifeOsNotificationListener::class.java)
    val flat = Settings.Secure.getString(
      ctx.contentResolver, "enabled_notification_listeners"
    ) ?: ""
    promise.resolve(flat.contains(cn.flattenToString()))
  }

  @ReactMethod
  fun openNotificationListenerSettings(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("settings_failed", e.message ?: "unknown", e)
    }
  }

  // ─── Stage 3d: Health Connect ─────────────────────────────────────────────

  @ReactMethod
  fun isHealthConnectAvailable(promise: Promise) {
    promise.resolve(HealthConnectCollector.isAvailable(ctx))
  }

  @ReactMethod
  fun openHealthConnect(promise: Promise) {
    try {
      // Settings → Health Connect (Android 14+). Falls back to a Play Store
      // search if the system page isn't there yet.
      val intent = Intent("android.health.connect.action.HEALTH_HOME_SETTINGS")
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        ctx.startActivity(intent)
      } catch (_: Exception) {
        val fallback = Intent(
          Intent.ACTION_VIEW,
          Uri.parse("market://details?id=com.google.android.apps.healthdata")
        )
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(fallback)
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("hc_open_failed", e.message ?: "unknown", e)
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private fun check(perm: String): Boolean =
    ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED
}

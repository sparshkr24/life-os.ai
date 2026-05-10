package com.lifeos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent
import java.io.File

/**
 * Receives geofence enter/exit transitions. The geofence requestId we register
 * is the place id (e.g. "home", "office") so we can resolve labels JS-side.
 *
 * v8: places have a `kind` column. For `kind='ignored'` places we still need
 * the geofence (to suppress dwell detection) but we DON'T write geo_enter /
 * geo_exit events — the user explicitly said "don't track this place".
 */
class GeofenceReceiver : BroadcastReceiver() {

  override fun onReceive(ctx: Context, intent: Intent) {
    val event = GeofencingEvent.fromIntent(intent) ?: return
    if (event.hasError()) {
      Log.e(TAG, "geofencing error: ${event.errorCode}")
      return
    }
    val transition = event.geofenceTransition
    val kind = when (transition) {
      Geofence.GEOFENCE_TRANSITION_ENTER -> "geo_enter"
      Geofence.GEOFENCE_TRANSITION_EXIT -> "geo_exit"
      else -> return
    }
    val now = System.currentTimeMillis()
    val triggering = event.triggeringGeofences ?: return
    val ignoredIds = loadIgnoredPlaceIds(ctx)
    for (g in triggering) {
      val placeId = g.requestId
      // Mirror place transitions into PhoneState so subsequent events get
      // stamped with where the user is. No fresh GPS fix — just bookkeeping.
      PhoneState.placeId = if (kind == "geo_enter") placeId else null
      // Always notify PlaceDetector — even ignored places suppress dwell.
      if (kind == "geo_enter") {
        PlaceDetector.onGeofenceEnter(ctx, placeId)
      }
      if (placeId in ignoredIds) {
        Log.i(TAG, "$kind place=$placeId (ignored) — suppressed")
        continue
      }
      val loc = event.triggeringLocation
      val lat = loc?.latitude ?: 0.0
      val lng = loc?.longitude ?: 0.0
      val payload =
        """{"place_id":"$placeId","lat":$lat,"lng":$lng,"source":"geofence"}"""
      EventDb.insert(ctx, kind, now, payload)
      Log.i(TAG, "$kind place=$placeId")
    }
  }

  /**
   * Read the small set of place ids marked ignored. Cheap on this device
   * (typically <10 places). Done per-event so a freshly-toggled place takes
   * effect immediately without restarting the service.
   */
  private fun loadIgnoredPlaceIds(ctx: Context): Set<String> {
    val f = File(ctx.filesDir, "SQLite/lifeos.db")
    if (!f.exists()) return emptySet()
    val db = try {
      SQLiteDatabase.openDatabase(f.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
    } catch (e: Exception) {
      Log.w(TAG, "loadIgnoredPlaceIds open failed: ${e.message}")
      return emptySet()
    }
    val out = HashSet<String>()
    try {
      db.rawQuery(
        "SELECT id FROM places WHERE kind = 'ignored'",
        null,
      ).use { c ->
        while (c.moveToNext()) {
          val id = c.getString(0) ?: continue
          out.add(id)
        }
      }
    } catch (e: Exception) {
      // Schema might not yet have `kind` column on a fresh upgrade run
      // before JS migrations finish. Treat as no-ignored.
      Log.w(TAG, "loadIgnoredPlaceIds query failed: ${e.message}")
    } finally {
      try { db.close() } catch (_: Exception) { /* ignore */ }
    }
    return out
  }

  companion object {
    private const val TAG = "LifeOsGeo"
    const val ACTION = "com.lifeos.GEOFENCE_TRANSITIONS"
  }
}

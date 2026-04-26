package com.lifeos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/**
 * Receives geofence enter/exit transitions. The geofence requestId we register
 * is the place id (e.g. "home", "office") so we can resolve labels JS-side.
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
    for (g in triggering) {
      val placeId = g.requestId
      val loc = event.triggeringLocation
      val lat = loc?.latitude ?: 0.0
      val lng = loc?.longitude ?: 0.0
      val payload =
        """{"place_id":"$placeId","lat":$lat,"lng":$lng,"source":"geofence"}"""
      EventDb.insert(ctx, kind, now, payload)
      Log.i(TAG, "$kind place=$placeId")
    }
  }

  companion object {
    private const val TAG = "LifeOsGeo"
    const val ACTION = "com.lifeos.GEOFENCE_TRANSITIONS"
  }
}

package com.lifeos

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices

/**
 * Wraps GeofencingClient. Called by `LifeOsBridgeModule.setGeofences` /
 * `removeAllGeofences`. Permission checks happen at the bridge boundary —
 * if we get here, FINE+BACKGROUND location are granted.
 *
 * We use one PendingIntent per process; replacing geofences first removes
 * the previous registration so the system doesn't accumulate stale circles.
 */
object GeofenceManager {
  private const val TAG = "LifeOsGeoMgr"

  data class Place(val id: String, val lat: Double, val lng: Double, val radiusM: Float)

  fun setGeofences(ctx: Context, places: List<Place>, onDone: (Throwable?) -> Unit) {
    val client = LocationServices.getGeofencingClient(ctx)
    val pi = pendingIntent(ctx)
    client.removeGeofences(pi).addOnCompleteListener {
      if (places.isEmpty()) {
        Log.i(TAG, "geofences cleared (empty list)")
        onDone(null)
        return@addOnCompleteListener
      }
      val fences = places.map(::toGeofence)
      val req = GeofencingRequest.Builder()
        .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
        .addGeofences(fences)
        .build()
      try {
        client.addGeofences(req, pi)
          .addOnSuccessListener {
            Log.i(TAG, "registered ${places.size} geofences")
            onDone(null)
          }
          .addOnFailureListener { e ->
            Log.e(TAG, "addGeofences failed: ${e.message}")
            onDone(e)
          }
      } catch (e: SecurityException) {
        Log.e(TAG, "addGeofences security: ${e.message}")
        onDone(e)
      }
    }
  }

  fun removeAll(ctx: Context, onDone: (Throwable?) -> Unit) {
    val client: GeofencingClient = LocationServices.getGeofencingClient(ctx)
    client.removeGeofences(pendingIntent(ctx))
      .addOnSuccessListener { onDone(null) }
      .addOnFailureListener { e -> onDone(e) }
  }

  private fun toGeofence(p: Place): Geofence = Geofence.Builder()
    .setRequestId(p.id)
    .setCircularRegion(p.lat, p.lng, p.radiusM)
    .setExpirationDuration(Geofence.NEVER_EXPIRE)
    .setTransitionTypes(
      Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT
    )
    .build()

  private fun pendingIntent(ctx: Context): PendingIntent {
    val intent = Intent(ctx, GeofenceReceiver::class.java).apply {
      action = GeofenceReceiver.ACTION
    }
    return PendingIntent.getBroadcast(
      ctx, 0, intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
    )
  }
}

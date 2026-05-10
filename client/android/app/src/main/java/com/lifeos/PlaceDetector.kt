package com.lifeos

import android.annotation.SuppressLint
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.location.Location
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.io.File
import org.json.JSONObject

/**
 * Detects "the user has been still at an unknown spot" and writes a
 * `place_visit` event so the JS-side geocoder worker can reverse-geocode
 * it via Nominatim.
 *
 * State machine (singleton; one dwell tracked at a time):
 *
 *   IDLE
 *     -> on STILL/enter (and not inside any geofence): start dwell timer
 *   PROVISIONAL  (timer running, 8 min)
 *     -> on motion / geofence enter: cancel, drop
 *     -> on 8-min timer fire: capture one-shot lat/lng (FusedLocation), keep timer
 *   CAPTURED     (lat/lng cached in memory, 7 more min ticking)
 *     -> on motion / geofence enter at <15min: write deferred place_visit row
 *        with the captured coords, status=pending_geocode, then go IDLE
 *     -> on 15-min timer fire: write confirmed place_visit row,
 *        status=pending_geocode, transition to OPEN
 *   OPEN         (place_visit row exists, departure_ts open)
 *     -> on motion / geofence enter: update row's departure_ts, go IDLE
 *
 * A single Handler on the main looper runs the timers \u2014 cheap, no extra
 * threads. All state lives in this object; if the process dies, the OPEN
 * place_visit rows are closed by the JS cleanup sweep (see ingest/cleanup.ts).
 */
object PlaceDetector {
  private const val TAG = "LifeOsPlaceDet"

  // ─── tunables (mirror docs/CLAUDE.md §6.3) ──────────────────────────
  private const val PROVISIONAL_MS = 8L * 60_000L
  private const val CONFIRMED_MS = 15L * 60_000L
  private const val MIN_DEFERRED_MS = 5L * 60_000L

  private val handler = Handler(Looper.getMainLooper())

  // dwell state. Touched only on the main thread.
  private var stillEnterMs: Long = 0L
  private var capturedLat: Double = 0.0
  private var capturedLng: Double = 0.0
  private var hasCapture: Boolean = false
  private var openRowId: Long = -1L

  private val provisionalRunnable = Runnable { onProvisionalTick() }
  private val confirmedRunnable = Runnable { onConfirmedTick() }

  /** Called from ActivityTransitionReceiver after a transition is logged. */
  fun onActivityTransition(ctx: Context, activity: String, direction: String) {
    val app = ctx.applicationContext
    handler.post {
      try {
        if (activity == "still" && direction == "enter") {
          startDwell(app)
        } else {
          // Any other activity transition kills the dwell.
          endDwell(app, "motion:$activity/$direction")
        }
      } catch (e: Exception) {
        Log.e(TAG, "onActivityTransition failed", e)
      }
    }
  }

  /** Called from GeofenceReceiver when the user enters a registered place. */
  fun onGeofenceEnter(ctx: Context, placeId: String) {
    val app = ctx.applicationContext
    handler.post {
      try {
        endDwell(app, "geofence:$placeId")
      } catch (e: Exception) {
        Log.e(TAG, "onGeofenceEnter failed", e)
      }
    }
  }

  /** Cancels any in-flight timers; called from service onDestroy. */
  fun shutdown() {
    handler.removeCallbacks(provisionalRunnable)
    handler.removeCallbacks(confirmedRunnable)
    stillEnterMs = 0L
    hasCapture = false
    openRowId = -1L
  }

  // ─── state transitions ──────────────────────────────────────────────

  private fun startDwell(ctx: Context) {
    // Already inside a known geofence? Then this STILL/enter is at home /
    // office / etc \u2014 nothing to detect.
    if (PhoneState.placeId != null) {
      Log.i(TAG, "skip dwell: already in place=${PhoneState.placeId}")
      return
    }
    // Already tracking a dwell? Treat the new STILL/enter as a continuation.
    if (stillEnterMs > 0L) {
      Log.i(TAG, "skip dwell: already tracking since=${stillEnterMs}")
      return
    }
    val now = System.currentTimeMillis()
    stillEnterMs = now
    hasCapture = false
    openRowId = -1L
    handler.postDelayed(provisionalRunnable, PROVISIONAL_MS)
    handler.postDelayed(confirmedRunnable, CONFIRMED_MS)
    Log.i(TAG, "dwell start ts=$now")
  }

  private fun endDwell(ctx: Context, reason: String) {
    if (stillEnterMs == 0L && openRowId == -1L) return  // nothing to end
    val now = System.currentTimeMillis()
    val durationMs = if (stillEnterMs > 0L) now - stillEnterMs else 0L
    handler.removeCallbacks(provisionalRunnable)
    handler.removeCallbacks(confirmedRunnable)

    // If a place_visit row was already written (≥15 min reached), close it.
    if (openRowId > 0L) {
      updatePlaceVisitDeparture(ctx, openRowId, now)
      Log.i(TAG, "dwell close rowId=$openRowId duration=${durationMs}ms reason=$reason")
    }
    // Deferred-geocode case: user moved at 8..15 min with a captured fix.
    // Write a row anyway so the geocoder can label this short visit.
    else if (hasCapture && durationMs >= MIN_DEFERRED_MS) {
      val rowId = writePlaceVisit(
        ctx,
        arrivalMs = stillEnterMs,
        departureMs = now,
        lat = capturedLat,
        lng = capturedLng,
        source = "deferred_geocode",
      )
      if (rowId > 0L) {
        Log.i(TAG, "dwell deferred rowId=$rowId duration=${durationMs}ms reason=$reason")
      }
    } else {
      Log.i(TAG, "dwell drop duration=${durationMs}ms reason=$reason")
    }

    stillEnterMs = 0L
    hasCapture = false
    openRowId = -1L
  }

  private fun onProvisionalTick() {
    if (stillEnterMs == 0L) return
    captureLocation { lat, lng ->
      capturedLat = lat
      capturedLng = lng
      hasCapture = true
      Log.i(TAG, "dwell provisional fix lat=$lat lng=$lng")
    }
  }

  private fun onConfirmedTick() {
    if (stillEnterMs == 0L) return
    val ctx = PhoneState.appContext ?: return
    val arrival = stillEnterMs
    val writeWith: (Double, Double) -> Unit = { lat, lng ->
      val rowId = writePlaceVisit(
        ctx = ctx,
        arrivalMs = arrival,
        departureMs = arrival,           // open row \u2014 closed when dwell ends
        lat = lat,
        lng = lng,
        source = "confirmed",
      )
      if (rowId > 0L) {
        openRowId = rowId
        Log.i(TAG, "dwell confirmed rowId=$rowId at lat=$lat lng=$lng")
      }
    }
    if (hasCapture) {
      writeWith(capturedLat, capturedLng)
    } else {
      // No provisional fix yet (race / GPS denied). Try once more.
      captureLocation { lat, lng ->
        capturedLat = lat
        capturedLng = lng
        hasCapture = true
        writeWith(lat, lng)
      }
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────

  @SuppressLint("MissingPermission")
  private fun captureLocation(onFix: (Double, Double) -> Unit) {
    val ctx = PhoneState.appContext ?: return
    try {
      val client = LocationServices.getFusedLocationProviderClient(ctx)
      val token = CancellationTokenSource()
      // BALANCED keeps battery usage low \u2014 we only need ~50m accuracy
      // for reverse geocoding, not GPS-tier precision.
      client.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, token.token)
        .addOnSuccessListener { loc: Location? ->
          if (loc != null) {
            handler.post { onFix(loc.latitude, loc.longitude) }
          } else {
            // Cold start / indoors \u2014 fall back to lastLocation.
            client.lastLocation
              .addOnSuccessListener { last ->
                if (last != null) handler.post { onFix(last.latitude, last.longitude) }
                else Log.w(TAG, "no location available for dwell")
              }
              .addOnFailureListener { e -> Log.w(TAG, "lastLocation failed: ${e.message}") }
          }
        }
        .addOnFailureListener { e -> Log.w(TAG, "getCurrentLocation failed: ${e.message}") }
    } catch (e: SecurityException) {
      Log.w(TAG, "captureLocation no permission: ${e.message}")
    } catch (e: Exception) {
      Log.e(TAG, "captureLocation unexpected", e)
    }
  }

  private fun writePlaceVisit(
    ctx: Context,
    arrivalMs: Long,
    departureMs: Long,
    lat: Double,
    lng: Double,
    source: String,
  ): Long {
    val payload = JSONObject().apply {
      put("arrival_ts", arrivalMs)
      put("departure_ts", departureMs)
      put("lat", lat)
      put("lng", lng)
      put("status", "pending_geocode")
      put("source", source)
      put("name", JSONObject.NULL)
      put("category", JSONObject.NULL)
      put("confidence", JSONObject.NULL)
    }.toString()
    return EventDb.insertReturningId(ctx, "place_visit", arrivalMs, payload)
  }

  private fun updatePlaceVisitDeparture(ctx: Context, rowId: Long, departureMs: Long) {
    val db = openLifeOsDb(ctx) ?: return
    try {
      // Read the existing payload, mutate departure_ts + duration.
      db.rawQuery("SELECT payload FROM events WHERE id = ?", arrayOf(rowId.toString())).use { c ->
        if (!c.moveToFirst()) return
        val payload = c.getString(0) ?: return
        val obj = try { JSONObject(payload) } catch (e: Exception) { return }
        val arrival = obj.optLong("arrival_ts", 0L)
        obj.put("departure_ts", departureMs)
        if (arrival > 0L) obj.put("duration_ms", departureMs - arrival)
        db.execSQL(
          "UPDATE events SET payload = ? WHERE id = ?",
          arrayOf<Any>(obj.toString(), rowId),
        )
      }
    } catch (e: Exception) {
      Log.e(TAG, "updatePlaceVisitDeparture failed", e)
    } finally {
      try { db.close() } catch (_: Exception) { /* ignore */ }
    }
  }

  private fun openLifeOsDb(ctx: Context): SQLiteDatabase? {
    val f = File(ctx.filesDir, "SQLite/lifeos.db")
    if (!f.exists()) return null
    return try {
      val db = SQLiteDatabase.openDatabase(f.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
      try {
        db.rawQuery("PRAGMA busy_timeout = 5000", null).use { it.moveToFirst() }
      } catch (_: Exception) { /* non-fatal */ }
      db
    } catch (e: Exception) {
      Log.e(TAG, "openLifeOsDb failed: ${e.message}")
      null
    }
  }
}

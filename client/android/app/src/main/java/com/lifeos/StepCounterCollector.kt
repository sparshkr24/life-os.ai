package com.lifeos

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log

/**
 * Hardware step-counter fallback for devices where Health Connect isn't
 * usable (iQOO/Vivo/Honor/etc. — Health Connect either isn't installed or
 * the OEM hasn't whitelisted Life OS to read from it).
 *
 * `Sensor.TYPE_STEP_COUNTER` is built into virtually every Android phone
 * since 4.4 and is exposed by the kernel — no Google Play Services, no
 * cloud, no Health Connect. The reading is "total steps since last
 * device boot" and survives the app being killed (the kernel keeps
 * counting). It only needs `ACTIVITY_RECOGNITION` runtime permission,
 * which the user already grants for the activity-transitions feature.
 *
 * Battery cost is negligible: the sensor is a low-power chip that
 * batches its callbacks, the OS only wakes us up when steps actually
 * happen.
 *
 * How we use it:
 *  - On service start, register a listener; remember the first reading
 *    as the session baseline.
 *  - Every time the FG service's main poll Runnable fires (1 minute), we
 *    ask `flushIfDue()` whether ≥5 min of wall-clock has passed; if so
 *    we emit one `steps` event covering that window with the delta.
 *  - If the cumulative reading suddenly drops (device reboot), we treat
 *    that as a new session — write whatever we had, reset the baseline.
 *
 * Event written matches the Health-Connect shape so the aggregator's
 * `aggSteps` SQL doesn't have to know which source produced the row:
 *
 *     {"count":<delta>,"start_ts":<window_start>,"end_ts":<window_end>,
 *      "source":"sensor_step_counter"}
 */
object StepCounterCollector : SensorEventListener {
  private const val TAG = "LifeOsSteps"
  private const val FLUSH_INTERVAL_MS = 5 * 60_000L

  private var sensorManager: SensorManager? = null
  private var sensor: Sensor? = null
  private var registered = false

  // Cumulative reading at the time the current accumulation window started.
  // Window-end is `lastCumulative` whenever flushIfDue() decides to write.
  private var windowStartCumulative: Float = -1f
  private var windowStartTs: Long = 0L
  private var lastCumulative: Float = -1f
  private var lastReadingTs: Long = 0L
  private var nextFlushDueAt: Long = 0L

  private var appCtx: Context? = null

  fun start(ctx: Context) {
    if (registered) return
    appCtx = ctx.applicationContext
    val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    if (sm == null) {
      Log.w(TAG, "no SENSOR_SERVICE on this device — fallback disabled")
      return
    }
    val s = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
    if (s == null) {
      Log.w(TAG, "TYPE_STEP_COUNTER not present — fallback disabled")
      return
    }
    sensorManager = sm
    sensor = s
    // SENSOR_DELAY_NORMAL is ~200 ms but the step-counter chip batches its
    // callbacks anyway; the rate hint is just a ceiling.
    val ok = sm.registerListener(this, s, SensorManager.SENSOR_DELAY_NORMAL)
    registered = ok
    nextFlushDueAt = System.currentTimeMillis() + FLUSH_INTERVAL_MS
    Log.i(TAG, "register ok=$ok")
  }

  fun stop() {
    val sm = sensorManager ?: return
    if (registered) {
      sm.unregisterListener(this)
      registered = false
      Log.i(TAG, "unregistered")
    }
  }

  /**
   * Called from the FG-service poll loop once a minute. Emits a `steps`
   * event when ≥5 min has passed since the last flush, or never if we
   * haven't had a single sensor callback yet (device hasn't moved).
   */
  fun flushIfDue() {
    val ctx = appCtx ?: return
    if (!registered) return
    val now = System.currentTimeMillis()
    if (now < nextFlushDueAt) return
    if (windowStartCumulative < 0f || lastCumulative < 0f) {
      // Not enough sensor data yet; try again next minute.
      nextFlushDueAt = now + 60_000L
      return
    }
    val delta = (lastCumulative - windowStartCumulative).toInt()
    if (delta > 0) {
      val payload =
        """{"count":$delta,"start_ts":$windowStartTs,""" +
          """"end_ts":$lastReadingTs,"source":"sensor_step_counter"}"""
      EventDb.insert(ctx, "steps", lastReadingTs, payload)
      Log.i(TAG, "flushed delta=$delta window=${windowStartTs}..${lastReadingTs}")
    }
    // Slide the window forward regardless of delta (stationary minutes
    // shouldn't pile up in the next bucket).
    windowStartCumulative = lastCumulative
    windowStartTs = lastReadingTs
    nextFlushDueAt = now + FLUSH_INTERVAL_MS
  }

  override fun onSensorChanged(event: SensorEvent?) {
    val ev = event ?: return
    val cumulative = ev.values.firstOrNull() ?: return
    val now = System.currentTimeMillis()
    if (windowStartCumulative < 0f) {
      windowStartCumulative = cumulative
      windowStartTs = now
    }
    // Reboot guard: kernel resets the counter to 0 on reboot. If we see a
    // value smaller than what we had, write out what we have and start a
    // fresh window from the new reading.
    if (cumulative < lastCumulative) {
      val ctx = appCtx
      val delta = (lastCumulative - windowStartCumulative).toInt()
      if (ctx != null && delta > 0) {
        val payload =
          """{"count":$delta,"start_ts":$windowStartTs,""" +
            """"end_ts":$lastReadingTs,"source":"sensor_step_counter"}"""
        EventDb.insert(ctx, "steps", lastReadingTs, payload)
        Log.i(TAG, "reboot detected, flushed pending delta=$delta")
      }
      windowStartCumulative = cumulative
      windowStartTs = now
    }
    lastCumulative = cumulative
    lastReadingTs = now
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
    // Hardware step counters don't really change accuracy after boot;
    // there's nothing useful to do here.
  }
}

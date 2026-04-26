package com.lifeos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.SleepClassifyEvent
import com.google.android.gms.location.SleepSegmentEvent

/**
 * Receives Sleep API events. The Sleep API delivers two flavours through the
 * same PendingIntent:
 *
 *  - SleepSegmentEvent: confirmed sleep window after the user wakes up. Comes
 *    in once per day, hours after the fact. We write a `sleep` event with
 *    start, end, status, missing-data flag.
 *  - SleepClassifyEvent: ~10 min sliding inferences while you're (probably)
 *    asleep — confidence + light + motion. We write each as a `sleep` event
 *    with kind=classify so the aggregator can build a sleep curve.
 *
 * Sleep API itself does the heavy lifting; we just persist what it tells us.
 */
class SleepReceiver : BroadcastReceiver() {

  override fun onReceive(ctx: Context, intent: Intent) {
    if (SleepSegmentEvent.hasEvents(intent)) {
      val segs = SleepSegmentEvent.extractEvents(intent)
      for (s in segs) {
        val payload =
          """{"kind":"segment","start_ts":${s.startTimeMillis},"end_ts":${s.endTimeMillis},""" +
            """"duration_ms":${s.segmentDurationMillis},"status":${s.status},""" +
            """"source":"sleep_api"}"""
        EventDb.insert(ctx, "sleep", s.endTimeMillis, payload)
        Log.i(TAG, "segment ${s.startTimeMillis}..${s.endTimeMillis} status=${s.status}")
      }
      return
    }
    if (SleepClassifyEvent.hasEvents(intent)) {
      // SleepClassifyEvent fires every ~10 min while you're (probably) asleep
      // with a confidence/motion/light sample. They have no duration and the
      // aggregator never reads them — only `kind="segment"` rows feed sleep
      // rollups. Persisting them just floods the events table.
      // We drop them here. If we later want a sleep-curve, build it from
      // segments (which carry start_ts/end_ts).
      val cls = SleepClassifyEvent.extractEvents(intent)
      Log.i(TAG, "classify n=${cls.size} (dropped — unused)")
    }
  }

  companion object {
    private const val TAG = "LifeOsSleep"
    const val ACTION = "com.lifeos.SLEEP_EVENTS"
  }
}

package com.lifeos

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Stage 3c: lightweight notification observer. Logs only pkg, post time,
 * category, and ongoing/dismissal lifecycle — never title or body text.
 *
 * Flood control (added in v3 / Stage C):
 *   - **Ongoing notifs** (music, calls, navigation, downloads): tracked by
 *     `sbn.key` → row id. We INSERT one event when first seen and UPDATE
 *     that row with `end_ts` + `duration_ms` when it's removed. This turns
 *     hundreds of "still playing" updates into one start/end pair.
 *   - **Transient notifs**: deduped by `(pkg, category)` within
 *     `DEDUP_WINDOW_MS`. Slack typing-indicator spam → one event per
 *     conversation per minute, not per keystroke.
 *
 * In-memory state lives in companion-object maps. Android keeps the listener
 * service alive across the process lifetime, so the maps survive between
 * notification deliveries; on process death we lose at most a handful of
 * "in-flight" ongoing notifs (their start row stays in the DB without an
 * end_ts, which the JS-side cleanup tolerates).
 */
class LifeOsNotificationListener : NotificationListenerService() {

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    val pkg = sbn.packageName ?: return
    if (pkg == packageName) return
    val ts = sbn.postTime
    val cat = sbn.notification?.category ?: ""
    val isOngoing = sbn.isOngoing
    val key = sbn.key ?: "$pkg:${sbn.id}"

    if (isOngoing) {
      synchronized(ongoingRowIds) {
        if (ongoingRowIds.containsKey(key)) return
      }
      val payload =
        """{"pkg":"$pkg","category":"$cat","ongoing":true,"start_ts":$ts,"end_ts":null,"duration_ms":null,"source":"notif_listener"}"""
      val id = EventDb.insertReturningId(applicationContext, "notif", ts, payload)
      if (id > 0) {
        synchronized(ongoingRowIds) {
          ongoingRowIds[key] = OngoingRow(id, ts, pkg, cat)
          while (ongoingRowIds.size > MAX_ONGOING) {
            val oldest = ongoingRowIds.entries.minByOrNull { it.value.startTs } ?: break
            ongoingRowIds.remove(oldest.key)
          }
        }
      }
      return
    }

    val dedupKey = "$pkg|$cat"
    synchronized(lastTransientTs) {
      val prev = lastTransientTs[dedupKey] ?: 0L
      if (ts - prev < DEDUP_WINDOW_MS) return
      lastTransientTs[dedupKey] = ts
      if (lastTransientTs.size > MAX_DEDUP) {
        val oldest = lastTransientTs.entries.minByOrNull { it.value }
        if (oldest != null) lastTransientTs.remove(oldest.key)
      }
    }
    val payload =
      """{"pkg":"$pkg","category":"$cat","ongoing":false,"source":"notif_listener"}"""
    EventDb.insert(applicationContext, "notif", ts, payload)
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    if (sbn == null) return
    val key = sbn.key ?: return
    val row = synchronized(ongoingRowIds) { ongoingRowIds.remove(key) } ?: return
    val endTs = System.currentTimeMillis()
    val durMs = (endTs - row.startTs).coerceAtLeast(0L)
    val payload =
      """{"pkg":"${row.pkg}","category":"${row.cat}","ongoing":true,"start_ts":${row.startTs},"end_ts":$endTs,"duration_ms":$durMs,"source":"notif_listener"}"""
    EventDb.updatePayload(applicationContext, row.id, PhoneState.stamp(payload))
  }

  override fun onListenerConnected() {
    super.onListenerConnected()
    Log.i(TAG, "listener connected")
  }

  override fun onListenerDisconnected() {
    super.onListenerDisconnected()
    Log.i(TAG, "listener disconnected")
  }

  private data class OngoingRow(val id: Long, val startTs: Long, val pkg: String, val cat: String)

  companion object {
    private const val TAG = "LifeOsNotif"
    /** Same (pkg,category) within this window collapses into a single event. */
    private const val DEDUP_WINDOW_MS = 30_000L
    private const val MAX_ONGOING = 64
    private const val MAX_DEDUP = 256

    private val ongoingRowIds = HashMap<String, OngoingRow>()
    private val lastTransientTs = HashMap<String, Long>()
  }
}

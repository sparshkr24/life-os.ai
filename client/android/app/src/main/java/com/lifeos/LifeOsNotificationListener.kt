package com.lifeos

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Stage 3c: lightweight notification observer. We log only the package, post
 * time, and category for each notification — never the title or text body.
 * The point is to learn *which apps interrupt* and *when*, not snoop content.
 *
 * Requires the user to grant access via system Settings → Notification access
 * → Life OS. The bridge exposes `openNotificationListenerSettings()` for that.
 */
class LifeOsNotificationListener : NotificationListenerService() {

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    val pkg = sbn.packageName ?: return
    if (pkg == packageName) return // ignore our own foreground notif
    val ts = sbn.postTime
    val cat = sbn.notification?.category ?: ""
    val isOngoing = sbn.isOngoing
    val payload =
      """{"pkg":"$pkg","category":"$cat","ongoing":$isOngoing,"source":"notif_listener"}"""
    EventDb.insert(applicationContext, "notif", ts, payload)
  }

  override fun onListenerConnected() {
    super.onListenerConnected()
    Log.i(TAG, "listener connected")
  }

  override fun onListenerDisconnected() {
    super.onListenerDisconnected()
    Log.i(TAG, "listener disconnected")
  }

  companion object {
    private const val TAG = "LifeOsNotif"
  }
}

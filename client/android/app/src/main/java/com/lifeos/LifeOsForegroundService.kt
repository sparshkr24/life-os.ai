package com.lifeos

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.SleepSegmentRequest
import java.io.File

class LifeOsForegroundService : Service() {

  private val handler = Handler(Looper.getMainLooper())
  private var lastPollMs: Long = 0L
  private var lastHcPollMs: Long = 0L

  private val pollTask = object : Runnable {
    override fun run() {
      try {
        collectUsage()
      } catch (e: Exception) {
        Log.e(TAG, "poll failed", e)
      }
      // Tick Health Connect at a slower cadence — its records don't update
      // more than every few minutes anyway.
      val now = System.currentTimeMillis()
      if (now - lastHcPollMs >= HC_POLL_INTERVAL_MS) {
        try {
          val newSince = HealthConnectCollector.pollOnce(
            this@LifeOsForegroundService,
            if (lastHcPollMs == 0L) now - HC_POLL_INTERVAL_MS else lastHcPollMs,
          )
          lastHcPollMs = newSince
        } catch (e: Exception) {
          Log.e(TAG, "hc poll failed", e)
        }
      }
      handler.postDelayed(this, POLL_INTERVAL_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "onCreate")

    // Initialise process-wide ambient state listeners FIRST so any event
    // written during the rest of onCreate gets stamped.
    PhoneState.init(this)

    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Life OS background", NotificationManager.IMPORTANCE_LOW)
        .apply { description = "Keeps Life OS running in the background" }
    )
    val notif: Notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Life OS")
      .setContentText("Tracking activity")
      .setSmallIcon(android.R.drawable.ic_menu_info_details)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()

    // Android 14+: must pass foregroundServiceType to startForeground()
    // or the system kills the service with SecurityException.
    try {
      ServiceCompat.startForeground(
        this,
        NOTIF_ID,
        notif,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        else 0
      )
      Log.i(TAG, "startForeground ok")
    } catch (e: Exception) {
      Log.e(TAG, "startForeground failed", e)
      stopSelf()
      return
    }

    // First poll covers the last 5 minutes — captures what we missed while
    // the service was down (app relaunch, OEM kill, reboot grace period).
    lastPollMs = System.currentTimeMillis() - STARTUP_LOOKBACK_MS
    handler.post(pollTask)

    // Stage 3b registrations. Both noop silently if the user hasn't granted
    // ACTIVITY_RECOGNITION yet — they get retried on every service restart.
    registerActivityTransitions()
    registerSleepUpdates()

    // Stage 8: schedule the daily 03:05 nightly kicker. Idempotent.
    NightlyAlarmReceiver.schedule(this)
  }

  private fun hasActivityRecognitionPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
    return ContextCompat.checkSelfPermission(
      this,
      "android.permission.ACTIVITY_RECOGNITION",
    ) == PackageManager.PERMISSION_GRANTED
  }

  private fun registerActivityTransitions() {
    if (!hasActivityRecognitionPermission()) {
      Log.w(TAG, "skip activity transitions — permission not granted")
      return
    }
    val types = listOf(
      DetectedActivity.IN_VEHICLE,
      DetectedActivity.ON_BICYCLE,
      DetectedActivity.ON_FOOT,
      DetectedActivity.RUNNING,
      DetectedActivity.STILL,
      DetectedActivity.WALKING,
    )
    val transitions = mutableListOf<ActivityTransition>()
    for (t in types) {
      transitions.add(
        ActivityTransition.Builder()
          .setActivityType(t)
          .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
          .build()
      )
      transitions.add(
        ActivityTransition.Builder()
          .setActivityType(t)
          .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
          .build()
      )
    }
    val req = ActivityTransitionRequest(transitions)
    val intent = Intent(this, ActivityTransitionReceiver::class.java).apply {
      action = ActivityTransitionReceiver.ACTION
    }
    val pi = PendingIntent.getBroadcast(
      this, 0, intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
    )
    try {
      ActivityRecognition.getClient(this).requestActivityTransitionUpdates(req, pi)
        .addOnSuccessListener { Log.i(TAG, "activity transitions registered") }
        .addOnFailureListener { e -> Log.e(TAG, "activity transitions failed: ${e.message}") }
    } catch (e: SecurityException) {
      Log.e(TAG, "activity transitions security: ${e.message}")
    }
  }

  private fun registerSleepUpdates() {
    if (!hasActivityRecognitionPermission()) {
      Log.w(TAG, "skip sleep updates — permission not granted")
      return
    }
    val intent = Intent(this, SleepReceiver::class.java).apply {
      action = SleepReceiver.ACTION
    }
    val pi = PendingIntent.getBroadcast(
      this, 0, intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
    )
    try {
      ActivityRecognition.getClient(this)
        .requestSleepSegmentUpdates(pi, SleepSegmentRequest.getDefaultSleepSegmentRequest())
        .addOnSuccessListener { Log.i(TAG, "sleep updates registered") }
        .addOnFailureListener { e -> Log.e(TAG, "sleep updates failed: ${e.message}") }
    } catch (e: SecurityException) {
      Log.e(TAG, "sleep updates security: ${e.message}")
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.i(TAG, "onStartCommand")
    return START_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(pollTask)
    Log.i(TAG, "onDestroy")
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun collectUsage() {
    val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    val now = System.currentTimeMillis()
    val since = lastPollMs
    val events = usm.queryEvents(since, now)
    lastPollMs = now

    val db = openLifeOsDb()
    if (db == null) {
      Log.e(TAG, "poll: db open failed (lifeos.db missing or locked) — skipping")
      return
    }

    val ev = UsageEvents.Event()
    var totalSeen = 0
    var inserted = 0
    var closed = 0
    var skipped = 0

    try {
      while (events.hasNextEvent()) {
        events.getNextEvent(ev)
        totalSeen++
        val type = ev.eventType
        // ACTIVITY_RESUMED (1) == MOVE_TO_FOREGROUND (deprecated alias).
        // ACTIVITY_PAUSED  (2) == MOVE_TO_BACKGROUND (deprecated alias).
        // We accept the numeric codes so deprecation warnings don't bite.
        val isFg = type == 1
        val isBg = type == 2
        if (!isFg && !isBg) continue

        val pkg = ev.packageName ?: continue
        val ts = ev.timeStamp
        // Skip our own foreground events — noise.
        if (pkg == packageName) continue
        // Skip system shells (launchers, intent resolver, permission UI,
        // screenshot capture, etc). They're not "apps the user used", they
        // pop up during transitions and would dominate the events table.
        if (isNoisePkg(pkg)) {
          skipped++
          continue
        }

        try {
          if (isFg) {
            // Dedup at insert time: if the last app_fg row for this pkg has
            // its end_ts within DEDUP_GAP_MS of `ts`, just extend that row's
            // end_ts to `ts`. This collapses the rapid-fire RESUMED/PAUSED
            // bursts Android emits as the user moves between an app's
            // activities/fragments (WhatsApp scrolling, opening a chat, etc).
            // Falls through to a plain INSERT only when there's no recent
            // row to extend.
            if (!extendRecentSession(db, pkg, ts)) {
              db.execSQL(
                "INSERT INTO events (ts, kind, payload) VALUES (?, 'app_fg', ?)",
                arrayOf<Any>(ts, PhoneState.stamp(buildPayload(pkg, ts, ts)))
              )
              inserted++
            } else {
              closed++ // reuse counter — "extended" sessions
            }
          } else {
            // BG: find the most recent unclosed session for this pkg and close it.
            // "Unclosed" means start_ts == end_ts in payload. We scan only the
            // last 50 rows for this pkg — bounded.
            if (closeOpenSession(db, pkg, ts)) closed++
          }
        } catch (e: Exception) {
          skipped++
          Log.e(TAG, "row write failed pkg=$pkg type=$type: ${e.message}")
        }
      }
    } finally {
      try { db.close() } catch (e: Exception) { Log.w(TAG, "db close: ${e.message}") }
    }

    Log.i(TAG, "poll: range=${since}..${now} seen=$totalSeen inserted=$inserted closed=$closed skipped=$skipped")
  }

  /**
   * If the most recent `app_fg` row for `pkg` has an end_ts within
   * DEDUP_GAP_MS of `newTs`, extend that row's end_ts to `newTs` and return
   * true. Otherwise return false (caller should INSERT a fresh row).
   */
  private fun extendRecentSession(db: SQLiteDatabase, pkg: String, newTs: Long): Boolean {
    val like = "%\"pkg\":\"$pkg\"%"
    db.rawQuery(
      "SELECT id, payload FROM events WHERE kind='app_fg' AND payload LIKE ? ORDER BY id DESC LIMIT 1",
      arrayOf(like)
    ).use { c ->
      if (!c.moveToFirst()) return false
      val id = c.getLong(0)
      val payload = c.getString(1) ?: return false
      val startTs = extractLong(payload, "start_ts") ?: return false
      val curEnd = extractLong(payload, "end_ts") ?: startTs
      // Gap between the previous session's last-known timestamp and the new
      // RESUMED. If small, treat this as a continuation.
      if (newTs - curEnd > DEDUP_GAP_MS) return false
      // Don't go backwards.
      if (newTs <= curEnd) return true // already covered, no-op success
      // Re-stamp ambient `_ctx` so the row reflects current phone state.
      // Without this, every dedup-extended app_fg row loses _ctx entirely.
      db.execSQL(
        "UPDATE events SET payload = ? WHERE id = ?",
        arrayOf<Any>(PhoneState.stamp(buildPayload(pkg, startTs, newTs)), id)
      )
      return true
    }
  }

  /**
   * Finds the newest open `app_fg` row for `pkg` (start_ts == end_ts in payload)
   * and stamps its `end_ts` to `endTs`. Returns true if a row was updated.
   */
  private fun closeOpenSession(db: SQLiteDatabase, pkg: String, endTs: Long): Boolean {
    val like = "%\"pkg\":\"$pkg\"%"
    db.rawQuery(
      "SELECT id, payload FROM events WHERE kind='app_fg' AND payload LIKE ? ORDER BY id DESC LIMIT 1",
      arrayOf(like)
    ).use { c ->
      if (!c.moveToFirst()) return false
      val id = c.getLong(0)
      val payload = c.getString(1) ?: return false
      val startTs = extractLong(payload, "start_ts") ?: return false
      val curEnd = extractLong(payload, "end_ts") ?: startTs
      // Only close if this row hasn't already been closed AND the BG event
      // is later than the FG. Otherwise the BG event probably belongs to a
      // session we never saw start (e.g. service restart) — ignore.
      if (curEnd > startTs) return false
      if (endTs <= startTs) return false
      db.execSQL(
        "UPDATE events SET payload = ? WHERE id = ?",
        arrayOf<Any>(PhoneState.stamp(buildPayload(pkg, startTs, endTs)), id)
      )
      return true
    }
  }

  private fun extractLong(json: String, key: String): Long? {
    // Minimal int extractor — avoids pulling in org.json.
    val needle = "\"$key\":"
    val i = json.indexOf(needle)
    if (i < 0) return null
    var j = i + needle.length
    while (j < json.length && json[j] == ' ') j++
    val start = j
    while (j < json.length && (json[j].isDigit() || json[j] == '-')) j++
    if (start == j) return null
    return json.substring(start, j).toLongOrNull()
  }

  private fun buildPayload(pkg: String, startTs: Long, endTs: Long): String {
    val durMs = (endTs - startTs).coerceAtLeast(0)
    return """{"pkg":"$pkg","start_ts":$startTs,"end_ts":$endTs,"duration_ms":$durMs,"source":"usage_stats"}"""
  }

  /**
   * System shells we never want to log. They appear during transitions
   * (back-stack flush, share sheet, permission prompt, screenshot) and
   * are not "apps the user used". Add to NOISE_PKGS as new ones appear
   * in real-device data.
   */
  private fun isNoisePkg(pkg: String): Boolean {
    if (NOISE_PKGS.contains(pkg)) return true
    for (prefix in NOISE_PREFIXES) if (pkg.startsWith(prefix)) return true
    return false
  }

  private fun openLifeOsDb(): SQLiteDatabase? {
    val f = File(filesDir, "SQLite/lifeos.db")
    if (!f.exists()) {
      Log.w(TAG, "lifeos.db missing at ${f.absolutePath} — open the app once so JS migrates")
      return null
    }
    return try {
      val db = SQLiteDatabase.openDatabase(f.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
      // Rollback journal (SQLite default), NOT WAL. JS opens the same file
      // with `PRAGMA journal_mode=DELETE`. Sharing WAL between two SQLite
      // builds (expo-sqlite + Android's bundled lib) corrupted the file via
      // `-shm` format mismatch. Rollback journal has no shared memory format.
      // Wait up to 5 s if JS holds the lock instead of throwing SQLITE_BUSY.
      try {
        db.rawQuery("PRAGMA busy_timeout = 5000", null).use { it.moveToFirst() }
      } catch (e: Exception) {
        Log.w(TAG, "set busy_timeout failed (non-fatal): ${e.message}")
      }
      db
    } catch (e: Exception) {
      Log.e(TAG, "openDatabase failed", e)
      null
    }
  }

  companion object {
    private const val TAG = "LifeOsService"
    private const val CHANNEL_ID = "lifeos_bg"
    private const val NOTIF_ID = 1
    private const val POLL_INTERVAL_MS = 60_000L
    // First poll after service start covers this much past time so we capture
    // events that happened while the service was down (reinstall, OEM kill,
    // boot grace). 5 minutes is short enough to avoid duplicating data we
    // already have, long enough to not miss a session in progress.
    private const val STARTUP_LOOKBACK_MS = 5 * 60_000L
    // Health Connect data updates slowly; polling every 5 minutes is plenty.
    private const val HC_POLL_INTERVAL_MS = 5 * 60_000L
    // If a new RESUMED for the same pkg arrives within this window of the
    // previous session's last-known end_ts, treat it as a continuation and
    // extend the existing row instead of inserting a new one. 90 s comfortably
    // covers Android's RESUMED/PAUSED storms (sub-activity nav, share sheet
    // round-trips) without merging genuinely separate sessions.
    private const val DEDUP_GAP_MS = 90_000L

    /**
     * Exact-match denylist for system pkgs we don't want to log. Real apps
     * the user installed will never match these.
     */
    private val NOISE_PKGS = setOf(
      "android",                 // the OS itself — surfaces during transitions
      "com.android.systemui",
      "com.android.settings",
      "com.android.intentresolver",
      "com.android.sharesheet",
      "com.android.permissioncontroller",
      "com.google.android.permissioncontroller",
      "com.google.android.packageinstaller",
      "com.android.packageinstaller",
      // Common launchers — pop up between every app switch.
      "com.android.launcher",
      "com.android.launcher3",
      "com.google.android.apps.nexuslauncher",
      "com.miui.home",
      "com.sec.android.app.launcher",
      "com.oneplus.launcher",
      "com.oppo.launcher",
      "com.realme.launcher",
      "com.huawei.android.launcher",
      // Screenshot / smart-shot capture activities.
      "com.miui.screenshot",
      "com.android.smartshot",
      "com.miui.smartshot",
      // OS overlays.
      "com.google.android.googlequicksearchbox", // assistant overlay
    )

    /** Prefix-based denylist — catches OEM variants we haven't enumerated. */
    private val NOISE_PREFIXES = listOf(
      "com.android.inputmethod.",
      "com.google.android.inputmethod.",
      "com.miui.securitycenter",
    )
  }
}

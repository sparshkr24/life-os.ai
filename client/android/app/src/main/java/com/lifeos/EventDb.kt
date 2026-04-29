package com.lifeos

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import java.io.File

/**
 * Tiny shared helper. Every native collector (UsageStats, ActivityRecognition,
 * Sleep API, Geofence, NotificationListener, Health Connect) writes through
 * here so we have one INSERT path and one log line.
 *
 * We open a fresh connection per write — the JS app holds its own long-lived
 * expo-sqlite connection and we don't want to share state with it. WAL is
 * enabled to match the JS connection so neither side blocks the other.
 *
 * Cheap on this device (~1 ms / open). Don't loop this — batch up to a few
 * inserts per call site if you have lots.
 */
object EventDb {
  private const val TAG = "LifeOsEventDb"

  fun insert(ctx: Context, kind: String, ts: Long, payloadJson: String) {
    insertReturningId(ctx, kind, ts, payloadJson)
  }

  /**
   * Same as [insert] but returns the inserted row id, or -1 on failure.
   * Used by callers that need to UPDATE the row later (e.g. ongoing-notif
   * tracker stamping `end_ts` when the notification is dismissed).
   */
  fun insertReturningId(ctx: Context, kind: String, ts: Long, payloadJson: String): Long {
    val db = open(ctx) ?: return -1L
    val stamped = PhoneState.stamp(payloadJson)
    return try {
      val cv = android.content.ContentValues().apply {
        put("ts", ts)
        put("kind", kind)
        put("payload", stamped)
      }
      db.insert("events", null, cv)
    } catch (e: Exception) {
      Log.e(TAG, "insert kind=$kind failed: ${e.message}")
      -1L
    } finally {
      try { db.close() } catch (_: Exception) { /* ignore */ }
    }
  }

  /**
   * Replace the payload of an existing event. Used by the notification
   * listener to stamp `end_ts` + `duration_ms` onto an ongoing-notif row
   * once it's dismissed, instead of inserting a second event.
   */
  fun updatePayload(ctx: Context, id: Long, payloadJson: String) {
    if (id <= 0) return
    val db = open(ctx) ?: return
    try {
      db.execSQL(
        "UPDATE events SET payload = ? WHERE id = ?",
        arrayOf<Any>(payloadJson, id)
      )
    } catch (e: Exception) {
      Log.e(TAG, "updatePayload id=$id failed: ${e.message}")
    } finally {
      try { db.close() } catch (_: Exception) { /* ignore */ }
    }
  }

  private fun open(ctx: Context): SQLiteDatabase? {
    val f = File(ctx.filesDir, "SQLite/lifeos.db")
    if (!f.exists()) {
      Log.w(TAG, "lifeos.db missing — open the app once so JS migrates")
      return null
    }
    return try {
      val db = SQLiteDatabase.openDatabase(
        f.absolutePath, null, SQLiteDatabase.OPEN_READWRITE
      )
      // Rollback journal (default), NOT WAL — see LifeOsForegroundService.openLifeOsDb.
      try {
        db.rawQuery("PRAGMA busy_timeout = 5000", null).use { it.moveToFirst() }
      } catch (_: Exception) { /* non-fatal */ }
      db
    } catch (e: Exception) {
      Log.e(TAG, "open failed: ${e.message}")
      null
    }
  }
}

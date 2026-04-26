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
    val db = open(ctx) ?: return
    try {
      db.execSQL(
        "INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)",
        arrayOf<Any>(ts, kind, payloadJson)
      )
    } catch (e: Exception) {
      Log.e(TAG, "insert kind=$kind failed: ${e.message}")
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
      try { db.enableWriteAheadLogging() } catch (_: Exception) { /* non-fatal */ }
      db
    } catch (e: Exception) {
      Log.e(TAG, "open failed: ${e.message}")
      null
    }
  }
}

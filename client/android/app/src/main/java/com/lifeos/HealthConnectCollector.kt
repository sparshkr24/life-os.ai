package com.lifeos

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.runBlocking
import java.time.Instant

/**
 * Stage 3d: Health Connect reader. Pulled from `LifeOsForegroundService` at
 * most every 5 minutes (configurable) to fetch the rolling window since the
 * last successful poll.
 *
 * Writes:
 *   - one `steps` event per StepsRecord segment (count, start_ts, end_ts)
 *   - one `heart_rate` event per HeartRateRecord sample window
 *
 * If Health Connect SDK is not available (older Android, no Health Connect
 * app installed) or permissions are missing, the collector silently noops —
 * the bridge surfaces availability separately.
 */
object HealthConnectCollector {
  private const val TAG = "LifeOsHC"

  fun isAvailable(ctx: Context): Boolean {
    return try {
      val status = HealthConnectClient.getSdkStatus(ctx)
      status == HealthConnectClient.SDK_AVAILABLE
    } catch (e: Throwable) {
      Log.w(TAG, "isAvailable threw: ${e.message}")
      false
    }
  }

  /** Reads from `sinceMs` to now. Returns the new `sinceMs` to persist. */
  fun pollOnce(ctx: Context, sinceMs: Long): Long {
    if (!isAvailable(ctx)) return sinceMs
    val client = try {
      HealthConnectClient.getOrCreate(ctx)
    } catch (e: Throwable) {
      Log.w(TAG, "getOrCreate failed: ${e.message}")
      return sinceMs
    }

    val now = System.currentTimeMillis()
    val filter = TimeRangeFilter.between(
      Instant.ofEpochMilli(sinceMs),
      Instant.ofEpochMilli(now)
    )

    return try {
      runBlocking {
        ensurePermissionsOrSkip(client)?.let { return@runBlocking sinceMs }
        readSteps(ctx, client, filter)
        readHeartRate(ctx, client, filter)
        Log.i(TAG, "poll ok range=${sinceMs}..${now}")
        now
      }
    } catch (e: Throwable) {
      Log.e(TAG, "poll failed: ${e.message}")
      sinceMs
    }
  }

  private suspend fun ensurePermissionsOrSkip(client: HealthConnectClient): String? {
    val want = setOf(
      HealthPermission.getReadPermission(StepsRecord::class),
      HealthPermission.getReadPermission(HeartRateRecord::class),
    )
    val have = client.permissionController.getGrantedPermissions()
    val missing = want - have
    return if (missing.isEmpty()) null else "missing: $missing"
  }

  private suspend fun readSteps(
    ctx: Context,
    client: HealthConnectClient,
    filter: TimeRangeFilter,
  ) {
    val req = ReadRecordsRequest(StepsRecord::class, filter)
    val resp = client.readRecords(req)
    for (r in resp.records) {
      val payload =
        """{"count":${r.count},"start_ts":${r.startTime.toEpochMilli()},""" +
          """"end_ts":${r.endTime.toEpochMilli()},"source":"health_connect"}"""
      EventDb.insert(ctx, "steps", r.endTime.toEpochMilli(), payload)
    }
  }

  private suspend fun readHeartRate(
    ctx: Context,
    client: HealthConnectClient,
    filter: TimeRangeFilter,
  ) {
    val req = ReadRecordsRequest(HeartRateRecord::class, filter)
    val resp = client.readRecords(req)
    for (r in resp.records) {
      // Each record can carry many samples; we condense to min/max/avg.
      val samples = r.samples
      if (samples.isEmpty()) continue
      val bpms = samples.map { it.beatsPerMinute }
      val payload =
        """{"min":${bpms.min()},"max":${bpms.max()},""" +
          """"avg":${bpms.average()},"n":${samples.size},""" +
          """"start_ts":${r.startTime.toEpochMilli()},""" +
          """"end_ts":${r.endTime.toEpochMilli()},"source":"health_connect"}"""
      EventDb.insert(ctx, "heart_rate", r.endTime.toEpochMilli(), payload)
    }
  }
}

package com.lifeos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.BatteryManager
import android.util.Log

/**
 * Process-wide ambient state stamped onto every event payload.
 *
 * Why: raw events tell us *what* happened; the LLM needs *context* to learn
 * patterns ("doom-scrolling on cellular at 0% battery while charging").
 * Without stamping at insert time, that context is unrecoverable later.
 *
 * Hard rule: NO fresh GPS / location / sensor calls happen here. We only
 * mirror state that the OS already pushes to us via passive listeners:
 *   - place_id   → set/cleared by `GeofenceReceiver` on enter/exit.
 *   - battery    → ACTION_BATTERY_CHANGED sticky broadcast.
 *   - network    → `ConnectivityManager.NetworkCallback`.
 *   - audio      → AudioManager polled at stamp time (cheap, no I/O).
 *
 * Listeners are registered once from `LifeOsForegroundService.onCreate`.
 * Volatile fields → safe to read from any thread without locking; we write
 * them on the main looper from the broadcast / network callbacks.
 *
 * `stamp(payloadJson)` is a string-level merge: it inserts a `_ctx` object
 * before the payload's closing `}`. Idempotent — if `_ctx` is already
 * present we return the input unchanged. JSON is built by hand (no org.json
 * dependency, no allocations beyond a single StringBuilder) because every
 * event flows through this path.
 */
object PhoneState {
  private const val TAG = "LifeOsPhoneState"

  @Volatile var placeId: String? = null
  @Volatile private var batteryPct: Int = -1
  @Volatile private var isCharging: Boolean = false
  /** "wifi" | "cell" | "none" | "unknown" */
  @Volatile private var networkType: String = "unknown"

  @Volatile private var initialized: Boolean = false
  private var batteryReceiver: BroadcastReceiver? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var audioManager: AudioManager? = null

  fun init(ctx: Context) {
    if (initialized) return
    val app = ctx.applicationContext
    initialized = true
    audioManager = app.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    registerBattery(app)
    registerNetwork(app)
    Log.i(TAG, "initialized")
  }

  /**
   * Merge ambient ctx into the given payload JSON. Returns a new string
   * with `,"_ctx":{...}` inserted before the closing `}`. Caller owns
   * `payloadJson` shape — must end with `}` and be valid JSON.
   */
  fun stamp(payloadJson: String): String {
    if (payloadJson.isEmpty() || payloadJson.last() != '}') return payloadJson
    if (payloadJson.contains("\"_ctx\":")) return payloadJson
    val ctx = buildCtxJson()
    val core = payloadJson.substring(0, payloadJson.length - 1)
    val sep = if (core.isEmpty() || core.last() == '{') "" else ","
    return "$core$sep\"_ctx\":$ctx}"
  }

  private fun buildCtxJson(): String {
    val sb = StringBuilder(96)
    sb.append('{')
    var first = true
    fun comma() { if (!first) sb.append(',') ; first = false }
    placeId?.let { comma() ; sb.append("\"place_id\":\"").append(escape(it)).append('"') }
    if (batteryPct >= 0) {
      comma() ; sb.append("\"batt\":").append(batteryPct)
      comma() ; sb.append("\"charging\":").append(isCharging)
    }
    if (networkType != "unknown") {
      comma() ; sb.append("\"net\":\"").append(networkType).append('"')
    }
    val audio = audioRouteNow()
    if (audio != "unknown") {
      comma() ; sb.append("\"audio\":\"").append(audio).append('"')
    }
    sb.append('}')
    return sb.toString()
  }

  /**
   * Polled at stamp time rather than tracked via callback — AudioDeviceCallback
   * needs API 23+ and an extra threading dance for what amounts to a single
   * `AudioManager` field read. Cheap.
   */
  private fun audioRouteNow(): String {
    val am = audioManager ?: return "unknown"
    return try {
      val devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS) ?: return "unknown"
      // Priority: bluetooth > wired > speaker. Earpiece intentionally folded
      // into "speaker" — we don't need to distinguish in-call audio routes.
      var hasBt = false
      var hasWired = false
      for (d in devices) {
        when (d.type) {
          AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
          AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
          AudioDeviceInfo.TYPE_BLE_HEADSET,
          AudioDeviceInfo.TYPE_BLE_SPEAKER -> hasBt = true
          AudioDeviceInfo.TYPE_WIRED_HEADSET,
          AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
          AudioDeviceInfo.TYPE_USB_HEADSET -> hasWired = true
        }
      }
      when {
        hasBt -> "bt"
        hasWired -> "wired"
        else -> "speaker"
      }
    } catch (e: Exception) {
      "unknown"
    }
  }

  private fun registerBattery(app: Context) {
    if (batteryReceiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context, i: Intent) {
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level >= 0 && scale > 0) {
          batteryPct = (level * 100) / scale
        }
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
          status == BatteryManager.BATTERY_STATUS_FULL
      }
    }
    try {
      // Sticky broadcast — receiver fires once immediately with current state.
      app.registerReceiver(r, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      batteryReceiver = r
    } catch (e: Exception) {
      Log.e(TAG, "battery register failed: ${e.message}")
    }
  }

  private fun registerNetwork(app: Context) {
    if (networkCallback != null) return
    val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(net: Network, caps: NetworkCapabilities) {
        networkType = when {
          caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
          caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cell"
          caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wifi"
          else -> "other"
        }
      }
      override fun onLost(net: Network) {
        networkType = "none"
      }
    }
    try {
      val req = NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .build()
      cm.registerNetworkCallback(req, cb)
      networkCallback = cb
    } catch (e: Exception) {
      Log.e(TAG, "network register failed: ${e.message}")
    }
  }

  private fun escape(s: String): String =
    s.replace("\\", "\\\\").replace("\"", "\\\"")
}

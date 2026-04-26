/**
 * Local notifications. Three channels = three "levels":
 *   1 silent   — quiet log, low importance, no sound, no heads-up
 *   2 heads-up — default importance, sound + banner
 *   3 modal    — high importance, alarm-like, vibration + sticky
 *
 * On Android the user-visible "loudness" is owned by the channel, NOT by the
 * notification. We create one channel per level at startup; later sends just
 * pick the channel.
 *
 * Permissions: POST_NOTIFICATIONS is requested once on first send. We don't
 * gate the rest of the app on it — refusal just means the row still lands
 * in `nudges_log`.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type NudgeLevel = 1 | 2 | 3;

const CHANNEL: Record<NudgeLevel, string> = {
  1: 'lifeos.silent',
  2: 'lifeos.headsup',
  3: 'lifeos.modal',
};

let initialized = false;

export async function ensureNotificationChannels(): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL[1], {
      name: 'Life OS — silent',
      importance: Notifications.AndroidImportance.LOW,
      sound: undefined,
      vibrationPattern: undefined,
      enableVibrate: false,
      showBadge: false,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL[2], {
      name: 'Life OS — heads-up',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 200, 100, 200],
      showBadge: true,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL[3], {
      name: 'Life OS — modal',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 400, 200, 400, 200, 400],
      showBadge: true,
      bypassDnd: false,
    });
    console.log('[notify] channels ready');
  } catch (e) {
    console.error('[notify] channel setup failed:', e instanceof Error ? e.message : String(e));
  }
}

async function ensurePermission(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  const r = await Notifications.requestPermissionsAsync();
  return r.granted;
}

export async function fireNudgeNotification(opts: {
  level: NudgeLevel;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<string | null> {
  await ensureNotificationChannels();
  const ok = await ensurePermission();
  if (!ok) {
    console.warn('[notify] permission denied — nudge not surfaced');
    return null;
  }
  try {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: opts.title,
        body: opts.body,
        data: opts.data ?? {},
        sound: opts.level === 1 ? undefined : 'default',
        priority:
          opts.level === 3
            ? Notifications.AndroidNotificationPriority.MAX
            : opts.level === 2
              ? Notifications.AndroidNotificationPriority.HIGH
              : Notifications.AndroidNotificationPriority.LOW,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 1,
        channelId: CHANNEL[opts.level],
      },
    });
    return id;
  } catch (e) {
    console.error('[notify] schedule failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

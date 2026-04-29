/**
 * Interactive notifications for proactive AI questions (v7).
 *
 * Each question type maps to a notification *category* with action buttons:
 *   yes_no      → [Yes] [No]                — both stay in tray, no app open.
 *   place_name  → [Other] [No]              — "Other" opens the app to the
 *                                              pending-question card so the
 *                                              user can type a place name.
 *   free_text   → [Open]                    — opens the app card.
 *
 * Categories are registered exactly once on first call. The *action ids* on
 * a tap come back via `Notifications.addNotificationResponseReceivedListener`
 * in App.tsx.
 *
 * The pending question id is stamped into `data.questionId` so the response
 * handler can look up the row without re-querying notification content.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { ProactiveExpectedKind } from '../db/schema';

const CHANNEL_HEADSUP = 'lifeos.headsup';

export const PROACTIVE_CATEGORY = {
  yes_no: 'lifeos.proactive.yesno',
  place_name: 'lifeos.proactive.place',
  free_text: 'lifeos.proactive.freetext',
} as const;

export const PROACTIVE_ACTION = {
  yes: 'lifeos.proactive.yes',
  no: 'lifeos.proactive.no',
  other: 'lifeos.proactive.other',
  open: 'lifeos.proactive.open',
} as const;

let categoriesReady = false;

async function ensureCategories(): Promise<void> {
  if (categoriesReady) return;
  categoriesReady = true;
  try {
    await Notifications.setNotificationCategoryAsync(PROACTIVE_CATEGORY.yes_no, [
      {
        identifier: PROACTIVE_ACTION.yes,
        buttonTitle: 'Yes',
        options: { opensAppToForeground: false },
      },
      {
        identifier: PROACTIVE_ACTION.no,
        buttonTitle: 'No',
        options: { opensAppToForeground: false },
      },
    ]);
    await Notifications.setNotificationCategoryAsync(PROACTIVE_CATEGORY.place_name, [
      {
        identifier: PROACTIVE_ACTION.other,
        buttonTitle: 'Yes (name it)',
        options: { opensAppToForeground: true },
      },
      {
        identifier: PROACTIVE_ACTION.no,
        buttonTitle: 'No',
        options: { opensAppToForeground: false },
      },
    ]);
    await Notifications.setNotificationCategoryAsync(PROACTIVE_CATEGORY.free_text, [
      {
        identifier: PROACTIVE_ACTION.open,
        buttonTitle: 'Reply',
        options: { opensAppToForeground: true },
      },
    ]);
    console.log('[proactiveNotify] categories ready');
  } catch (e) {
    console.error(
      '[proactiveNotify] category setup failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

export async function fireProactiveQuestionNotification(opts: {
  id: string;
  prompt: string;
  options: string[];
  expectedKind: ProactiveExpectedKind;
}): Promise<string | null> {
  await ensureCategories();
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.canAskAgain) {
    await Notifications.requestPermissionsAsync();
  }
  const fresh = await Notifications.getPermissionsAsync();
  if (!fresh.granted) {
    console.warn('[proactiveNotify] notif permission denied — question still in DB');
    return null;
  }

  const category = PROACTIVE_CATEGORY[opts.expectedKind];
  try {
    const notifId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Life OS',
        body: opts.prompt,
        data: { questionId: opts.id, expectedKind: opts.expectedKind },
        sound: 'default',
        categoryIdentifier: category,
        priority: Notifications.AndroidNotificationPriority.HIGH,
        sticky: true,
      },
      trigger:
        Platform.OS === 'android'
          ? {
              type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
              seconds: 1,
              channelId: CHANNEL_HEADSUP,
            }
          : null,
    });
    return notifId;
  } catch (e) {
    console.error(
      '[proactiveNotify] schedule failed:',
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

export async function dismissProactiveNotification(notifId: string | null): Promise<void> {
  if (!notifId) return;
  try {
    await Notifications.dismissNotificationAsync(notifId);
  } catch {
    /* best-effort */
  }
}

/**
 * Proactive notification response handler (v7).
 *
 * Translates an Expo `NotificationResponse` into one of three answers and
 * delegates to `applyProactiveAnswer`:
 *
 *   action = lifeos.proactive.yes    → answer text "Yes",  fromInAppCard=false
 *   action = lifeos.proactive.no     → answer text "No",   fromInAppCard=false
 *   action = lifeos.proactive.other  → leave question pending; user will
 *                                      type a reply in the in-app card.
 *   action = lifeos.proactive.open   → same as `other` for free-text Qs.
 *   action = (default tap on body)   → leave pending, app will open.
 *
 * The notification id we stamped on creation comes back in
 * `response.notification.request.identifier`. We look up the row by
 * `notification_id` so the data payload is just a hint.
 */
import type * as Notifications from 'expo-notifications';
import { withDb } from '../db';
import { applyProactiveAnswer } from './proactive';
import { dismissProactiveNotification, PROACTIVE_ACTION } from '../rules/proactiveNotify';
import { deviceTz } from '../aggregator/time';
import type { ProactiveQuestionRow } from '../db/schema';

export async function handleProactiveNotificationResponse(
  response: Notifications.NotificationResponse,
): Promise<void> {
  const action = response.actionIdentifier;
  const notifId = response.notification.request.identifier;
  const dataQid =
    (response.notification.request.content.data?.questionId as string | undefined) ?? null;

  // Resolve the question row by notification_id (preferred — survives even
  // if the data payload was lost) or by the explicit data hint.
  const row = await withDb(async (db) => {
    if (notifId) {
      const r = await db.getFirstAsync<ProactiveQuestionRow>(
        `SELECT * FROM proactive_questions WHERE notification_id = ? LIMIT 1`,
        [notifId],
      );
      if (r) return r;
    }
    if (dataQid) {
      return db.getFirstAsync<ProactiveQuestionRow>(
        `SELECT * FROM proactive_questions WHERE id = ? LIMIT 1`,
        [dataQid],
      );
    }
    return null;
  });
  if (!row) {
    console.warn('[proactiveResponse] no question row for notif', notifId);
    return;
  }
  if (row.status !== 'pending') {
    await dismissProactiveNotification(notifId);
    return;
  }

  // Yes/No actions resolve immediately — record + dismiss notification.
  if (action === PROACTIVE_ACTION.yes || action === PROACTIVE_ACTION.no) {
    const tz = deviceTz();
    await withDb(async (db) =>
      applyProactiveAnswer(
        db,
        {
          questionId: row.id,
          text: action === PROACTIVE_ACTION.yes ? 'Yes' : 'No',
          fromInAppCard: false,
        },
        tz,
      ),
    );
    await dismissProactiveNotification(notifId);
    return;
  }

  // Other / Open / default tap: question stays pending. The app foregrounds
  // (because the action declared `opensAppToForeground:true`) and the
  // pending-question card will render the row for the user to answer.
  console.log(`[proactiveResponse] handing off to in-app card id=${row.id}`);
}

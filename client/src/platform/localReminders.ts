import { Capacitor } from '@capacitor/core';
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications';
import { t, type TranslationKey } from '../i18n';
import { showToastMessage } from '../net/log';
import type { IStorage } from './IPlatform';

// Local, on-device reminders for retention-relevant "you have something waiting" moments
// (GACHA_DESIGN.md §5.2/§9.3, META_TASKS G10). Two kinds, both iOS-only — there is no single "push"
// mechanism that covers Web + WeChat + iOS, so this deliberately isn't part of IPlatform:
//  - Subscription expiry: one-shot notifications scheduled for specific future timestamps
//    (T-3-days "expiring soon" / T-0 "expired"). No server involved — armed client-side the moment
//    we know the expiry timestamp (buy / claim / bootstrap / lobby entry).
//  - Daily claimables: a single *recurring* notification (Capacitor's cron-style `schedule.on`, so
//    the OS keeps firing it once a day without the app needing to run daily) summarizing whichever
//    of {monthly-card claim, daily check-in, daily-task reward} is outstanding as of the last time
//    the app was opened — re-armed on every lobby entry, same as the expiry reminder. There is no
//    server-triggered push to refresh its text while the app stays closed for multiple days; that's
//    an accepted limitation of a purely local (no push-server) design, same as the OTA/expiry
//    reminders (see backlog-audit-2026-07-21 memory).
// Web / CrazyGames / WeChat have no background execution to hang either of these off. Expiry falls
// back to a one-per-day in-app toast (below); daily-claimables already has an equivalent in-app
// signal — the red-dot badges in LobbyScene/badges.ts — so no extra toast is added for it there.

const LEAD_MS = 3 * 24 * 60 * 60 * 1000; // remind starting 3 days before expiry
const EXPIRED_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // stop nagging 3 days after lapse
const NOTIF_ID_SOON = 9001;
const NOTIF_ID_EXPIRED = 9002;
const NOTIF_ID_DAILY = 9003;
const DAILY_REMINDER_HOUR = 12;
const DAILY_REMINDER_MINUTE = 30;
const LAST_SHOWN_KEY = 'nw_sub_reminder_day';

/**
 * (Re)schedule the iOS local notifications for a subscription's expiry. Idempotent — always clears
 * any previously-scheduled reminder first, so calling this again after a renewal (new expiry) or a
 * claim (unchanged expiry) never double-fires or leaves a stale one behind. Explicitly gated to the
 * native shell — unlike ota.ts's Capgo plugin, @capacitor/local-notifications ships a *web*
 * implementation that talks to the real browser Notification API (would pop a real permission
 * prompt on desktop Chrome/Firefox), so a bare try/catch would not reliably no-op here; WeChat's
 * environment has no `Notification` global and would fail closed anyway, but iOS is the only
 * platform this is meant to run on, so check for it up front rather than relying on that.
 */
export async function scheduleSubscriptionReminder(expiryMs: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID_SOON }, { id: NOTIF_ID_EXPIRED }] });
    if (!expiryMs) return;
    const now = Date.now();
    const notifications: LocalNotificationSchema[] = [];
    const soonAt = expiryMs - LEAD_MS;
    if (soonAt > now) {
      notifications.push({
        id: NOTIF_ID_SOON,
        title: t('shop.reminderSoonTitle'),
        body: t('shop.reminderSoonBody'),
        schedule: { at: new Date(soonAt) },
      });
    }
    if (expiryMs > now) {
      notifications.push({
        id: NOTIF_ID_EXPIRED,
        title: t('shop.reminderExpiredTitle'),
        body: t('shop.reminderExpiredBody'),
        schedule: { at: new Date(expiryMs) },
      });
    }
    if (!notifications.length) return;
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return;
    }
    await LocalNotifications.schedule({ notifications });
  } catch {
    // Permission denied, or the native plugin itself failed — nothing more to do here;
    // checkInAppSubscriptionReminder is the fallback everywhere else.
  }
}

/**
 * In-app fallback for platforms with no scheduled-notification channel (Web / CrazyGames / WeChat).
 * Call on every real lobby entry; shows at most one toast per calendar day, and only while the card
 * is within the reminder window (soon-to-expire or recently lapsed — a long-expired card stops
 * nagging so it doesn't turn into a permanent banner). Skipped entirely on the iOS native shell,
 * which already got the real push via scheduleSubscriptionReminder.
 */
export function checkInAppSubscriptionReminder(storage: IStorage, expiryMs: number): void {
  if (Capacitor.isNativePlatform()) return;
  if (!expiryMs) return;
  const now = Date.now();
  let key: 'shop.reminderSoonBody' | 'shop.reminderExpiredBody' | null = null;
  if (now >= expiryMs - LEAD_MS && now < expiryMs) key = 'shop.reminderSoonBody';
  else if (now >= expiryMs && now < expiryMs + EXPIRED_GRACE_MS) key = 'shop.reminderExpiredBody';
  if (!key) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  if (storage.getItem(LAST_SHOWN_KEY) === todayKey) return;
  storage.setItem(LAST_SHOWN_KEY, todayKey);
  showToastMessage(t(key), 'success');
}

/** What's currently outstanding today, in the order they should be listed if more than one applies. */
export type DailyReminderReason = 'monthlyCard' | 'dailyTask' | 'checkin';

const REASON_KEY: Record<DailyReminderReason, TranslationKey> = {
  monthlyCard: 'shop.reminderDailyMonthlyCard',
  dailyTask: 'shop.reminderDailyTask',
  checkin: 'shop.reminderDailyCheckin',
};

/**
 * (Re)arm the recurring "today's rewards are waiting" iOS local notification — fires every day at
 * a fixed wall-clock time (12:30 local) via Capacitor's cron-style `schedule.on`, independent of
 * whether the app runs that day. `reasons` is a snapshot of what's outstanding *right now*, computed
 * by the caller from SaveData (kept out of this module so it has no SaveData/retention dependency);
 * passing an empty array cancels the reminder entirely rather than nagging about nothing. Multiple
 * reasons are bundled into one message ("你有待领取奖励：月卡奖励、每日签到") rather than picking
 * just one, so a player with several pending things sees all of them at a glance. Same native-only
 * gate and idempotent cancel-then-reschedule pattern as scheduleSubscriptionReminder.
 */
export async function scheduleDailyReminder(reasons: DailyReminderReason[]): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID_DAILY }] });
    if (!reasons.length) return;
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return;
    }
    const items = reasons.map((r) => t(REASON_KEY[r])).join(t('shop.reminderDailySeparator'));
    await LocalNotifications.schedule({
      notifications: [{
        id: NOTIF_ID_DAILY,
        title: t('shop.reminderDailyTitle'),
        body: t('shop.reminderDailyBody', { items }),
        schedule: { on: { hour: DAILY_REMINDER_HOUR, minute: DAILY_REMINDER_MINUTE }, allowWhileIdle: true },
      }],
    });
  } catch {
    // Permission denied, or the native plugin itself failed — nothing more to do here.
  }
}

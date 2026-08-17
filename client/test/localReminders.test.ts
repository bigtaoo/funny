// Unit tests for localReminders.ts (GACHA_DESIGN §5.2/§9.3, G10): the one-shot subscription-expiry
// notifications, their in-app toast fallback (Web/CrazyGames/WeChat), and the recurring
// daily-claimables notification's reason-bundling logic. Both native-notification paths need the
// real Capacitor runtime to fully exercise `LocalNotifications.schedule`, so that call is mocked
// here — these tests cover the window/throttle math and what gets passed to it, not the native
// plugin itself.
//
// The two native paths are also the ones webpack replaces with no-op stubs on every non-mobile
// target (ASSET_PACKAGING §4.0) — which is exactly why they are worth asserting here: after that
// swap the only place their scheduling math runs outside an iOS device is this file.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IStorage } from '../src/platform/IPlatform';

const DAY = 24 * 60 * 60 * 1000;

function memStorage(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

const showToastMessage = vi.fn();
vi.mock('../src/net/log', () => ({ showToastMessage: (...args: unknown[]) => showToastMessage(...args) }));
// isNativePlatform() is stubbed per-test; default false (Web) unless a test overrides it.
const isNativePlatform = vi.fn(() => false);
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => isNativePlatform() } }));

const cancel = vi.fn().mockResolvedValue(undefined);
const checkPermissions = vi.fn().mockResolvedValue({ display: 'granted' });
const requestPermissions = vi.fn().mockResolvedValue({ display: 'granted' });
const schedule = vi.fn().mockResolvedValue({ notifications: [] });
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    cancel: (...args: unknown[]) => cancel(...args),
    checkPermissions: (...args: unknown[]) => checkPermissions(...args),
    requestPermissions: (...args: unknown[]) => requestPermissions(...args),
    schedule: (...args: unknown[]) => schedule(...args),
  },
}));

const {
  checkInAppSubscriptionReminder, scheduleDailyReminder, scheduleSubscriptionReminder,
} = await import('../src/platform/localReminders');

const NOTIF_ID_SOON = 9001;
const NOTIF_ID_EXPIRED = 9002;

/** ids passed to the last `schedule()` call, in order. */
function scheduledIds(): number[] {
  return (schedule.mock.calls[0][0] as { notifications: { id: number }[] }).notifications.map((n) => n.id);
}

describe('scheduleSubscriptionReminder', () => {
  beforeEach(() => {
    isNativePlatform.mockReturnValue(true);
    cancel.mockClear();
    checkPermissions.mockClear().mockResolvedValue({ display: 'granted' });
    requestPermissions.mockClear().mockResolvedValue({ display: 'granted' });
    schedule.mockClear();
  });

  it('no-ops entirely on a non-native platform (the in-app toast covers it there)', async () => {
    isNativePlatform.mockReturnValue(false);
    await scheduleSubscriptionReminder(Date.now() + 10 * DAY);
    expect(cancel).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('cancels both prior reminders before every reschedule, so a renewal cannot double-fire', async () => {
    await scheduleSubscriptionReminder(Date.now() + 10 * DAY);
    await scheduleSubscriptionReminder(Date.now() + 40 * DAY);
    expect(cancel).toHaveBeenCalledTimes(2);
    for (const call of cancel.mock.calls) {
      expect(call[0]).toEqual({ notifications: [{ id: NOTIF_ID_SOON }, { id: NOTIF_ID_EXPIRED }] });
    }
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('no subscription (expiry 0) → clears any leftover reminder and schedules nothing', async () => {
    await scheduleSubscriptionReminder(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('expiry well in the future → both the T-3d "soon" and the T-0 "expired" notification', async () => {
    const expiry = Date.now() + 10 * DAY;
    await scheduleSubscriptionReminder(expiry);
    expect(scheduledIds()).toEqual([NOTIF_ID_SOON, NOTIF_ID_EXPIRED]);
    const [soon, expired] = (schedule.mock.calls[0][0] as {
      notifications: { schedule: { at: Date } }[];
    }).notifications;
    // The lead notification lands exactly 3 days before expiry, not 3 days from now.
    expect(soon.schedule.at.getTime()).toBe(expiry - 3 * DAY);
    expect(expired.schedule.at.getTime()).toBe(expiry);
  });

  it('already inside the 3-day window → only the expiry notification (the lead time is gone)', async () => {
    // Buying/claiming a card that expires in 1 day must not arm a notification for yesterday.
    await scheduleSubscriptionReminder(Date.now() + 1 * DAY);
    expect(scheduledIds()).toEqual([NOTIF_ID_EXPIRED]);
  });

  it('expiry already past → cancel only, and no permission prompt for an empty schedule', async () => {
    await scheduleSubscriptionReminder(Date.now() - 1 * DAY);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    // Bailing before the permission check matters: a lapsed card must not pop an OS prompt.
    expect(checkPermissions).not.toHaveBeenCalled();
  });

  it('declined permission → does not schedule', async () => {
    checkPermissions.mockResolvedValue({ display: 'denied' });
    requestPermissions.mockResolvedValue({ display: 'denied' });
    await scheduleSubscriptionReminder(Date.now() + 10 * DAY);
    expect(requestPermissions).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('permission not yet asked but then granted → schedules', async () => {
    checkPermissions.mockResolvedValue({ display: 'prompt' });
    await scheduleSubscriptionReminder(Date.now() + 10 * DAY);
    expect(requestPermissions).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('a throwing plugin (the non-mobile stub, or a real native failure) never propagates', async () => {
    // localReminders wraps its plugin calls precisely so a rejection degrades to a no-op; the stubs
    // shipped on non-mobile targets throw by design, so this is their contract too.
    schedule.mockRejectedValueOnce(new Error('stubbed out on non-mobile builds'));
    await expect(scheduleSubscriptionReminder(Date.now() + 10 * DAY)).resolves.toBeUndefined();
  });
});

describe('checkInAppSubscriptionReminder', () => {
  beforeEach(() => {
    showToastMessage.mockClear();
    isNativePlatform.mockReturnValue(false);
  });

  it('no subscription ever (expiry 0) → no toast', () => {
    checkInAppSubscriptionReminder(memStorage(), 0);
    expect(showToastMessage).not.toHaveBeenCalled();
  });

  it('far from expiry (> 3 days out) → no toast', () => {
    checkInAppSubscriptionReminder(memStorage(), Date.now() + 10 * DAY);
    expect(showToastMessage).not.toHaveBeenCalled();
  });

  it('within the 3-day lead window, still active → "expiring soon" toast', () => {
    checkInAppSubscriptionReminder(memStorage(), Date.now() + 1 * DAY);
    expect(showToastMessage).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('just past expiry, within the grace window → "expired" toast', () => {
    checkInAppSubscriptionReminder(memStorage(), Date.now() - 1 * DAY);
    expect(showToastMessage).toHaveBeenCalledTimes(1);
  });

  it('long past expiry (beyond grace) → stops nagging', () => {
    checkInAppSubscriptionReminder(memStorage(), Date.now() - 10 * DAY);
    expect(showToastMessage).not.toHaveBeenCalled();
  });

  it('only shows once per calendar day even if called repeatedly', () => {
    const storage = memStorage();
    checkInAppSubscriptionReminder(storage, Date.now() + 1 * DAY);
    checkInAppSubscriptionReminder(storage, Date.now() + 1 * DAY);
    checkInAppSubscriptionReminder(storage, Date.now() + 1 * DAY);
    expect(showToastMessage).toHaveBeenCalledTimes(1);
  });

  it('skipped entirely on the iOS native shell (real push covers it instead)', () => {
    isNativePlatform.mockReturnValue(true);
    checkInAppSubscriptionReminder(memStorage(), Date.now() + 1 * DAY);
    expect(showToastMessage).not.toHaveBeenCalled();
  });
});

describe('scheduleDailyReminder', () => {
  beforeEach(() => {
    isNativePlatform.mockReturnValue(true);
    cancel.mockClear();
    checkPermissions.mockClear().mockResolvedValue({ display: 'granted' });
    requestPermissions.mockClear();
    schedule.mockClear();
  });

  it('no-ops entirely on a non-native platform (Web/WeChat rely on the existing red dots instead)', async () => {
    isNativePlatform.mockReturnValue(false);
    await scheduleDailyReminder(['monthlyCard']);
    expect(cancel).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('no outstanding reasons → cancels any prior reminder and schedules nothing new', async () => {
    await scheduleDailyReminder([]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('a single reason → schedules one recurring notification at 12:30 local', async () => {
    await scheduleDailyReminder(['checkin']);
    expect(schedule).toHaveBeenCalledTimes(1);
    const call = schedule.mock.calls[0][0];
    expect(call.notifications).toHaveLength(1);
    expect(call.notifications[0].schedule.on).toEqual({ hour: 12, minute: 30 });
    expect(call.notifications[0].body).toContain('每日签到');
  });

  it('multiple reasons → bundled into one message covering all of them', async () => {
    await scheduleDailyReminder(['monthlyCard', 'dailyTask', 'checkin']);
    const body = schedule.mock.calls[0][0].notifications[0].body as string;
    expect(body).toContain('月卡奖励');
    expect(body).toContain('每日任务奖励');
    expect(body).toContain('每日签到');
  });

  it('declined permission → does not schedule', async () => {
    checkPermissions.mockResolvedValue({ display: 'denied' });
    requestPermissions.mockResolvedValue({ display: 'denied' });
    await scheduleDailyReminder(['checkin']);
    expect(schedule).not.toHaveBeenCalled();
  });
});

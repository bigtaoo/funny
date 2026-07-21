// Unit tests for localReminders.ts (GACHA_DESIGN §5.2/§9.3, G10): the subscription-expiry in-app
// toast fallback (Web/CrazyGames/WeChat) and the recurring daily-claimables local notification's
// reason-bundling logic. Both native-notification paths need the real Capacitor runtime to fully
// exercise `LocalNotifications.schedule`, so that call is mocked here — these tests cover the
// window/throttle math and what gets passed to it, not the native plugin itself.
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

const { checkInAppSubscriptionReminder, scheduleDailyReminder } = await import('../src/platform/localReminders');

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

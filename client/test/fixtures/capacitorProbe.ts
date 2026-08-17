import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
export const probe = { isNative: Capacitor.isNativePlatform, schedule: LocalNotifications.schedule };

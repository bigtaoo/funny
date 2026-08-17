import type { LocalNotificationsPlugin } from '@capacitor/local-notifications';

// Build-time stand-in for @capacitor/local-notifications on every non-mobile target
// (web / crazygames / wechat), swapped in by the NormalModuleReplacementPlugin in
// webpack.config.js — see the comment there for why, and ASSET_PACKAGING §4.0.
//
// Nothing here ever runs: platform/localReminders.ts is the only consumer and each of its
// plugin call sites sits behind `Capacitor.isNativePlatform()`, which is false by construction
// in a bundle that got this stub instead of the real plugin. The point is purely to keep the
// real module — its web implementation (~3.5 KB minified, talking to the browser Notification
// API) plus the `web: () => import('./web')` split point that implies — out of the graph.
//
// Methods throw rather than resolve so that if a future call site ever does reach one, it fails
// loudly in the log instead of silently pretending a notification was scheduled. Both public
// functions in localReminders.ts already wrap their plugin calls in try/catch (permission denial
// is an expected outcome there), so the throw degrades to the same no-op as a denied permission.

const MESSAGE = '@capacitor/local-notifications is stubbed out on non-mobile builds';

function unavailable(): never {
  throw new Error(MESSAGE);
}

/**
 * The subset of the plugin surface localReminders.ts uses. Typed via `Pick` against the real
 * package (types are erased, so importing them costs no bytes) so an upstream rename breaks the
 * build here; test/localNotificationsStub.test.ts covers the other direction — localReminders.ts
 * growing a call to a method this stub doesn't have.
 */
export const LocalNotifications: Pick<
  LocalNotificationsPlugin,
  'cancel' | 'checkPermissions' | 'requestPermissions' | 'schedule'
> = {
  cancel: unavailable,
  checkPermissions: unavailable,
  requestPermissions: unavailable,
  schedule: unavailable,
};

// "Am I running inside the Capacitor native shell?" — answered by Capacitor's own runtime rather
// than by any bridge our shell code injects.
//
// Why this is separate from `platform/iap.ts`'s `getNativeBilling()`, which answers a very similar
// question: `window.NWBilling` is injected by `NWBridgeViewController` (ios/App/App/AppDelegate.swift),
// which is only reached because `Main.storyboard` names it as the root view controller's customClass.
// That wiring is one `cap sync` / Capacitor major bump away from being regenerated, and if it ever
// is, the bridge silently disappears while the app itself still boots and plays fine. Every
// "is a bridge present?" check would then answer "plain browser" *inside the App Store build*.
//
// For payment routing that answer is worse than no answer: it makes the shipped iOS app open the
// web Paddle checkout inside its WKWebView, which App Review guideline 3.1.1 prohibits outright,
// and declare itself as platform `web`, spending from the wrong recharged-pool bucket (ADR-020).
// Capacitor reports the platform without any of our own wiring having to be correct, so payment
// decisions gate on this, and only the *choice of store* gates on the bridge.
//
// Every non-mobile target gets the `platform/stubs/capacitorCore.ts` stand-in via webpack's
// NormalModuleReplacementPlugin (see webpack.config.js), whose `getPlatform()` is the constant
// 'web' — so this module costs those bundles nothing and always answers `null` there.
import { Capacitor } from '@capacitor/core';

/** The native shell this bundle is running inside, if any. */
export type NativeShell = 'ios' | 'android';

/** 'ios' / 'android' when running inside the Capacitor shell; null in any browser (incl. WeChat/CrazyGames). */
export function nativeShell(): NativeShell | null {
  try {
    const platform = Capacitor.getPlatform();
    if (platform === 'ios') return 'ios';
    if (platform === 'android') return 'android';
    return null;
  } catch {
    // Defensive: a future Capacitor could throw off-device. "Not native" is the safe answer —
    // it never turns a browser session into a store session, only the other way around, and the
    // other way around is the one that is guarded (see iapKind / requestPlatformHeader).
    return null;
  }
}

/** True inside the iOS/Android shell — where the web payment channel must never be reachable. */
export function isNativeShell(): boolean {
  return nativeShell() !== null;
}

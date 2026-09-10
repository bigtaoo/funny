import type { CapacitorConfig } from '@capacitor/cli';

// Native shell config (COMMERCIAL_DESIGN §IAP client / IOS_RELEASE.md).
// The same web bundle produced by `webpack --env TARGET=mobile` (output → dist/) is
// packaged inside a WKWebView; the native StoreKit bridge is injected as window.NWBilling
// by AppDelegate.swift, which the platform layer detects at runtime (iapKind → 'apple').
const config: CapacitorConfig = {
  appId: 'com.gamestao.nivara',
  appName: 'Nivara',
  webDir: 'dist',
  server: {
    // iOS serves the bundle from capacitor://localhost; https here only affects the Android scheme.
    androidScheme: 'https',
  },
  ios: {
    // 'never', deliberately — and this is the whole 2026-09-10 iPhone-13 portrait fix.
    //
    // 'always' asks WKWebView's own scrollView to inset the page by the safe area. On a notched
    // phone that does two things at once: it shrinks the LAYOUT VIEWPORT (`window.innerHeight`
    // 844 -> 763 on an iPhone 13) and it reports `env(safe-area-inset-*)` as 0, because from the
    // page's point of view there is no longer anything to avoid. But this app does its own inset:
    // `public/mobile/index.html` sets `viewport-fit=cover` and `ScalingManager` offsets the whole
    // `gameLayer` by what it reads from `env()` (design/game/UI_DESIGN.md, safe-area row). Two
    // mechanisms for one job, and under 'always' the second one is fed zeroes and does nothing.
    //
    // Worse, the native one does not finish the job here: `html, body { overflow: hidden }` makes
    // that scrollView unscrollable, so its initial `contentOffset(-47)` is clamped back to 0 and
    // the canvas still paints from physical y=0 — top HUD under the status bar — while the viewport
    // it was sized for is 81pt shorter, leaving that 81pt as a dead band at the bottom. Exactly the
    // reported symptom, and not reachable by any JS-side fix; see layout/viewportGeometry.ts's
    // header for the arithmetic that ruled out both "insets read correctly" and "insets read 0".
    //
    // With 'never' the page keeps the full 844pt viewport and `env()` reports the real 47/34, so
    // the existing gameLayer offset is in sole charge of the safe area, on every screen at once.
    //
    // NATIVE CONFIG — NOT OTA-SHIPPABLE: this is compiled into the shell. It needs `npx cap sync
    // ios` on a Mac plus a new binary (IOS_RELEASE.md §5 / §12.1); an OTA bundle changes nothing.
    contentInset: 'never',
    // Opaque background — no white flash between launch screen and first canvas paint.
    backgroundColor: '#f5f0e8',
  },
  plugins: {
    // OTA hot-update (IOS_RELEASE.md §11). Manual / self-hosted: the update is driven from
    // src/platform/ota.ts (fetch our own manifest → download → arm next()), so Capgo's own
    // autoUpdate loop stays off. resetWhenUpdate drops any staged OTA bundle when the native
    // shell itself is upgraded through the App Store, so the fresh binary starts clean.
    // autoDeletePrevious/autoDeleteFailed are already the plugin's own defaults (v6, both `true`
    // — confirmed against node_modules/@capgo/capacitor-updater's definitions.d.ts/README, not
    // the plugin's example config block which misleadingly shows `false` as sample values) and
    // were previously left unset here; pinned explicitly so a future @capgo major bump can't
    // silently flip local device storage back to unbounded OTA-bundle accumulation.
    CapacitorUpdater: {
      autoUpdate: false,
      resetWhenUpdate: true,
      autoDeletePrevious: true,
      autoDeleteFailed: true,
    },
  },
};

export default config;

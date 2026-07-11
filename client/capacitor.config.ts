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
    // Respect the safe area (notch / home indicator) so the canvas is not clipped.
    contentInset: 'always',
    // Opaque background — no white flash between launch screen and first canvas paint.
    backgroundColor: '#f5f0e8',
  },
  plugins: {
    // OTA hot-update (IOS_RELEASE.md §11). Manual / self-hosted: the update is driven from
    // src/platform/ota.ts (fetch our own manifest → download → arm next()), so Capgo's own
    // autoUpdate loop stays off. resetWhenUpdate drops any staged OTA bundle when the native
    // shell itself is upgraded through the App Store, so the fresh binary starts clean.
    CapacitorUpdater: {
      autoUpdate: false,
      resetWhenUpdate: true,
    },
  },
};

export default config;

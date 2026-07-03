import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';

// Native (Capacitor iOS/Android) entry. The same WebPlatform runs inside the WKWebView:
// it detects the native StoreKit bridge injected on `window.NWBilling` by the shell
// (AppDelegate.swift) and routes coin recharges to Apple IAP (iapKind → 'apple').
//
// Unlike the web entry, there is no /version.json foreground-reload poll: a native bundle is
// shipped fixed inside the app package and updated only through the App Store, so reloading the
// WKWebView from a remote origin would be both wrong (no same-origin backend) and jarring.
startApp(new WebPlatform('game-canvas')).catch(console.error);

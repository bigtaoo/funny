import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';
import { checkOtaUpdate } from '../platform/ota';

// Native (Capacitor iOS/Android) entry. The same WebPlatform runs inside the WKWebView:
// it detects the native StoreKit bridge injected on `window.NWBilling` by the shell
// (AppDelegate.swift) and routes coin recharges to Apple IAP (iapKind → 'apple').
//
// Unlike the web entry, there is no /version.json foreground-reload poll (WKWebView can't reload
// the whole page from a remote origin). JS/asset updates instead arrive via OTA hot-update
// (Capgo, IOS_RELEASE.md §11): checkOtaUpdate() confirms this bundle booted, then downloads any
// newer bundle in the background and arms it for the next cold start — decoupled from App Store
// binary updates, which remain the only channel for native changes.
startApp(new WebPlatform('game-canvas')).catch(console.error);

// Fire-and-forget: never blocks or interrupts the running game (see ota.ts).
void checkOtaUpdate();

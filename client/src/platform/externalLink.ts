// Open a page outside the game: a new browser tab on the web, the system browser (Safari) in the
// native shell.
//
// Why the native shell does not use `window.open` like everyone else: on iOS it only works when
// WebKit counts the call as user-initiated, because only then does WKWebView ask Capacitor's
// `createWebViewWith` for a new window (which hands the URL to `UIApplication.open`). Our taps are
// PIXI `pointertap` / hit-table callbacks fired from `pointerup`, which WebKit on iOS does not treat
// as a popup-granting gesture, so the call is swallowed and the link does nothing — on a real
// iPhone, build 13, the Terms link on the EULA gate and login page (2026-09-30). Every browser we
// test in (desktop Chrome, device emulation) grants it, so nothing but a device shows the bug.
//
// A top-level navigation has no gesture requirement. Capacitor's `decidePolicyFor` (Capacitor 6,
// WebViewDelegationHandler.swift) sees a main-frame navigation to a URL that is neither the app's
// own `capacitor://localhost` nor in `server.allowNavigation` (we set none), calls
// `UIApplication.shared.open(url)` and CANCELS the navigation — so Safari opens and the game page
// stays exactly where it was. Adding the page's host to `allowNavigation` would break this: the
// WKWebView would then navigate the game itself away, with no way back.
import { isNativeShell } from './nativeShell';

export function openExternalUrl(url: string): void {
  if (typeof window === 'undefined') return;
  if (isNativeShell()) {
    window.location.href = url; // dom-ok: guarded above; WeChat never draws these links
    return;
  }
  window.open(url, '_blank', 'noopener'); // dom-ok: guarded above; WeChat never draws these links
}

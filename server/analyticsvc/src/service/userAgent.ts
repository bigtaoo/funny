// analyticsvc's hand-rolled User-Agent parser: the coarse browser / device-type / host-app buckets
// the ops dashboard is built on, derived SERVER-side at ingest so a client-supplied browser name is
// never trusted.
//
// Split out of ./defs.ts (2026-09-20, claudedocs/server.md 拆分形态① — an independent module that
// nothing in defs.ts calls) when that file passed the 500-line gate. `defs.ts` re-exports it, so
// every existing `from './defs'` import keeps resolving.

// ─── Lightweight UA parsing (A9-9) ────────────────────────────────────────────
// Intentionally hand-rolled (no ua-parser-js dependency) — analyticsvc is a plain node:http service with
// no framework, and we only need coarse browser-name/device-type buckets for the ops dashboard, not exact
// version parsing.
export function parseUserAgent(ua: string | undefined): {
  browser: string;
  device_type: 'mobile' | 'tablet' | 'desktop';
  webview?: string;
} {
  const s = ua ?? '';
  let browser = 'unknown';
  if (/MicroMessenger/i.test(s)) browser = 'wechat';
  else if (/QQBrowser/i.test(s)) browser = 'qqbrowser';
  else if (/Edg\//i.test(s)) browser = 'edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'opera';
  else if (/Firefox\//i.test(s)) browser = 'firefox';
  else if (/CriOS|Chrome\//i.test(s)) browser = 'chrome';
  else if (/Safari\//i.test(s)) browser = 'safari';

  // Kept as its own axis rather than folded into `browser`, for two reasons: `browser` values already
  // feed the ops distribution chart and renaming them would silently rewrite history, and the answer
  // is genuinely not a browser name — a GSA WebView really *is* WebKit, so `browser=safari` is
  // incomplete rather than wrong. What it hides is the host app, and the host app is what matters:
  // in-app WebViews run under far tighter memory ceilings than the standalone browser and get killed
  // by the OS instead of surfacing an error. Before this field, every one of them was indistinguishable
  // from ordinary Safari/Chrome traffic — which is how a crash-loop report from a Google-app WebView
  // (2026-08-22, see FEATURE_FLAGS_DESIGN §8) could not be attributed to its environment class at all.
  const webview = detectWebView(s);

  // Mirrors client/src/net/anomaly/deviceContext.ts's classify(). The two are deliberately kept in
  // step: `device_type` here and `device` on the anomaly channel answer the same question about the
  // same session, and a disagreement between them would be worse than either being slightly coarse.
  // Both traps below fail in the direction that HIDES a non-phone, which is the direction that misleads.
  let device_type: 'mobile' | 'tablet' | 'desktop' = 'desktop';
  if (/iPad/i.test(s)) device_type = 'tablet';
  // Android tablets omit the `Mobile` token that Android phones carry. The previous rule tested
  // `Mobi|Android` together, so every Android tablet was counted as a phone.
  else if (/Android/i.test(s)) device_type = /Mobi/i.test(s) ? 'mobile' : 'tablet';
  else if (/Tablet|PlayBook|Silk/i.test(s)) device_type = 'tablet';
  else if (/Mobi|iPhone|iPod/i.test(s)) device_type = 'mobile';

  return webview ? { browser, device_type, webview } : { browser, device_type };
}

/**
 * Name the host app when the page is running inside an embedded WebView rather than a real browser.
 * Undefined for ordinary browser traffic.
 *
 * Order matters: several of these apps stack their token onto an otherwise normal Safari/Chrome UA,
 * and a few carry more than one (Instagram's in-app browser reports both `Instagram` and `FBAV`),
 * so the more specific product is tested first.
 */
function detectWebView(s: string): string | undefined {
  if (/MicroMessenger/i.test(s)) return 'wechat';
  if (/Instagram/i.test(s)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(s)) return 'facebook';
  if (/\bGSA\//i.test(s)) return 'gsa';           // the Google app on iOS
  if (/\bLine\//i.test(s)) return 'line';
  if (/musical_ly|BytedanceWebview|TikTok/i.test(s)) return 'tiktok';
  if (/Snapchat/i.test(s)) return 'snapchat';
  if (/\bTwitter\b/i.test(s)) return 'twitter';
  // Generic Android System WebView: Chrome's UA with a `; wv` marker in the platform section.
  if (/;\s*wv\)/i.test(s)) return 'android-wv';
  return undefined;
}


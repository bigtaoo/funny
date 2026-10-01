// SettingsScene's Privacy policy / Terms links (Apple 5.1.1(i), store-assets-checklist §1.5).
//
// App Review checks that the privacy policy is reachable from inside the app. Before these rows the
// only in-app pair lived in ConsentDialog, which is shown once on first launch and is unreachable
// afterwards — on a device that had already consented there was no policy anywhere in the UI.
//
// Since the flow-layout rewrite (UI_DESIGN_LOG_2026-09 §65) they are two whole-row links in the Help
// card. Worth asserting, and none of it visible in one screenshot:
//  * they are REACHABLE on every shape — on a short portrait phone the Help card is below the fold,
//    and a row off-screen has no hit rect until it is scrolled to;
//  * where they POINT — the native shell needs the absolute https form (a `capacitor://` URL is
//    silently dropped by iOS, IOS_RELEASE.md §10.3);
//  * WeChat does not draw them — the runtime has no `window.open`, so a link there would be dead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initI18n, t, setLocale, type Locale } from '../../src/i18n';
import { buildSettings, collectTexts, rowHit, reveal } from '../harness/settingsScene';

// Faked at the `@capacitor/core` boundary rather than at nativeShell(), so nativeShell's own
// translation of a platform string into "is this a store build" is part of what runs here.
const cap = { platform: 'web' as string };
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => cap.platform,
    isNativePlatform: () => cap.platform !== 'web',
  },
}));

initI18n('en');

/**
 * Runs `fn` with a stub `window` in place — this suite's environment is headless node, where the
 * real code's `typeof window !== 'undefined'` guard would make every link a silent no-op and the
 * assertions below would be asserting on nothing. Installed around the tap only.
 */
function withWindow(fn: () => void): Array<unknown[]> {
  const calls: Array<unknown[]> = [];
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  // `location.href` is how the native shell opens Safari (platform/externalLink.ts); recorded as a
  // one-element call so both routes land in the same list.
  const location = { set href(url: string) { calls.push([url]); } };
  g.window = { open: (...args: unknown[]) => { calls.push(args); return null; }, location };
  try { fn(); } finally { if (had) g.window = prev; else delete g.window; }
  return calls;
}

const target = globalThis as { TARGET?: string };

beforeEach(() => { cap.platform = 'web'; });
afterEach(() => { setLocale('en'); delete target.TARGET; vi.restoreAllMocks(); });

describe('SettingsScene — legal links', () => {
  it.each<Locale>(['zh', 'en', 'de'])('renders both links in %s', (locale) => {
    setLocale(locale);
    const texts = collectTexts(buildSettings(800, 1280).container).map((n) => n.text);
    expect(texts).toContain(t('consent.privacyPolicy'));
    expect(texts).toContain(t('consent.terms'));
  });

  it.each([[800, 1280], [1280, 800], [1024, 640], [412, 915], [360, 640]])(
    'can be scrolled to and tapped, and stays inside the design rect (%ix%i)',
    (w, h) => {
      for (const locale of ['zh', 'en', 'de'] as const) {
        setLocale(locale);
        const s = buildSettings(w, h);
        for (const key of ['consent.privacyPolicy', 'consent.terms'] as const) {
          const node = reveal(s, t(key));
          expect(node.right, `${locale}: "${node.text}" runs off the right edge`).toBeLessThanOrEqual(s.w);
          const hit = rowHit(s, t(key));
          expect(hit.rect.x + hit.rect.w, `${locale}: the tap target runs off the design rect`).toBeLessThanOrEqual(s.w);
        }
      }
    },
  );

  it('keeps a tap on each link on that link', () => {
    const s = buildSettings(1280, 800);
    const calls = withWindow(() => {
      rowHit(s, t('consent.privacyPolicy')).fn();
      rowHit(s, t('consent.terms')).fn();
    });
    expect(calls).toEqual([
      ['/privacy.html', '_blank', 'noopener'],
      ['/terms.html', '_blank', 'noopener'],
    ]);
  });

  it('opens the absolute https pages in Safari from the native shell, not through window.open', () => {
    cap.platform = 'ios';
    const s = buildSettings(412, 915);
    const calls = withWindow(() => {
      rowHit(s, t('consent.privacyPolicy')).fn();
      rowHit(s, t('consent.terms')).fn();
    });
    expect(calls).toEqual([
      ['https://nivara.gamestao.com/privacy'],
      ['https://nivara.gamestao.com/terms'],
    ]);
  });

  it('is not drawn on WeChat, where nothing could open it', () => {
    target.TARGET = 'wechat';
    const texts = collectTexts(buildSettings(412, 915).container).map((n) => n.text);
    expect(texts).not.toContain(t('consent.privacyPolicy'));
    expect(texts).not.toContain(t('consent.terms'));
    // The rest of Help survives: the section is only dropped when it would be empty.
    expect(texts).toContain(t('settings.replayTutorial'));
  });
});

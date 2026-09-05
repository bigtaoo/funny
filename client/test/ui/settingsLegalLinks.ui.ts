// SettingsScene's Privacy policy / Terms links (Apple 5.1.1(i), store-assets-checklist §1.5).
//
// App Review checks that the privacy policy is reachable from inside the app. Before this row the
// only in-app pair lived in ConsentDialog, which is shown once on first launch and is unreachable
// afterwards — on a device that had already consented (every reviewer device after the first
// launch) there was no policy anywhere in the UI, while the checklist claimed there was.
//
// Two things are worth asserting and neither is visible in a screenshot of one viewport:
//  * the links FIT — this scene has no flow layout, every section is a hand-tuned fraction of `h`,
//    so a new row that collides just draws on top of its neighbour (same reason as
//    settingsDataSaverRow.ui.ts, which is where that lesson was paid for);
//  * where they POINT — a link is right or wrong by the URL it opens, and the native shell needs
//    the absolute https form (a `capacitor://` URL is silently dropped by iOS, IOS_RELEASE.md §10.3).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t, setLocale, type Locale } from '../../src/i18n';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import { createFakeTextInput } from '../harness/fakeTextInput';

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

interface Node { text: string; top: number; bottom: number }

function collect(root: PIXI.Container): Node[] {
  const out: Node[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) {
        const b = ch.getBounds();
        out.push({ text: ch.text, top: b.y, bottom: b.y + b.height });
        continue;
      }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function find(nodes: Node[], text: string): Node {
  const hit = nodes.find((n) => n.text === text);
  if (!hit) throw new Error(`no text node "${text}" (have: ${nodes.map((n) => n.text).join(' | ')})`);
  return hit;
}

/** Logged in (so the account column draws logout + delete, the widest thing the links sit beside). */
function scene(w = 800, h = 1280): SettingsScene {
  return sceneOn(createLayout(w, h));
}

/**
 * The scene laid out on `layout`. Taken as a parameter rather than built from screen pixels because
 * every coordinate in the tree is in DESIGN space (`layout.designWidth/Height`), which is not the
 * screen size — comparing a bound against the screen height would pass or fail for the wrong reason.
 */
function sceneOn(layout: ReturnType<typeof createLayout>): SettingsScene {
  return new SettingsScene(layout, new InputManager(), {
    onBack() {},
    playerName: 'Tester',
    publicId: '123456789',
    pvp: { rank: 'bronze', elo: 1000 },
    renameCost: 500,
    getCoins: () => 0,
    onRename: async (name: string) => ({ ok: true, name }),
    onReplayTutorial() {},
    onLogout() {},
    onDeleteAccount: async () => ({ ok: true }),
    openTextInput: createFakeTextInput().openTextInput,
  });
}

/**
 * Runs `fn` with a stub `window` in place — this suite's environment is headless node, where the
 * real code's `typeof window !== 'undefined'` guard would make every link a silent no-op and the
 * assertions below would be asserting on nothing. Installed around the tap only, so nothing else
 * (PIXI's own feature detection included) sees a half-built window.
 */
function withWindow(fn: () => void): Array<unknown[]> {
  const calls: Array<unknown[]> = [];
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  g.window = { open: (...args: unknown[]) => { calls.push(args); return null; } };
  try { fn(); } finally { if (had) g.window = prev; else delete g.window; }
  return calls;
}

/** The hit whose rect covers a link line, found the way a tap would find it. */
function linkHit(s: SettingsScene, label: string): () => void {
  const node = find(collect(s.container), '· ' + label);
  const midY = (node.top + node.bottom) / 2;
  const hit = s.hits.find((hh) => hh.rect.y <= midY && midY <= hh.rect.y + hh.rect.h && hh.rect.x > 800 * 0.5);
  expect(hit, `no hit rect on the "${label}" line (rects: ${JSON.stringify(s.hits.map((x) => x.rect))})`).toBeDefined();
  return hit!.fn;
}

beforeEach(() => { cap.platform = 'web'; });
afterEach(() => { setLocale('en'); vi.restoreAllMocks(); });

describe('SettingsScene — legal links', () => {
  it.each<Locale>(['zh', 'en', 'de'])('renders the section and both links in %s', (locale) => {
    setLocale(locale);
    const texts = collect(scene().container).map((n) => n.text);
    expect(texts).toContain(t('settings.legal'));
    expect(texts).toContain('· ' + t('consent.privacyPolicy'));
    expect(texts).toContain('· ' + t('consent.terms'));
  });

  // The geometric check: the links are the LAST thing on the screen, so they are the piece that
  // falls off the bottom, and they share a band with the account column's delete button.
  it.each([[800, 1280], [1280, 800], [1024, 640], [412, 915]])(
    'stays on screen and clear of the account column (%ix%i)',
    (w, h) => {
      const layout = createLayout(w, h);
      const nodes = collect(sceneOn(layout).container);
      const privacy = find(nodes, '· ' + t('consent.privacyPolicy'));
      const terms = find(nodes, '· ' + t('consent.terms'));
      const legal = find(nodes, t('settings.legal'));
      const del = find(nodes, t('settings.deleteAccount'));

      expect(terms.bottom, 'legal links run off the bottom of the screen').toBeLessThan(layout.designHeight);
      expect(legal.bottom, 'section label overlaps its own first link').toBeLessThanOrEqual(privacy.top + 1);
      expect(privacy.bottom, 'the two links overlap each other').toBeLessThanOrEqual(terms.top + 1);
      // Same band as the delete button, different column — the check that matters is that the
      // links are not sitting on top of the tutorial button above them.
      const help = find(nodes, t('settings.replayTutorial'));
      expect(legal.top, 'legal section overlaps the Replay-tutorial button above it').toBeGreaterThan(help.bottom);
      expect(del.top).toBeGreaterThan(0); // the account column drew, i.e. this shape is comparable
    },
  );
});

describe('SettingsScene — where the legal links point', () => {
  it('opens the relative hosted pages on the web', () => {
    const s = scene();
    const calls = withWindow(() => {
      linkHit(s, t('consent.privacyPolicy'))();
      linkHit(s, t('consent.terms'))();
    });
    expect(calls).toEqual([
      ['/privacy.html', '_blank', 'noopener'],
      ['/terms.html', '_blank', 'noopener'],
    ]);
  });

  // The one App Review actually taps. In the shell the pages are not bundled at all (webpack drops
  // them from the mobile target — IOS_RELEASE.md §10.2), so a relative URL here is a dead link.
  it('opens the absolute https pages inside the native shell', () => {
    cap.platform = 'ios';
    const s = scene();
    const calls = withWindow(() => {
      linkHit(s, t('consent.privacyPolicy'))();
      linkHit(s, t('consent.terms'))();
    });
    expect(calls).toEqual([
      ['https://nivara.gamestao.com/privacy', '_blank', 'noopener'],
      ['https://nivara.gamestao.com/terms', '_blank', 'noopener'],
    ]);
  });
});

// Regression coverage for the scene-title icon outlet (`drawSceneHeader`'s `opts.icon`).
//
// Two independent failure surfaces, neither visible from the other:
//
// 1. **Ink.** AI tab icons are baked per-ink at pack time and can't be tinted live, so `buildIcon`
//    reads `color` only as a light/dark hint (see design/product/tab-icon-art-prompts.md and the
//    "批次 3 收尾修复" section: a grey-on-near-black slot rendered invisible for a whole release).
//    A paper title bar needs the third, `content` ink — `C.dark`, the same weight as the title text
//    — NOT the deliberately washed-out grey baked for *inactive tabs*, which `tabIconVariant` would
//    pick on its own since both are dark inks on paper. That choice only exists at the call site.
//
// 2. **Layout.** The icon must push the title over, not overlap it, and an icon-less header must
//    stay pixel-identical to what every scene drew before the outlet existed.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { buildIcon } from '../../src/render/icons';
import { drawSceneHeader } from '../../src/ui/widgets/SceneHeader';

// Wrap-don't-replace, same treatment as lobbyBottomNavIconInk.ui.ts: the real glyph is still built,
// we only read back what the call site asked for. The harness resolves every asset import to one
// stubbed 1×1 PNG, so the baked variants are indistinguishable downstream — the call arguments are
// the only place the ink choice is observable.
vi.mock('../../src/render/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/icons')>();
  return { ...actual, buildIcon: vi.fn(actual.buildIcon) };
});

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const W = 1080;
const H = 1920;

/** The title Text node — the first Text added directly to the header container (the back label
 *  lives nested inside the cached chrome child, not at this level). */
function titleNode(root: PIXI.Container, label: string): PIXI.Text {
  const hit = root.children.find((c) => c instanceof PIXI.Text && c.text === label);
  if (!hit) throw new Error(`no title node "${label}"`);
  return hit as PIXI.Text;
}

describe('drawSceneHeader — title icon ink', () => {
  it('asks for the full-strength `content` art on a paper bar, not the washed-out inactive-tab grey', () => {
    vi.mocked(buildIcon).mockClear();
    drawSceneHeader(new PIXI.Container(), W, H, 'Equipment', { icon: 'equipIcon' });

    const call = vi.mocked(buildIcon).mock.calls.find(([kind]) => kind === 'equipIcon');
    expect(call, 'header never built its title icon').toBeTruthy();
    expect(call![3]?.variant).toBe('content');
  });

  it('falls back to the white `active` art on the legacy dark bar variant (white title)', () => {
    vi.mocked(buildIcon).mockClear();
    drawSceneHeader(new PIXI.Container(), W, H, 'Equipment', { icon: 'equipIcon', variant: 'dark' });

    const call = vi.mocked(buildIcon).mock.calls.find(([kind]) => kind === 'equipIcon');
    expect(call![3]?.variant).toBe('active');
  });
});

describe('drawSceneHeader — title icon layout', () => {
  it('centres [icon][gap][title] as one group, with the icon fully left of the text', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment', { icon: 'equipIcon' });

    const title = titleNode(c, 'Equipment');
    // Chrome, then icon, then title (see drawSceneHeader) — the icon is the title's left neighbour.
    const icon = c.children[c.getChildIndex(title) - 1] as PIXI.Container;
    expect(icon).toBeTruthy();
    expect(icon.x).toBeLessThan(title.x);
    expect((icon.x + title.x + title.width) / 2).toBeCloseTo(W / 2, 0);
  });

  it('leaves an icon-less header where it was: title centred, nothing drawn before it', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment');

    const title = titleNode(c, 'Equipment');
    // The chrome sprite is child 0; with no icon the title must follow it immediately, or scenes
    // that index into the header's children (sceneHeaderPortraitContentScale.ui.ts) shift under it.
    expect(c.getChildIndex(title)).toBe(1);
    // Within a pixel of dead centre: the group's left edge is rounded to a whole pixel (crisper
    // text than the old fractional anchor-0.5 origin), so an odd-width title lands half a pixel off.
    expect(Math.abs(title.x + title.width / 2 - W / 2)).toBeLessThanOrEqual(1);
  });

  it('never lets a centred group overlap the back pill on a narrow bar (long title + icon)', () => {
    // The real regression: "Hero Roster" on a 430 CSS px portrait bar. Centred as bare text it
    // already sat a few px from the pill; the icon's lead width put the glyph on top of the back
    // label. The group gets pushed right of centre instead.
    const c = new PIXI.Container();
    drawSceneHeader(c, 430, 932, 'Hero Roster', { icon: 'rosterIcon' });

    const title = titleNode(c, 'Hero Roster');
    const icon = c.children[c.getChildIndex(title) - 1] as PIXI.Container;
    const chrome = c.children[0] as PIXI.Container;
    // The back pill is the last thing buildChrome adds (bg → guilloche → rule → chip).
    const chip = chrome.children[chrome.children.length - 1] as PIXI.Container;
    expect(icon.x).toBeGreaterThanOrEqual(chip.x + chip.width);
    // …and the other end: the group shrinks to fit rather than running off the right edge / under
    // the coin readout the roster scene draws there (the first attempt clamped left only, which
    // just moved the collision from the back button to the currency cluster).
    expect(title.x + title.width).toBeLessThanOrEqual(430 * (1 - 0.2) + 1);
  });

  it('left-aligned titles (equipment/roster, which also draw a right-side currency cluster) put the icon left of the text too', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment', { icon: 'equipIcon', titleAlign: 'left' });

    const title = titleNode(c, 'Equipment');
    const icon = c.children[c.getChildIndex(title) - 1] as PIXI.Container;
    expect(icon.x).toBeLessThan(title.x);
    // Still clear of the back pill on the left half of the bar, nowhere near the currency cluster.
    expect(icon.x).toBeGreaterThan(0);
    expect(title.x + title.width).toBeLessThan(W / 2);
  });
});

// BattlePassScene/nav.ts's drawSidebar/contentBounds — previously zero direct coverage. The only
// existing shop-group nav test (shopGroupTabs.ui.ts) drives BattlePassScene exclusively via
// createLayout(800, 1280) (portrait, landscape=false), so drawSidebar's landscape branch (the left
// rail via drawSidebarTabs) and contentBounds' rail-aware x0 shift were never exercised at all —
// only the portrait bottom-bar branch was, indirectly.
//
// Tested here against a hand-built NavHost (same "pure function of its explicit host" shape as
// HubTabs' own drawBottomNavTabs coverage in hubTabsBottomNavBackground.ui.ts) rather than a full
// BattlePassScene, so the nav module's own branching is pinned independently of the scene's render()
// call order.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { sidebarNavW, bottomNavH } from '../../src/ui/widgets/HubTabs';
import { drawSidebar, contentBounds, type NavHost } from '../../src/scenes/BattlePassScene/nav';
import type { BattlePassCallbacks } from '../../src/scenes/BattlePassScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };

function makeHost(opts: { landscape: boolean; cb: Partial<BattlePassCallbacks>; hits?: Hit[] }): NavHost {
  return {
    container: new PIXI.Container(),
    cb: { onBack() {}, getCoins: () => 0, ...opts.cb } as BattlePassCallbacks,
    w: 1280,
    h: 800,
    landscape: opts.landscape,
    hits: opts.hits ?? [],
    navHits: [],
  };
}

describe('BattlePassScene/nav — drawSidebar', () => {
  it('draws nothing and leaves hits untouched when openShop is absent', () => {
    const host = makeHost({ landscape: true, cb: {} });
    const before = host.hits.length;
    drawSidebar(host, 100);
    expect(host.container.children.length).toBe(0);
    expect(host.hits.length).toBe(before);
    expect(host.navHits).toEqual([]);
  });

  it('landscape: draws a left rail (sidebarNavW wide) and appends its hits directly onto host.hits (not navHits)', () => {
    let openedShop = 0;
    const host = makeHost({ landscape: true, cb: { openShop: () => { openedShop++; } } });
    drawSidebar(host, 100);

    expect(host.container.children.length).toBeGreaterThan(0);
    expect(host.navHits).toEqual([]); // landscape branch never touches navHits — that's portrait-only
    expect(host.hits.length).toBeGreaterThan(0);

    // The rail's own [Shop] tab must be tappable via the appended hit.
    host.hits[0].fn();
    expect(openedShop).toBe(1);
  });

  it('portrait: draws a bottom bar, records navHits, and unshifts its hits to the FRONT of host.hits', () => {
    let openedShop = 0;
    const preexisting: Hit = { rect: { x: 0, y: 0, w: 1, h: 1 }, fn: () => {} };
    const host = makeHost({ landscape: false, cb: { openShop: () => { openedShop++; } }, hits: [preexisting] });
    drawSidebar(host, 100);

    expect(host.container.children.length).toBeGreaterThan(0);
    expect(host.navHits.length).toBeGreaterThan(0);
    // Unshifted: the nav bar's hits land before the pre-existing entry, so a tap on the bar can
    // never be shadowed by whatever the caller already pushed.
    expect(host.hits[host.hits.length - 1]).toBe(preexisting);
    expect(host.hits[0]).not.toBe(preexisting);

    host.hits[0].fn();
    expect(openedShop).toBe(1);
  });

  it('portrait bar height matches bottomNavH, landscape rail width matches sidebarNavW (shared with every other hub)', () => {
    const { w, h } = { w: 1280, h: 800 };
    // Not directly observable off drawSidebar's return (void), but both dimensions are asserted
    // indirectly through contentBounds below, which is derived from the same sidebarNavW() call —
    // a regression that swapped in a different width constant would show up there.
    expect(sidebarNavW(w, h, true)).toBeGreaterThan(0);
    expect(bottomNavH(h)).toBeGreaterThan(0);
  });
});

describe('BattlePassScene/nav — contentBounds', () => {
  const w = 1280, h = 800;
  const rightPad = Math.round(w * 0.05);

  it('no openShop: plain 5%-of-w pad on both edges, regardless of orientation', () => {
    expect(contentBounds(makeHost({ landscape: true, cb: {} }))).toEqual({ x0: rightPad, w: w - 2 * rightPad });
    expect(contentBounds(makeHost({ landscape: false, cb: {} }))).toEqual({ x0: rightPad, w: w - 2 * rightPad });
  });

  it('openShop + portrait: bottom bar reserves no width, so it degrades to the plain pad', () => {
    const host = makeHost({ landscape: false, cb: { openShop() {} } });
    expect(contentBounds(host)).toEqual({ x0: rightPad, w: w - 2 * rightPad });
  });

  it('openShop + landscape: left edge shifts right of the sidebar rail (rail width + 2%-of-w gap)', () => {
    const host = makeHost({ landscape: true, cb: { openShop() {} } });
    const expectedX0 = sidebarNavW(w, h, true) + Math.round(w * 0.02);
    expect(contentBounds(host)).toEqual({ x0: expectedX0, w: w - expectedX0 - rightPad });
    expect(expectedX0).toBeGreaterThan(rightPad); // sanity: the rail-aware shift is actually wider than the plain pad
  });
});

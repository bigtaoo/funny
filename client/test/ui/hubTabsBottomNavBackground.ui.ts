// Coverage for the 2026-08-09 fix (see design/game/LOBBY_IA_REDESIGN.md §22): `drawBottomNavTabs`
// (shared by 14 portrait bottom-nav scenes — CardScene, EquipmentScene, ShopScene, GachaScene,
// BattlePassScene, RechargeScene, DailyScene, AuctionScene, socialTabRail, CareerTabs, ...) drew each
// tab cell as its own opaque `sketchPanel`, but the `pad`/`gap` slivers around and between cells were
// never backed by anything — scrolled body content (or the bare paper page background) showed through
// right up to the screen's bottom edge, reading as a half-transparent bar rather than a solid nav bar
// docked to the bottom of the screen.
//
// Pure-function coverage (no scene construction needed — `drawBottomNavTabs` only touches the
// container it's given): pins that a full-width/full-height background is drawn first (so tab cells
// paint on top of it, not the other way round), and that the empty-tabs early return still draws
// nothing at all (guards against someone hoisting the background draw above that check later).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawBottomNavTabs, type HubTab } from '../../src/ui/widgets/HubTabs';

function tabs(n: number): HubTab[] {
  return Array.from({ length: n }, (_, i) => ({ label: `Tab ${i}`, active: i === 0 }));
}

describe('HubTabs.drawBottomNavTabs — full-width background strip (2026-08-09)', () => {
  it('draws an opaque background spanning the full bar rect before any tab cell', () => {
    const container = new PIXI.Container();
    const w = 1080;
    const y = 1800;
    const barH = 120;
    drawBottomNavTabs(container, w, y, barH, tabs(3), () => {});

    // The background must be the very first child so every tab cell (and its badge/label/icon)
    // paints on top of it, not the other way round.
    const bg = container.children[0] as PIXI.Graphics;
    expect(bg).toBeInstanceOf(PIXI.Graphics);
    const bounds = bg.getLocalBounds();
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(y);
    expect(bounds.width).toBe(w);
    expect(bounds.height).toBe(barH);

    // At least one more child (the first tab's panel) follows the background.
    expect(container.children.length).toBeGreaterThan(1);
  });

  it('draws nothing at all — no stray background strip either — when tabs is empty', () => {
    const container = new PIXI.Container();
    const { hits } = drawBottomNavTabs(container, 1080, 1800, 120, [], () => {});
    expect(hits).toEqual([]);
    expect(container.children.length).toBe(0);
  });
});

// Regression coverage for design/game/LOBBY_IA_REDESIGN.md §22: the full-width backing strip
// `drawBottomNavTabs` draws behind its tab cells (see hubTabsBottomNavBackground.ui.ts for the
// geometry/z-order coverage of that strip itself) originally filled with `ui.paper` (0xfaf6ee) —
// visually indistinguishable from the page background `ui.bg` (0xf5f0e8), so the strip was drawn
// but unreadable as a bar. Pins the fix: fill is `ui.dark` at a near-opaque alpha, matching
// LobbyScene's own bottom-nav convention (`navBg.beginFill(C.cover, 0.9)` in LobbyScene/bottomNav.ts).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawBottomNavTabs, type HubTab } from '../../src/ui/widgets/HubTabs';
import { ui } from '../../src/render/sketchUi';

function tabs(n: number): HubTab[] {
  return Array.from({ length: n }, (_, i) => ({ label: `Tab ${i}`, active: i === 0 }));
}

describe('HubTabs.drawBottomNavTabs — background strip color (LOBBY_IA_REDESIGN §22)', () => {
  it('fills the backing strip with ui.dark at a near-opaque alpha, not ui.paper', () => {
    const container = new PIXI.Container();
    drawBottomNavTabs(container, 1080, 1800, 120, tabs(3), () => {});

    const bg = container.children[0] as PIXI.Graphics;
    const fillStyle = bg.geometry.graphicsData[0]!.fillStyle;
    expect(fillStyle.color).toBe(ui.dark);
    expect(fillStyle.color).not.toBe(ui.paper);
    // Near-opaque so it reads as a solid docked bar, not a translucent hint of one.
    expect(fillStyle.alpha).toBeGreaterThan(0.85);
  });
});

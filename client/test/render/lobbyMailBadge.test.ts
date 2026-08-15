/**
 * lobbyMailBadge.test.ts — regression test for "大厅邮件显示红点，点进去却啥也没有"
 * fixed 2026-07-20.
 *
 * Background: the mail strip item's red dot (`mailStripRect`, badges.ts
 * drawSideStripBadges) used to key off `socialBadge` — the aggregate of
 * friendRequests + chat + mail from GET /social/badges. Any unread friend
 * request or chat message lit up the mail dot even with zero unread mail, so
 * tapping the mail strip opened an empty inbox. Fixed by giving the mail strip
 * its own `mailBadge`, fed from the server's already-split `mail` count
 * (applySocialBadge(total, mail) two-arg signature).
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Minimal PIXI stub — enough for badges.ts + base.ts to load and draw ──────
vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    children: unknown[] = [];
    addChild(c: unknown): unknown { this.children.push(c); return c; }
    removeChildren(): unknown[] { const kids = this.children; this.children = []; return kids; }
    destroy(_opts?: unknown): void { /* no-op */ }
  }
  class FakeGraphics extends FakeContainer {
    lineStyle(): this { return this; }
    beginFill(): this { return this; }
    endFill(): this { return this; }
    drawCircle(): this { return this; }
  }
  class FakeText extends FakeContainer {
    style: { fontSize?: number; padding?: number };
    anchor = { set: (): void => {} };
    width = 10;
    x = 0; y = 0;
    constructor(_text?: string, style: { fontSize?: number; padding?: number } = {}) {
      super();
      this.style = style;
    }
  }
  return {
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Text: FakeText,
    settings: { ADAPTER: {} },
    // icons.ts (imported transitively via badges.ts's HubTabs icons) now pulls in
    // cardArt.ts -> preloadTextures.ts for the raster tab-icon art (batch 2/3), which
    // reads these at module scope for ART_TEX_OPTIONS — without them the import throws
    // before this test's own mocks/imports even run.
    MIPMAP_MODES: { OFF: 0, POW2: 1, ON: 2, ON_MANUAL: 3 },
    SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
  };
});

// ── webpack-served asset used by coinIconAtlas.ts (imported transitively via core.ts) ──
vi.mock('../../src/assets/shop/coins.png',  () => ({ default: 'coins.png' }));
vi.mock('../../src/assets/shop/coins.json', () => ({ default: { frames: {}, meta: {} } }));

// ── jszip stub (StickmanRuntime, imported transitively via core.ts) ────────────
vi.mock('jszip', () => ({ default: { loadAsync: () => Promise.reject(new Error('unused in this test')) } }));

// ── Imports (after all vi.mock declarations) ───────────────────────────────────
import { BadgesPanel } from '../../src/scenes/LobbyScene/badges';
import type { LobbySceneCore } from '../../src/scenes/LobbyScene/core';

const RECT = { x: 0, y: 0, w: 40, h: 40 };

/** Bare-bones stand-in for LobbySceneCore — only the fields badges.ts touches. */
class FakeLobbySceneCore {
  destroyed = false;
  h = 800;
  socialBadge = 0;
  mailBadge = 0;
  achievementBadge = false;
  retentionBadge = false;
  socialBadgeLayer = { children: [] as unknown[], addChild(c: unknown) { this.children.push(c); }, removeChildren() { const k = this.children; this.children = []; return k; } };
  sideStripBadgeLayer = { children: [] as unknown[], addChild(c: unknown) { this.children.push(c); }, removeChildren() { const k = this.children; this.children = []; return k; } };
  socialNavRect = RECT;
  dailyBtnRect = RECT;
  mailStripRect = RECT;
  achieveStripRect = RECT;
}

describe('LobbyScene mail strip red dot — must track mail-only unread, not the social aggregate', () => {
  it('does NOT light up the mail strip when unread is all friend-request/chat (mail: 0)', () => {
    const core = new FakeLobbySceneCore() as unknown as LobbySceneCore;
    const badges = new BadgesPanel(core);

    // GET /social/badges: 1 pending friend request, 0 unread mail → total: 1, mail: 0.
    badges.applySocialBadge(1, 0);

    expect(core.socialBadge).toBe(1);       // social nav dot: aggregate, unaffected
    expect(core.mailBadge).toBe(0);         // mail strip dot: must stay 0
    expect((core.sideStripBadgeLayer as unknown as { children: unknown[] }).children.length).toBe(0); // no dot drawn on the mail strip
  });

  it('lights up the mail strip once there really is unread mail', () => {
    const core = new FakeLobbySceneCore() as unknown as LobbySceneCore;
    const badges = new BadgesPanel(core);

    badges.applySocialBadge(2, 1); // 1 friend request + 1 unread mail = total 2, mail 1
    expect(core.mailBadge).toBe(1);
    expect((core.sideStripBadgeLayer as unknown as { children: unknown[] }).children.length).toBe(1); // dot drawn once, for the mail strip

    badges.applySocialBadge(0, 0); // all read → dot clears
    expect(core.mailBadge).toBe(0);
    expect((core.sideStripBadgeLayer as unknown as { children: unknown[] }).children.length).toBe(0);
  });
});

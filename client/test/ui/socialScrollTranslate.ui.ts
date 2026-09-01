// The FriendsScene cheap-scroll path's correctness contract (social-tab-switch-cost, 2026-08-20).
//
// `scrollDragThrottle.ui.ts` pins the CHEAPNESS half — a drag inside the overscan band rebuilds
// nothing, and rows land where a rebuild would have put them. This file pins everything that can
// still be silently wrong once the tree stops being rebuilt every frame:
//
//   - taps must resolve to the row the player can actually see (hit rects live in build space, so
//     they need the applied translate added back — and "applied" is doing real work there, see the
//     wheel case below);
//   - the scroll thumb is redrawn on every translate, so it must not accumulate;
//   - the world channel re-baselines mid-render (stick-to-latest sets scrollY *after* scrollRegion),
//     which is the one place a missing markScrollBuilt() would offset the whole list;
//   - tabs that draw rows unmasked must keep overscan at 0, or the extra rows spill past the region
//     with nothing to clip them;
//   - and every incremental path must still fall back to a full render when its object is gone.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import type { FriendView } from '../../src/net/ApiClient';
import type { WorldChatMessage } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];

/**
 * All offline and zero-padded, so drawList's sort (online first, then displayName.localeCompare)
 * leaves them in array order — the tests below identify rows by index, which only works if the
 * on-screen order is predictable.
 */
function orderedFriends(n: number): FriendView[] {
  return Array.from({ length: n }, (_, i) => ({
    publicId: String(100000000 + i),
    displayName: `Friend${String(i).padStart(2, '0')}`,
    online: false,
  }));
}

function build(overrides: Partial<FriendsSceneCallbacks> = {}) {
  const input = new InputManager();
  const scene = new FriendsScene(createLayout(W, H), input, {
    onBack() {}, onOpenRoom() {},
    myPublicId: '', getProfileExtra: async () => ({}),
    loadFriends: async () => orderedFriends(30),
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    loadConversations: async () => [], openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {},
    claimMail: async () => true, deleteMail: async () => {},
    openTextInput: createFakeTextInput().openTextInput,
    ...overrides,
  }) as any;
  return { scene, input };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Capture which friend a row tap resolves to, without depending on ProfilePopup internals. */
function captureProfileOpens(scene: any): string[] {
  const opened: string[] = [];
  scene.friendsList.openFriendProfile = (f: FriendView) => opened.push(f.displayName);
  return opened;
}

// Everything below reads its coordinates off the live layout. `createLayout(800, 1280)` does NOT
// mean the scene's design space is 800x1280 — ScalingManager maps it to a larger one (regionTop
// lands around 431, cW around 1026 for this input), so hardcoded offsets silently miss the rows.

/**
 * The full-width row hits, ascending — the same rects onPointerUp will test against. Row backgrounds
 * are anonymous Graphics in the layer, so going through `hits` both identifies rows unambiguously
 * (full content width + inside the scroll layer) and keeps the test aimed at the hit-test path.
 */
function rowHits(scene: any): Array<{ x: number; y: number; w: number; h: number }> {
  const core = scene.core;
  return core.hits
    .filter((h: any) => h.scroll && Math.round(h.rect.w) === Math.round(core.cW))
    .map((h: any) => h.rect)
    .sort((a: any, b: any) => a.y - b.y);
}

/** Vertical distance between adjacent rows, measured off the rendered tree. */
function rowStep(scene: any): number {
  const rows = rowHits(scene);
  expect(rows.length).toBeGreaterThan(2);
  return Math.round(rows[1]!.y - rows[0]!.y);
}

/** Centre of the first row sitting fully inside the visible region, in screen coords. */
function firstVisibleRowCentre(scene: any): number {
  const core = scene.core;
  const applied = core.repaint.appliedScrollDelta;
  const row = rowHits(scene).find((r) => r.y - applied >= core.regionTop);
  expect(row).toBeTruthy();
  return Math.round(row!.y - applied + row!.h / 2);
}

/**
 * Screen y of every row currently visible inside the region. Deliberately region-filtered rather
 * than "every row in the layer": the overscan window is built around whatever scrollY was current,
 * so a translated tree and a rebuilt one legitimately hold different row *sets* at the edges. What
 * must agree is the part the player can see.
 */
function visibleRowScreenYs(scene: any): number[] {
  const core = scene.core;
  const applied = core.repaint.appliedScrollDelta;
  return rowHits(scene)
    .map((r) => Math.round(r.y - applied))
    .filter((y) => y >= core.regionTop && y <= core.regionBottom)
    .sort((a, b) => a - b);
}

/** Tap x left of every row's duel/✕ buttons, so the row's own hit wins. */
function tapX(scene: any): number {
  return Math.round(scene.core.cX + scene.core.cW * 0.1);
}

// ── Taps after a translate ────────────────────────────────────────────────────

describe('FriendsScene cheap scroll — a tap resolves to the row actually on screen', () => {
  it('after a drained drag, the same screen position hits the row that scrolled into it', async () => {
    const { scene, input } = build();
    await settle();
    const opened = captureProfileOpens(scene);
    const core = scene.core;
    const x = tapX(scene);
    expect(core.maxScroll).toBeGreaterThan(0);

    const tapY = firstVisibleRowCentre(scene);
    input._emitDown(x, tapY);
    input._emitUp(x, tapY);
    expect(opened).toHaveLength(1);
    const before = opened[0]!;

    // Drag up by exactly one row step, starting well below the tap point.
    const step = rowStep(scene);
    const dragFrom = core.regionTop + Math.round((core.regionBottom - core.regionTop) * 0.7);
    input._emitDown(x, dragFrom);
    input._emitMove(x, dragFrom - step);
    input._emitUp(x, dragFrom - step); // a drag drops its own tap
    scene.update(1 / 60);              // drain → translate
    expect(core.scrollY).toBe(step);
    expect(opened).toHaveLength(1);    // the drag itself opened nothing

    input._emitDown(x, tapY);
    input._emitUp(x, tapY);
    expect(opened).toHaveLength(2);
    // Exactly one row further down the list. This is the assertion that catches a wrong sign or a
    // missing offset in onPointerUp's build-space mapping — a mis-mapped tap opens some other
    // player's profile card, which is about as visible as a bug gets.
    expect(friendIndex(opened[1]!)).toBe(friendIndex(before) + 1);
    scene.destroy();
  });

  it('a wheel tick that has not been drained yet does NOT shift the tap (regression, 2026-08-20)', async () => {
    const { scene, input } = build();
    await settle();
    const opened = captureProfileOpens(scene);
    const core = scene.core;
    const x = tapX(scene);
    const tapY = firstVisibleRowCentre(scene);

    input._emitDown(x, tapY);
    input._emitUp(x, tapY);
    const before = opened[0]!;

    // onWheel updates scrollY inline and only flags scrollDirty — the layer does not move until the
    // next update() drain. A click landing inside that one-frame window has to be judged against
    // the screen as it still looks. Offsetting it by the PENDING delta (which the first cut of this
    // code did) shifts the tap by a whole row while nothing has visibly moved.
    input._emitWheel(x, tapY, rowStep(scene));
    expect(core.scrollY).toBeGreaterThan(0);
    expect(core.repaint.layer.y).toBe(0);
    expect(core.repaint.pendingScrollDelta).toBeGreaterThan(0);
    expect(core.repaint.appliedScrollDelta).toBe(0);

    input._emitDown(x, tapY);
    input._emitUp(x, tapY);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBe(before); // same row — the screen never moved
    scene.destroy();
  });
});

/** 'Friend07' → 7. */
function friendIndex(displayName: string): number {
  return Number(displayName.replace('Friend', ''));
}

// ── The thumb must not pile up ────────────────────────────────────────────────

describe('FriendsScene cheap scroll — a drag past the end stops at the end', () => {
  // The sibling pages (Sect/Family, 2026-08-25) shipped this bug: their gesture reported raw finger
  // travel and the per-frame full render was what clamped it, so once the cheap-scroll path replaced
  // that render an over-drag translated the list into blank space. FriendsScene never had it —
  // onPointerMove has always clamped — but nothing pinned that, so here it is.
  it('over-dragging leaves the offset at maxScroll and does not translate past it', async () => {
    const { scene, input } = build();
    await settle();
    const core = scene.core;
    expect(core.maxScroll).toBeGreaterThan(0);

    const y = firstVisibleRowCentre(scene);
    input._emitDown(tapX(scene), y);
    input._emitMove(tapX(scene), y - (core.maxScroll + 500));
    scene.update(1 / 60);

    expect(core.scrollY).toBe(core.maxScroll);
    // The layer may have been rebuilt (the drag left the overscan band) — either way what is on
    // screen must sit exactly at the end, never beyond it.
    expect(core.repaint.appliedScrollDelta).toBeLessThanOrEqual(core.maxScroll);
    expect(core.repaint.pendingScrollDelta + core.repaint.builtScrollY).toBe(core.maxScroll);

    // Reversing the finger back inside the range follows it again (the clamp is a ceiling, not a
    // latch): drag back to 200px short of the end and the content is 200px short of the end.
    input._emitMove(tapX(scene), y - (core.maxScroll - 200));
    scene.update(1 / 60);
    expect(core.scrollY).toBe(core.maxScroll - 200);
    scene.destroy();
  });
});

describe('FriendsScene cheap scroll — the scroll thumb is replaced, not stacked', () => {
  it('many drag frames leave the container child count unchanged', async () => {
    const { scene, input } = build();
    await settle();
    const core = scene.core;
    const x = tapX(scene);
    const from = core.regionTop + Math.round((core.regionBottom - core.regionTop) * 0.7);
    const before = core.container.children.length;

    input._emitDown(x, from);
    for (let i = 1; i <= 8; i++) {
      input._emitMove(x, from - i * 12);
      scene.update(1 / 60); // each drain redraws the thumb
    }
    input._emitUp(x, from - 96);

    // drawScrollbar() destroys the previous Graphics before adding the new one; without that, this
    // grows by one per drained frame and every drag leaks a thumb into the display list.
    expect(core.container.children.length).toBe(before);
    expect(core.repaint.scrollbar).toBeTruthy();
    scene.destroy();
  });
});

// ── World channel: the mid-render re-baseline ─────────────────────────────────

describe('FriendsScene cheap scroll — world channel stick-to-latest re-baselines correctly', () => {
  function worldMessages(n: number): WorldChatMessage[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `m${i}`, senderPublicId: '100000000', senderName: `Sender${i}`,
      body: `hello ${i}`, ts: 1000 + i,
    })) as unknown as WorldChatMessage[];
  }

  it('a translated world list matches a rebuild at the same scrollY', async () => {
    const { scene, input } = build({ loadWorldChat: async () => worldMessages(40) });
    await settle();
    const core = scene.core;

    core.switchTab('world');
    await settle();
    expect(core.worldLoaded).toBe(true);
    expect(core.maxScroll).toBeGreaterThan(200);
    // Entering the tab pins to the newest message, i.e. scrollY === maxScroll — and that assignment
    // happens after scrollRegion() baselined the layer, which is exactly what markScrollBuilt()
    // re-baselines. Without it, builtScrollY would be 0 while rows sit at maxScroll.
    expect(core.scrollY).toBe(core.maxScroll);
    expect(core.repaint.builtScrollY).toBe(core.scrollY);
    expect(core.repaint.layer.y).toBe(0);

    // Scroll up into history by an awkward amount, via the translate path.
    const x = tapX(scene);
    const from = core.regionTop + Math.round((core.regionBottom - core.regionTop) * 0.3);
    input._emitDown(x, from);
    input._emitMove(x, from + 111);
    input._emitUp(x, from + 111);
    scene.update(1 / 60);
    expect(core.scrollY).toBe(core.maxScroll - 111);
    const translated = visibleRowScreenYs(scene);
    expect(translated.length).toBeGreaterThan(3);

    scene.render(); // same scrollY, arrived at by a rebuild
    expect(core.repaint.appliedScrollDelta).toBe(0); // freshly baselined
    const rebuilt = visibleRowScreenYs(scene);

    expect(translated).toEqual(rebuilt);
    scene.destroy();
  });
});

// ── Unmasked tabs must not get an overscan ───────────────────────────────────

describe('FriendsScene cheap scroll — unmasked tabs keep overscan at 0', () => {
  it('the family browse list draws straight into container, so no overscan and no layer', async () => {
    const { scene } = build({
      loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: false }),
      browseFamilies: async () => ([
        { familyId: 'f1', name: 'Alpha', tag: 'AAA', memberCount: 3, prosperity: 10 },
        { familyId: 'f2', name: 'Beta', tag: 'BBB', memberCount: 4, prosperity: 20 },
      ] as any),
    });
    await settle();
    const core = scene.core;

    core.switchTab('family');
    await settle();
    core.familySubview = 'joinById';
    core.familyBrowseLoaded = true;
    scene.render();

    // rowVisible() widens by repaint.overscan. On this tab the rows go straight into `container`
    // with no clip, so a non-zero overscan would draw rows visibly past the region's edges.
    expect(core.repaint.overscan).toBe(0);
    expect(core.repaint.layer).toBeNull();
    // Every row rowVisible() admitted must therefore be inside the region proper.
    for (const c of core.container.children) {
      if (!(c instanceof PIXI.Graphics)) continue;
      if (c.y === 0) continue; // background / decor
      expect(c.y).toBeGreaterThanOrEqual(core.regionTop - 1);
    }
    scene.destroy();
  });
});

// ── Fallbacks: a missing handle degrades to a full render ─────────────────────

describe('FriendsScene incremental repaints — fall back to render() when the handle is gone', () => {
  it('a scroll with no layer registered rebuilds instead of silently doing nothing', async () => {
    const { scene } = build();
    await settle();
    const core = scene.core;
    const renders = vi.fn();

    core.repaint.reset(); // simulates a tab that never called scrollRegion
    core.render = renders;
    core.scrollDirty = true;
    scene.update(1 / 60);

    expect(renders).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('a caret blink whose Text was destroyed rebuilds instead of throwing', async () => {
    const { scene } = build({
      loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: false }),
      createFamily: async () => {},
    });
    await settle();
    const core = scene.core;
    core.tab = 'family';
    core.slgLoaded = true;
    core.slgStatus = { worldId: 'world:1:0', isLeader: false };
    core.familySubview = 'create';
    core.familyActiveInput = 'name';
    scene.render();
    expect(core.repaint.caretField).toBeTruthy();

    core.repaint.caretField.obj.destroy();
    const renders = vi.fn();
    core.render = renders;
    expect(() => scene.update(0.6)).not.toThrow();
    expect(renders).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('a countdown tick whose label was destroyed rebuilds instead of throwing', async () => {
    const { scene } = build();
    await settle();
    const core = scene.core;
    core.applyDuelInvited({ inviteId: 'inv1', fromPublicId: '100000000', fromName: 'Friend00' });
    expect(core.repaint.duelBannerLabel).toBeTruthy();

    core.repaint.duelBannerLabel.destroy();
    const renders = vi.fn();
    core.render = renders;
    core.incomingDuelInvite.expiresAt -= 3_000;
    expect(() => scene.update(1.1)).not.toThrow();
    expect(renders).toHaveBeenCalledTimes(1);
    scene.destroy();
  });
});

// ── The one caret field with width-dependent layout ──────────────────────────

describe('FriendsScene caret blink — the world-chat field re-runs its reflow', () => {
  it('the blink re-applies the overflow anchoring, not just the string', async () => {
    const { scene } = build({ loadWorldChat: async () => [] });
    await settle();
    const core = scene.core;

    core.switchTab('world');
    await settle();
    // Focus the input the way tapping it does (the hit handler also opens a DOM input, which the
    // headless harness has no use for — the flag is what render() and the blink loop read).
    core.worldChatActive = true;
    // The field's own maxLength — comfortably past the box width under any plausible text metric
    // (the headless harness measures 7px per char, the box is a few hundred px).
    core.worldChatInput = 'x'.repeat(200);
    scene.render();

    const field = core.repaint.caretField;
    expect(field).toBeTruthy();
    // This is the only field that needs one: its anchor flips once the line outgrows the box, and
    // adding or removing the caret glyph can be what tips it across that threshold.
    expect(field.reflow).toBeInstanceOf(Function);
    const reflow = vi.fn(field.reflow);
    field.reflow = reflow;

    scene.update(0.6); // past the blink interval

    expect(reflow).toHaveBeenCalledTimes(1);
    expect(reflow).toHaveBeenCalledWith(field.obj);
    // A long line stays right-anchored across the blink, so the caret end remains in view.
    expect(field.obj.anchor.x).toBe(1);
    scene.destroy();
  });

  it('a short line stays left-anchored across the blink', async () => {
    const { scene } = build({ loadWorldChat: async () => [] });
    await settle();
    const core = scene.core;
    core.switchTab('world');
    await settle();
    core.worldChatActive = true;
    core.worldChatInput = 'hi';
    scene.render();

    expect(core.repaint.caretField.obj.anchor.x).toBe(0);
    scene.update(0.6);
    expect(core.repaint.caretField.obj.anchor.x).toBe(0);
    scene.destroy();
  });
});

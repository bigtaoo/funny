// Regression coverage for the 2026-07-20 fix: FamilyScene's channel (`renderChannel()`) was the
// only chat surface still drawing messages in raw server order (newest-first) with no scroll mask,
// while SectScene/FriendsScene's world chat already render oldest-at-top behind a `PIXI.Graphics`
// clip. Two bugs this covers:
//   1. Messages displayed newest-at-top instead of oldest-at-top (early time on top, later time at
//      the bottom, matching every other chat surface).
//   2. Scrolling could bleed a message row up past the top of the list into the header/tab band
//      above it, since nothing clipped the scroll region.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import type { FamilyDetailView, FamilyMessageView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeFamily(): FamilyDetailView {
  return {
    familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me',
    memberCount: 1, prosperity: 0,
    members: [{ accountId: 'me', role: 'leader', joinedAt: 0, displayName: 'tao', publicId: '1' }],
  };
}

/** Server contract: `getFamilyChannel` returns newest-first (ts descending) — mirrored verbatim
 *  onto `this.messages` (no reorder) by `FamilyScene/data.ts`'s `loadChannel()`. */
function makeMessagesNewestFirst(n: number): FamilyMessageView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${n - i}`, senderId: `u${n - i}`, senderName: `user${n - i}`,
    body: `msg number ${n - i}`, ts: (n - i) * 100,
  }));
}

function buildScene(w: number, h: number, messages: FamilyMessageView[]): any {
  const worldApi = {
    getMyFamily: async () => makeFamily(),
    getFamilyChannel: async () => messages,
    sendFamilyMessage: async () => {},
  };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
    getFriendPublicIds: async () => new Set<string>(),
  };
  // Landscape split view keeps the channel column permanently visible (no tab switch needed).
  const layout = { designWidth: w, designHeight: h, orientation: 'landscape' } as any;
  return new FamilyScene(layout, new InputManager(), cb as any);
}

async function flush(scene: any): Promise<void> {
  await scene.loadData();
}

/** Channel rows are drawn into a masked sub-container (the scroll clip), so walk the whole
 *  bodyLayer subtree rather than only its direct children — same helper as sectSceneSplitView.ui.ts
 *  and familySceneSplitView.ui.ts use for the same reason. */
function textNodesOf(scene: any): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text) out.push(c);
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(scene.bodyLayer);
  return out;
}

/** Every `PIXI.Container` under bodyLayer with a `.mask` set — the scroll clip(s). */
function maskedContainersOf(scene: any): PIXI.Container[] {
  const out: PIXI.Container[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Container && (c as PIXI.Container).mask) out.push(c);
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(scene.bodyLayer);
  return out;
}

describe('FamilyScene — channel message ordering (newest-first server data → oldest-at-top display)', () => {
  it('renders the oldest message at the top and the newest at the bottom', async () => {
    // messages[0] is the newest (ts=300), messages[2] is the oldest (ts=100) — matches the real
    // server's `.sort({ ts: -1 })` contract.
    const scene = buildScene(1200, 950, makeMessagesNewestFirst(3));
    await flush(scene);
    scene.render();

    const texts = textNodesOf(scene);
    const oldest = texts.find((t) => t.text.includes('msg number 1'))!;
    const middle = texts.find((t) => t.text.includes('msg number 2'))!;
    const newest = texts.find((t) => t.text.includes('msg number 3'))!;
    expect(oldest).toBeTruthy();
    expect(middle).toBeTruthy();
    expect(newest).toBeTruthy();
    expect(oldest.y).toBeLessThan(middle.y);
    expect(middle.y).toBeLessThan(newest.y);
  });

  it('keeps the underlying newest-first array untouched (only the display order is reversed)', async () => {
    const scene = buildScene(1200, 950, makeMessagesNewestFirst(3));
    await flush(scene);

    expect(scene.messages[0].body).toBe('msg number 3'); // still newest-first internally
    expect(scene.messages[2].body).toBe('msg number 1');
  });
});

describe('FamilyScene — channel scroll clip (no header overlap while scrolling)', () => {
  it('draws the channel rows inside a masked container instead of directly on bodyLayer', async () => {
    const scene = buildScene(1200, 950, makeMessagesNewestFirst(20));
    await flush(scene);
    scene.render();

    const masked = maskedContainersOf(scene);
    expect(masked.length).toBeGreaterThan(0);
  });

  it('a row scrolled to straddle the top boundary stays inside the masked container (nothing is drawn straight onto bodyLayer, unclipped, above it)', async () => {
    const scene = buildScene(1200, 950, makeMessagesNewestFirst(20));
    await flush(scene);
    // Half a row of scroll — the classic "row straddles the fold" case that used to bleed
    // upward into the header/tab band above the channel list before the mask was added.
    scene.scrollYChannel = Math.round(scene.rowH / 2);
    scene.render();

    // Every Text node belonging to a channel message ("msg number N") must live under the
    // masked list container, not as a direct, unclipped child of bodyLayer.
    const maskedSet = new Set(maskedContainersOf(scene));
    const isUnderAMaskedContainer = (node: PIXI.DisplayObject): boolean => {
      let p: PIXI.Container | null = node.parent;
      while (p && p !== scene.bodyLayer) {
        if (maskedSet.has(p)) return true;
        p = p.parent;
      }
      return false;
    };
    const channelTexts = textNodesOf(scene).filter((t) => t.text.includes('msg number'));
    expect(channelTexts.length).toBeGreaterThan(0);
    for (const t of channelTexts) expect(isUnderAMaskedContainer(t)).toBe(true);
  });
});

describe('FamilyScene — send scrolls to the newest message (bottom), not the top', () => {
  it('scrolls the channel to the bottom after an optimistic send, since the newest message is now the last one, not the first', async () => {
    // Enough messages that the list overflows the viewport, so "scroll to bottom" is meaningfully
    // different from "scroll stayed at 0".
    const scene = buildScene(1200, 950, makeMessagesNewestFirst(20));
    await flush(scene);
    scene.render();
    expect(scene.scrollYChannel).toBe(0);

    // Don't await: submitMessage() runs the optimistic prepend + render() synchronously before its
    // first `await` (the network send) — asserting on the settled promise would instead observe the
    // state AFTER loadChannel() has replaced `messages` with the mocked (pre-send) server response.
    void scene.submitMessage('hello family!');

    expect(scene.scrollYChannel).toBeGreaterThan(0);
    // The optimistic echo is visible at the bottom (largest y among channel rows), not the top.
    const texts = textNodesOf(scene);
    const sentBody = texts.find((t) => t.text === ': hello family!')!;
    const channelBodies = texts.filter((t) => t.text.startsWith(': msg number') || t.text === ': hello family!');
    expect(sentBody).toBeTruthy();
    const maxY = Math.max(...channelBodies.map((t) => t.y));
    expect(sentBody.y).toBe(maxY);
  });
});

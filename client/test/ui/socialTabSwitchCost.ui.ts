// What a social tab switch is allowed to cost (social-tab-switch-cost, 2026-08-20).
//
// The social hub used to be noticeably jankier to tab around than the game's other multi-tab pages
// (equipment / shop / FamilyScene's own members-vs-channel rail), all of which switch tabs with a
// plain local state assignment plus one render(). FriendsScene had bolted two extra jobs onto the
// same tap:
//
//   1. switchTab() fired an unconditional net.refresh() — four concurrent requests (friends,
//      requests, mail, conversations) on every tap, including onto tabs that read none of them —
//      and refresh()'s finally then forced a *second*, network-delayed full rebuild on top of the
//      one switchTab had already done. With most of those re-pulls returning identical data, that
//      second rebuild was a pure flash over whatever the player was already looking at.
//   2. render() itself was re-run in full (tearDownChildren + rebuild every Text/Graphics/Sprite)
//      by a 0.5s caret blink and a 1s duel-invite countdown, neither of which changes more than one
//      string.
//
// These tests pin the fixes: a tab switch only re-pulls what the target tab reads and only when it's
// actually stale, an unchanged re-pull doesn't repaint, and the two timer ticks mutate one Text each.
// Scroll's equivalent (translate the built layer instead of rebuilding it) is pinned next door in
// scrollDragThrottle.ui.ts.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import type { FriendView } from '../../src/net/ApiClient';

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

function makeFriends(n: number): FriendView[] {
  return Array.from({ length: n }, (_, i) => ({
    publicId: String(100000000 + i), displayName: `Friend${i}`, online: i % 2 === 0,
  }));
}

/** Counts every request refresh() makes, so a tab switch's real network cost is observable. */
function buildScene(overrides: Partial<FriendsSceneCallbacks> = {}) {
  const calls = { friends: 0, requests: 0, mail: 0, conversations: 0, world: 0 };
  const friends = makeFriends(12);
  const scene = new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    myPublicId: '', getProfileExtra: async () => ({}),
    loadFriends: async () => { calls.friends++; return friends; },
    loadRequests: async () => { calls.requests++; return { incoming: [], outgoing: [] }; },
    loadMail: async () => { calls.mail++; return { mail: [], unread: 0 }; },
    loadConversations: async () => { calls.conversations++; return []; },
    loadWorldChat: async () => { calls.world++; return []; },
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    openChat() {},
    markMailRead: async () => {}, claimMail: async () => true, deleteMail: async () => {},
    ...overrides,
  }) as any;
  return { scene, calls };
}

/** Drain the microtask queue so the constructor's refresh() (and any it kicked off) has settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/**
 * Swap the render callback every panel and NetworkPanel goes through (core.render, injected by the
 * FriendsScene assembly) for a counter. Replacing that rather than spying on the scene's own private
 * render keeps the assertions about "did anything ask for a repaint", which is the thing being fixed.
 */
function countRenders(scene: any): { calls: () => number } {
  const spy = vi.fn();
  scene.core.render = spy;
  return { calls: () => spy.mock.calls.length };
}

describe('social tab switch — network cost', () => {
  it('switching to the world channel does not re-pull friends/requests/mail/conversations', async () => {
    const { scene, calls } = buildScene();
    await settle();
    // The constructor's one initial refresh is the baseline every tab switch is measured against.
    expect(calls).toEqual({ friends: 1, requests: 1, mail: 1, conversations: 1, world: 0 });

    scene.core.switchTab('world');
    await settle();

    // Only the world channel's own history — none of refresh()'s four, which that tab never reads.
    expect(calls).toEqual({ friends: 1, requests: 1, mail: 1, conversations: 1, world: 1 });
    scene.destroy();
  });

  it('bouncing between friends and mail does not re-pull on every tap', async () => {
    const { scene, calls } = buildScene();
    await settle();

    for (let i = 0; i < 4; i++) {
      scene.core.switchTab('mail');
      scene.core.switchTab('friends');
      await settle();
    }

    // Both tabs read refresh()'s payload, but it was pulled moments ago and gateway pushes keep it
    // live — so the staleness window holds, and 8 taps cost nothing. Pre-fix: 8 × 4 = 32 requests.
    expect(calls.friends).toBe(1);
    expect(calls.mail).toBe(1);
    scene.destroy();
  });

  it('a switch onto a data-reading tab does re-pull once the payload has gone stale', async () => {
    const { scene, calls } = buildScene();
    await settle();

    // Backdate past REFRESH_STALE_MS — the offline/backgrounded case, where no push ever arrived.
    scene.core.lastRefreshAt = Date.now() - 60_000;
    scene.core.switchTab('mail');
    await settle();

    expect(calls.mail).toBe(2);
    scene.destroy();
  });

  it('a refresh whose payload is unchanged does not repaint', async () => {
    const { scene } = buildScene();
    await settle();

    const renders = countRenders(scene);

    // Exactly what an inbound presence/mail push triggers: same data back, nothing to redraw.
    await scene.network.refresh();
    await settle();
    expect(renders.calls()).toBe(0);
    scene.destroy();
  });

  it('a refresh that actually changes something does repaint', async () => {
    let online = true;
    const { scene } = buildScene({
      loadFriends: async () => [{ publicId: '100000000', displayName: 'Friend0', online }],
    });
    await settle();

    const renders = countRenders(scene);

    online = false; // a friend went offline — the row's dot, border and status text all change
    await scene.network.refresh();
    await settle();
    expect(renders.calls()).toBe(1);
    scene.destroy();
  });
});

describe('social tab timers — one string, not the whole tree', () => {
  it("the caret blink mutates the focused field's Text instead of re-rendering", async () => {
    const { scene } = buildScene({
      loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: false }),
      createFamily: async () => {},
    });
    await settle();

    // Family tab, no family → the create form, with its name field focused.
    scene.core.tab = 'family';
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'world:1:0', isLeader: false };
    scene.core.familySubview = 'create';
    scene.core.familyCreateName = 'Ravens';
    scene.core.familyActiveInput = 'name';
    scene.render();

    const field = scene.core.repaint.caretField;
    expect(field).toBeTruthy();
    expect(field.obj.text).toBe('Ravens|'); // caretOn starts true

    const renders = countRenders(scene);

    scene.update(0.6); // past the 0.5s blink interval
    expect(renders.calls()).toBe(0);
    expect(scene.core.repaint.caretField.obj).toBe(field.obj); // same Text object, new string
    expect(field.obj.text).toBe('Ravens');

    scene.update(0.6);
    expect(renders.calls()).toBe(0);
    expect(field.obj.text).toBe('Ravens|');
    scene.destroy();
  });

  it('the duel-invite countdown mutates its own label instead of re-rendering', async () => {
    const { scene } = buildScene();
    await settle();

    scene.core.applyDuelInvited({ inviteId: 'inv1', fromPublicId: '100000000', fromName: 'Friend0' });
    const label = scene.core.repaint.duelBannerLabel;
    expect(label).toBeTruthy();
    const before = label.text;

    const renders = countRenders(scene);

    // The banner shows `expiresAt - serverNow()`, and serverNow() doesn't move under vitest — so
    // bring the deadline forward instead of trying to advance the clock. Same code path either way:
    // tickDuelBanner recomputes the remaining seconds from exactly these two values.
    scene.core.incomingDuelInvite.expiresAt -= 3_000;
    scene.update(1.1); // past the 1s countdown tick

    expect(renders.calls()).toBe(0);
    expect(scene.core.repaint.duelBannerLabel).toBe(label);
    expect(label.text).not.toBe(before); // three fewer seconds, same Text object
    scene.destroy();
  });
});

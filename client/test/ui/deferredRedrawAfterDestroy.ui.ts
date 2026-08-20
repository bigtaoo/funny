// Runtime companion to test/textureLoadedGuardCallSites.test.ts, which is purely static: it proves
// a `if (…destroyed|dead…) return` is written at the top of each redraw entry, but not that the
// guard actually stops the redraw. These tests destroy the scene and then fire the deferred entry
// for real, so a guard that is present but ineffective (wrong flag, set too late, a teardown step
// running before the flag flips) still fails.
//
// ⚠️ These assert that the redraw produced NOTHING, not that it didn't throw — "didn't throw" is
// far too weak to detect a missing guard here, and asserting it would have made this whole file
// vacuous. PIXI7's Container.destroy() empties `children` rather than nulling it, so on a destroyed
// container addChild / removeChild / tearDownChildren all run harmlessly; what actually throws is
// reading a transform-derived property (`sprite.scale`, `.x`, `.rotation`) off a destroyed display
// object, which is why the 2026-08-15 IntroScene freeze threw and these two entries do not. So an
// unguarded redraw here is waste and texture churn, not (by itself) a ticker-killer — but it
// repopulates a container the scene has already torn down, which is both observable and exactly
// what the guard is supposed to prevent. Verified to bite: deleting either guard turns the matching
// test red.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { CardInstance } from '../../src/game/meta/SaveData';
import type { MailView } from '../../src/net/ApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1920, 1080];

// ── CardScene: core.feedRedraw (the fuse panel's own redraw closure) ──────────────────────────

function makeCard(id: string, defId: string, overrides: Partial<CardInstance> = {}): CardInstance {
  return { id, defId, level: 1, gear: {}, locked: false, ...overrides };
}

function cardCb(cardInv: Record<string, CardInstance>): CardCallbacks {
  return {
    onBack() {},
    getSave: () => ({ cardInv, equipmentInv: {}, wallet: { coins: 0 } } as unknown as ReturnType<CardCallbacks['getSave']>),
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
  };
}

describe('CardScene: the fuse panel redraw is inert after destroy()', () => {
  it('core.feedRedraw() after destroy() draws nothing back into the torn-down modalLayer', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 3; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const scene = new CardScene(createLayout(W, H), new InputManager(), cardCb(cardInv));
    const priv = scene as unknown as {
      feed: { openFuseSelect: (c: CardInstance) => void };
      core: { feedRedraw: (() => void) | null; modalLayer: PIXI.Container };
    };
    priv.feed.openFuseSelect(target);

    // Premise: opening the ring is what installs drawFusePanel as core.feedRedraw. destroy() never
    // nulls it, which is exactly why the closure needs its own guard — CardScene.render()'s guard
    // does not cover this entry point.
    expect(priv.core.feedRedraw).toBeTypeOf('function');
    const redraw = priv.core.feedRedraw!;

    scene.destroy();
    expect(priv.core.modalLayer.destroyed).toBe(true);
    expect(priv.core.modalLayer.children.length).toBe(0);

    redraw();

    // Unguarded, drawFusePanel repopulates the ring/list straight back into the destroyed layer.
    expect(priv.core.modalLayer.children.length).toBe(0);
  });
});

// ── FriendsScene: core.render() (mail card art's 'loaded' hook, fetch completions, …) ─────────

function unreadMail(id: string): MailView {
  return {
    mailId: id, from: 'system', subject: 'Hello', body: 'hi',
    createdAt: 1000, expireAt: 999999999999, read: false, claimed: false,
  } as unknown as MailView;
}

function buildFriends(): FriendsScene {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new FriendsScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenRoom() {},
    myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    loadConversations: async () => [],
    openChat() {},
    loadMail: async () => ({ mail: [unreadMail('m1')], unread: 1 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
    defaultTab: 'mail',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe('FriendsScene: render() is inert after destroy()', () => {
  it('core.render() after destroy() draws nothing back into the torn-down container', async () => {
    const scene = buildFriends();
    await Promise.resolve();
    await Promise.resolve();

    const core = (scene as unknown as { core: { render: () => void; dead: boolean; container: PIXI.Container } }).core;
    expect(core.dead).toBe(false); // premise: alive before destroy, so the no-op below is the guard's doing

    scene.destroy();
    expect(core.container.destroyed).toBe(true);
    expect(core.container.children.length).toBe(0);

    core.render();

    // Unguarded, beginRender() re-adds the paper background + decor + header to the destroyed
    // container. endRender()'s own `dead` check stops the popup/modal re-attach at the tail, but
    // nothing stops the head — which is why the guard belongs in render(), ahead of beginRender().
    expect(core.container.children.length).toBe(0);
  });
});

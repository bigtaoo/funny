// Coverage for the 2026-07-25 Friends-screen additions (ADR friends-duel-confirm):
// (1) removing a friend now confirms via the shared ConfirmDialog instead of firing immediately;
// (2) a duel ("切磋") invite/response flow that reuses matchsvc's existing match-start path —
//     the client side only needs to track "do I have an outstanding sent invite" and
//     "is there an incoming one to show", both driven by the pushed applyDuelInvited/applyDuelCancelled.
//
// Follows this suite's established direct-field-access pattern for confirm modals / actions
// (see scenes.ui.ts's EquipmentScene modalHits/instanceActions tests, familyJoinApproval.ui.ts's
// modalHits filter-by-rect-width) rather than simulating pixel-perfect taps.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t, type TranslationKey } from '../../src/i18n';
import { FriendsScene, type FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import type { FriendView } from '../../src/net/ApiClient';
import * as log from '../../src/net/log';
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

interface Spies {
  removeFriend: ReturnType<typeof vi.fn>;
  duelInvite: ReturnType<typeof vi.fn>;
  duelRespond: ReturnType<typeof vi.fn>;
}

function buildFriendsScene(friends: FriendView[]): { scene: FriendsScene; spies: Spies } {
  const spies: Spies = {
    removeFriend: vi.fn(async () => {}),
    duelInvite: vi.fn(),
    duelRespond: vi.fn(),
  };
  const { openTextInput } = createFakeTextInput();
  const cb: FriendsSceneCallbacks = {
    onBack() {},
    onOpenRoom() {},
    openTextInput,
    myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => friends,
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: spies.removeFriend,
    blockUser: async () => {}, reportUser: async () => {},
    duelInvite: spies.duelInvite,
    duelRespond: spies.duelRespond,
    loadConversations: async () => [],
    openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
  };
  const scene = new FriendsScene(createLayout(W, H), new InputManager(), cb);
  return { scene, spies };
}

/** Flush the refresh() microtasks the constructor fires so loadFriends() has actually landed. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('FriendsScene — remove-friend confirm dialog', () => {
  it('✕ opens a confirm modal instead of removing immediately', async () => {
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: true }];
    const { scene, spies } = buildFriendsScene(friends);
    await flush();

    (scene as unknown as { friendsList: { confirmRemove(id: string, name: string): void } }).friendsList.confirmRemove('100000001', 'Alice');
    expect((scene as any).core.modalOpen).toBe(true);
    expect(spies.removeFriend).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('Cancel leaves the friend untouched and closes the modal', async () => {
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: true }];
    const { scene, spies } = buildFriendsScene(friends);
    await flush();

    (scene as unknown as { friendsList: { confirmRemove(id: string, name: string): void } }).friendsList.confirmRemove('100000001', 'Alice');
    const modalHits = (scene as any).core.modalHits as Array<{ fn: () => void }>;
    expect(modalHits).toHaveLength(2); // drawConfirmDialog returns [OK, Cancel]
    modalHits[1].fn(); // Cancel

    expect((scene as any).core.modalOpen).toBe(false);
    expect(spies.removeFriend).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('OK calls removeFriend with the right publicId and closes the modal', async () => {
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: true }];
    const { scene, spies } = buildFriendsScene(friends);
    await flush();

    (scene as unknown as { friendsList: { confirmRemove(id: string, name: string): void } }).friendsList.confirmRemove('100000001', 'Alice');
    const modalHits = (scene as any).core.modalHits as Array<{ fn: () => void }>;
    modalHits[0].fn(); // OK
    await flush();

    expect(spies.removeFriend).toHaveBeenCalledWith('100000001');
    expect((scene as any).core.modalOpen).toBe(false);
    scene.destroy();
  });

  it("the confirm message names the friend being removed", async () => {
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: true }];
    const { scene } = buildFriendsScene(friends);
    await flush();

    (scene as unknown as { friendsList: { confirmRemove(id: string, name: string): void } }).friendsList.confirmRemove('100000001', 'Alice');
    const modalLayer = (scene as any).core.modalLayer as { children: Array<{ text?: string }> };
    const label = modalLayer.children.find((c) => typeof c.text === 'string' && c.text.includes('Alice'));
    expect(label).toBeDefined();
    scene.destroy();
  });

  it('the ✕ button on a rendered friend row routes through confirmRemove, not doRemove directly', async () => {
    // Locate the ✕ hit by its exact geometry (drawFriendRow: xW = round(rh*0.62), rh = round(h*0.10))
    // and fire it, proving the wiring end-to-end rather than just unit-testing confirmRemove in isolation.
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: true }];
    const { scene, spies } = buildFriendsScene(friends);
    await flush();

    const h = (scene as any).core.h as number;
    const rh = Math.round(h * 0.10);
    const xW = Math.round(rh * 0.62);
    const hits = (scene as any).core.hits as Array<{ rect: { w: number; h: number }; fn: () => void }>;
    const removeHit = hits.find((hit) => Math.round(hit.rect.w) === xW && Math.round(hit.rect.h) === xW);
    expect(removeHit).toBeDefined();

    removeHit!.fn();
    expect((scene as any).core.modalOpen).toBe(true);
    expect(spies.removeFriend).not.toHaveBeenCalled(); // confirm first, not an immediate delete
    scene.destroy();
  });
});

describe('FriendsScene — duel invite ("切磋")', () => {
  it('doDuel sends the invite and marks it pending', async () => {
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: true }];
    const { scene, spies } = buildFriendsScene(friends);
    await flush();

    (scene as unknown as { network: { doDuel(id: string): void } }).network.doDuel('100000001');
    expect(spies.duelInvite).toHaveBeenCalledWith('100000001');
    expect((scene as any).core.sendingDuelTo).toBe('100000001');
    scene.destroy();
  });

  it('while an invite is pending, EVERY friend row\'s duel button is disabled — not just the invited one', async () => {
    const friends: FriendView[] = [
      { publicId: '100000001', displayName: 'Alice', online: true },
      { publicId: '100000002', displayName: 'Bob', online: true },
    ];
    const { scene, spies } = buildFriendsScene(friends);
    await flush();

    (scene as unknown as { network: { doDuel(id: string): void } }).network.doDuel('100000001'); // re-renders internally
    expect(spies.duelInvite).toHaveBeenCalledTimes(1);

    const h = (scene as any).core.h as number;
    const rh = Math.round(h * 0.10);
    const duelW = Math.round(rh * 1.7);
    const hits = (scene as any).core.hits as Array<{ rect: { w: number }; fn: () => void }>;
    const duelHits = hits.filter((hit) => Math.round(hit.rect.w) === duelW);
    expect(duelHits).toHaveLength(2); // one per friend row, including the one already invited

    for (const hit of duelHits) hit.fn();
    expect(spies.duelInvite).toHaveBeenCalledTimes(1); // unchanged — every row is a no-op while one is in flight
    scene.destroy();
  });

  it('an offline friend\'s duel button is a no-op even with no invite in flight', async () => {
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: false }];
    const { scene, spies } = buildFriendsScene(friends);
    await flush();

    const h = (scene as any).core.h as number;
    const rh = Math.round(h * 0.10);
    const duelW = Math.round(rh * 1.7);
    const hits = (scene as any).core.hits as Array<{ rect: { w: number }; fn: () => void }>;
    const duelHit = hits.find((hit) => Math.round(hit.rect.w) === duelW);
    expect(duelHit).toBeDefined();

    duelHit!.fn();
    expect(spies.duelInvite).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('doDuelRespond clears the incoming banner and forwards accept/decline to the callback', async () => {
    const { scene, spies } = buildFriendsScene([]);
    await flush();
    (scene as any).core.incomingDuelInvite = { inviteId: 'inv-1', fromPublicId: '100000009', fromName: 'Carl', expiresAt: Date.now() + 60_000 };

    (scene as unknown as { network: { doDuelRespond(id: string, accept: boolean): void } }).network.doDuelRespond('inv-1', true);
    expect(spies.duelRespond).toHaveBeenCalledWith('inv-1', true);
    expect((scene as any).core.incomingDuelInvite).toBeNull();
    scene.destroy();
  });

  it('applyDuelInvited renders an accept/decline banner with real, clickable hits', async () => {
    const { scene, spies } = buildFriendsScene([]);
    await flush();

    (scene as any).applyDuelInvited({ inviteId: 'inv-2', fromPublicId: '100000009', fromName: 'Carl' });
    expect((scene as any).core.incomingDuelInvite).toMatchObject({ inviteId: 'inv-2', fromPublicId: '100000009', fromName: 'Carl' });

    // drawDuelInviteBanner's Accept/Reject share drawRequestRow's button geometry (bW = round(cW*0.18));
    // this fixture has zero pending friend requests, so these two hits are unambiguously the banner's.
    const cW = (scene as any).core.cW as number;
    const bW = Math.round(cW * 0.18);
    const hits = (scene as any).core.hits as Array<{ rect: { w: number }; fn: () => void }>;
    const bannerHits = hits.filter((hit) => Math.round(hit.rect.w) === bW);
    expect(bannerHits).toHaveLength(2); // [accept, reject]

    bannerHits[0]!.fn(); // accept
    expect(spies.duelRespond).toHaveBeenCalledWith('inv-2', true);
    scene.destroy();
  });

  it('a locally-expired banner (60s countdown) hides itself on the next update() tick without a server round trip', async () => {
    const { scene } = buildFriendsScene([]);
    await flush();
    (scene as any).applyDuelInvited({ inviteId: 'inv-3', fromPublicId: '100000009', fromName: 'Carl' });
    expect((scene as any).core.incomingDuelInvite).not.toBeNull();

    (scene as any).core.incomingDuelInvite.expiresAt = Date.now() - 1; // simulate the 60s window having elapsed
    scene.update(1 / 60);
    expect((scene as any).core.incomingDuelInvite).toBeNull();
    scene.destroy();
  });

  it('applyDuelCancelled re-enables the sender', async () => {
    const friends: FriendView[] = [{ publicId: '100000001', displayName: 'Alice', online: true }];
    const { scene } = buildFriendsScene(friends);
    await flush();
    (scene as unknown as { network: { doDuel(id: string): void } }).network.doDuel('100000001');
    expect((scene as any).core.sendingDuelTo).toBe('100000001');

    (scene as any).applyDuelCancelled({ inviteId: 'whatever', reason: 'declined' });
    expect((scene as any).core.sendingDuelTo).toBeNull();
    scene.destroy();
  });

  it('applyDuelCancelled(reason=busy) clears the invitee\'s own incoming banner (matchmaking-mutex-audit, 2026-08-12: this reason is pushed to the invitee, not the inviter)', async () => {
    const { scene } = buildFriendsScene([]);
    await flush();
    (scene as any).applyDuelInvited({ inviteId: 'inv-4', fromPublicId: '100000009', fromName: 'Carl' });
    expect((scene as any).core.incomingDuelInvite).not.toBeNull();

    (scene as any).applyDuelCancelled({ inviteId: 'inv-4', reason: 'busy' });
    expect((scene as any).core.incomingDuelInvite).toBeNull();
    scene.destroy();
  });

  it.each([
    ['declined', 'friends.duel.declined'],
    ['timeout', 'friends.duel.timeout'],
    ['offline', 'friends.duel.offline'],
    ['not_found', 'friends.duel.notFound'],
    ['busy', 'friends.duel.busy'], // matchmaking-mutex-audit, 2026-08-12: either side already in room/queue
    ['some-unrecognized-reason', 'friends.duel.notFound'], // unknown reason falls back to notFound
  ] as const)('applyDuelCancelled(reason=%s) toasts %s', async (reason, key) => {
    const { scene } = buildFriendsScene([]);
    await flush();
    const spy = vi.spyOn(log, 'showToastMessage');

    (scene as any).applyDuelCancelled({ inviteId: 'x', reason });
    expect(spy).toHaveBeenCalledWith(t(key as TranslationKey), 'error');

    spy.mockRestore();
    scene.destroy();
  });
});

// Regression test for "re-tapping the active Mail tab while a mail is open must return to
// the mail list" (20.07.2026). switchTab() used to early-return whenever the tapped tab was
// already active, so tapping Mail again while a detail view was open (openMailItem set) did
// nothing — the only way back was the header Back button. Fixed by clearing openMailItem
// (and re-rendering) on a same-tab re-tap instead of no-op'ing.
//
// The first cut of this fix landed dead code: drawSidebarTabs() emitted NO hit rect for the
// active cell, so the tap never reached switchTab() at all — calling switchTab('mail')
// directly (as the original test did) passed while the real app stayed broken. So these tests
// drive the ACTUAL input path (_emitDown/_emitUp on the Mail rail cell) through the scene's own
// hit-testing, which only works once the active-cell hit rect exists (activeTappable option).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { sidebarNavW, bottomNavH } from '../../src/ui/widgets/HubTabs';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { MailView } from '../../src/net/ApiClient';
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

const mail: MailView = {
  mailId: 'plain:a', from: 'system', subject: 'Hello', body: 'hi',
  createdAt: 1000, expireAt: 999999999999, read: true, claimed: false,
} as unknown as MailView;

type HitRect = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };

// The [800, 1280] fixture below is portrait (w < h → scene.core.landscape === false), so
// drawSocialTabRail renders the 5 tabs as the bottom nav bar (drawBottomNavTabs, LOBBY_IA_
// REDESIGN.md §18/§20), not the old left sidebar rail — its cells are full-bar-height (y ===
// navTop, h === barH) rather than full-width (x === 0, w === railW). Branch on scene.core.landscape
// so this still works if the fixture ever changes to a landscape size. railW/barH are read off
// the scene's own design dims — createLayout maps to a canonical 1080x1920, not the ctor args.
function railHitsOf(scene: any): HitRect[] {
  if (scene.core.landscape) {
    const railW = sidebarNavW(scene.core.w, scene.core.h, scene.core.landscape);
    return (scene.core.hits as HitRect[]).filter((hp) => hp.rect.x === 0 && hp.rect.w === railW);
  }
  const barH = bottomNavH(scene.core.h);
  const navTop = scene.core.h - barH;
  return (scene.core.hits as HitRect[]).filter((hp) => hp.rect.y === navTop && hp.rect.h === barH);
}

// Center of the Mail rail cell, read off the scene's actual hit rects rather than recomputed
// geometry (easy to get subtly wrong). Mail is the last of the 5 tabs (TAB_DEFS order in
// socialTabRail.ts): bottom-most cell in the sidebar's vertical stack (landscape), or
// right-most cell in the bottom bar's horizontal strip (portrait — this fixture).
function mailCellCenter(scene: any): { x: number; y: number } {
  const railHits = railHitsOf(scene);
  const mailHit = scene.core.landscape
    ? railHits.reduce((lo, hp) => (hp.rect.y > lo.rect.y ? hp : lo), railHits[0]!)
    : railHits.reduce((lo, hp) => (hp.rect.x > lo.rect.x ? hp : lo), railHits[0]!);
  return { x: mailHit.rect.x + mailHit.rect.w / 2, y: mailHit.rect.y + mailHit.rect.h / 2 };
}

function build(): { scene: any; input: InputManager } {
  const input = new InputManager();
  const { openTextInput } = createFakeTextInput();
  const scene = new FriendsScene(createLayout(W, H), input, {
    onBack() {}, onOpenRoom() {},
    openTextInput,
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
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {},
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
    defaultTab: 'mail',
  });
  return { scene, input };
}

// Simulate a real tap (down+up at the same point) so it flows through the scene's own hit-testing.
function tap(input: InputManager, x: number, y: number): void {
  input._emitDown(x, y);
  input._emitUp(x, y);
}

describe('FriendsScene — re-tapping the active Mail tab while a mail is open', () => {
  it('emits a hit rect for every rail tab incl. the active one (so a tap can reach it)', () => {
    const { scene } = build();
    scene.core.openMailItem = mail;
    scene.render();
    // The bug: drawSidebarTabs emitted no hit for the ACTIVE cell, so with Mail active only 4 of
    // the 5 tabs were tappable and re-tapping Mail could never reach switchTab().
    expect(railHitsOf(scene).length).toBe(5);
    scene.destroy();
  });

  it('clears openMailItem and returns to the list', () => {
    const { scene, input } = build();
    scene.core.openMailItem = mail;
    scene.render();
    expect(scene.core.tab).toBe('mail');
    expect(scene.core.openMailItem).toBe(mail);

    const { x, y } = mailCellCenter(scene);
    tap(input, x, y); // re-tap the tab that's already active, through real hit-testing

    expect(scene.core.tab).toBe('mail');       // stayed on Mail (didn't switch to another tab)
    expect(scene.core.openMailItem).toBeNull(); // detail closed → back to the list
    scene.destroy();
  });

  it('re-tapping a tab with no mail open is still a no-op (no spurious reload)', () => {
    const { scene, input } = build();
    scene.render();
    expect(scene.core.openMailItem).toBeNull();

    const { x, y } = mailCellCenter(scene);
    tap(input, x, y);

    expect(scene.core.openMailItem).toBeNull();
    expect(scene.core.tab).toBe('mail');
    scene.destroy();
  });

  it('switching to a different tab still clears openMailItem as before', () => {
    const { scene } = build();
    scene.core.openMailItem = mail;
    scene.render();

    scene.core.switchTab('friends');

    expect(scene.core.tab).toBe('friends');
    expect(scene.core.openMailItem).toBeNull();
    scene.destroy();
  });
});

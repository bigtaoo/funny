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
import { sidebarNavW } from '../../src/ui/widgets/HubTabs';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
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

const [W, H] = [800, 1280];

const mail: MailView = {
  mailId: 'plain:a', from: 'system', subject: 'Hello', body: 'hi',
  createdAt: 1000, expireAt: 999999999999, read: true, claimed: false,
} as unknown as MailView;

type HitRect = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };

// The 5 tab cells are the full-width left-rail cells (x === 0, w === railW); everything else
// (header back button w<railW, content-column buttons x>railW) is excluded. railW is read off
// the scene's own design dims — createLayout maps to a canonical 1080x1920, not the ctor args.
function railHitsOf(scene: any): HitRect[] {
  const railW = sidebarNavW(scene.w, scene.h, scene.landscape);
  return (scene.hits as HitRect[]).filter((hp) => hp.rect.x === 0 && hp.rect.w === railW);
}

// Center of the Mail rail cell, read off the scene's actual hit rects rather than recomputed
// geometry (easy to get subtly wrong). Mail is the bottom-most of the 5 rail cells.
function mailCellCenter(scene: any): { x: number; y: number } {
  const railHits = railHitsOf(scene);
  const mailHit = railHits.reduce((lo, hp) => (hp.rect.y > lo.rect.y ? hp : lo), railHits[0]!);
  return { x: mailHit.rect.x + mailHit.rect.w / 2, y: mailHit.rect.y + mailHit.rect.h / 2 };
}

function build(): { scene: any; input: InputManager } {
  const input = new InputManager();
  const scene = new FriendsScene(createLayout(W, H), input, {
    onBack() {}, onOpenRoom() {},
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
    addFriend: async () => {},
    respond: async () => {},
    removeFriend: async () => {},
    blockUser: async () => {},
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
    scene.openMailItem = mail;
    scene.render();
    // The bug: drawSidebarTabs emitted no hit for the ACTIVE cell, so with Mail active only 4 of
    // the 5 tabs were tappable and re-tapping Mail could never reach switchTab().
    expect(railHitsOf(scene).length).toBe(5);
    scene.destroy();
  });

  it('clears openMailItem and returns to the list', () => {
    const { scene, input } = build();
    scene.openMailItem = mail;
    scene.render();
    expect(scene.tab).toBe('mail');
    expect(scene.openMailItem).toBe(mail);

    const { x, y } = mailCellCenter(scene);
    tap(input, x, y); // re-tap the tab that's already active, through real hit-testing

    expect(scene.tab).toBe('mail');       // stayed on Mail (didn't switch to another tab)
    expect(scene.openMailItem).toBeNull(); // detail closed → back to the list
    scene.destroy();
  });

  it('re-tapping a tab with no mail open is still a no-op (no spurious reload)', () => {
    const { scene, input } = build();
    scene.render();
    expect(scene.openMailItem).toBeNull();

    const { x, y } = mailCellCenter(scene);
    tap(input, x, y);

    expect(scene.openMailItem).toBeNull();
    expect(scene.tab).toBe('mail');
    scene.destroy();
  });

  it('switching to a different tab still clears openMailItem as before', () => {
    const { scene } = build();
    scene.openMailItem = mail;
    scene.render();

    scene.switchTab('friends');

    expect(scene.tab).toBe('friends');
    expect(scene.openMailItem).toBeNull();
    scene.destroy();
  });
});

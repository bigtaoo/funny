// Regression test for "re-tapping the active Mail tab while a mail is open must return to
// the mail list" (20.07.2026). switchTab() used to early-return whenever the tapped tab was
// already active, so tapping Mail again while a detail view was open (openMailItem set) did
// nothing — the only way back was the header Back button. Fixed by clearing openMailItem
// (and re-rendering) on a same-tab re-tap instead of no-op'ing.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
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

function build(): any {
  return new FriendsScene(createLayout(W, H), new InputManager(), {
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
}

describe('FriendsScene — re-tapping the active Mail tab while a mail is open', () => {
  it('clears openMailItem and returns to the list', () => {
    const scene = build();
    scene.openMailItem = mail;
    scene.render();
    expect(scene.tab).toBe('mail');
    expect(scene.openMailItem).toBe(mail);

    scene.switchTab('mail'); // re-tap the tab that's already active

    expect(scene.openMailItem).toBeNull();
    scene.destroy();
  });

  it('re-tapping a tab with no mail open is still a no-op (no spurious reload)', () => {
    const scene = build();
    scene.render();
    expect(scene.openMailItem).toBeNull();

    scene.switchTab('mail');

    expect(scene.openMailItem).toBeNull();
    expect(scene.tab).toBe('mail');
    scene.destroy();
  });

  it('switching to a different tab still clears openMailItem as before', () => {
    const scene = build();
    scene.openMailItem = mail;
    scene.render();

    scene.switchTab('friends');

    expect(scene.tab).toBe('friends');
    expect(scene.openMailItem).toBeNull();
    scene.destroy();
  });
});

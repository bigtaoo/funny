// Regression test for the "mail with an unclaimed attachment must not be deletable" rule (16.07.2026).
//
// deleteMail on the server now rejects mail whose attachment hasn't been claimed yet
// (MAIL_HAS_UNCLAIMED_ATTACHMENT), since a straight deleteOne would silently discard the
// attachment with no compensation. The client mirrors that at the UI layer: the mail-detail
// "Delete" button is disabled (greyed, toast-only) while an attachment is unclaimed, and
// doMailDelete() also handles the server rejecting it defensively (belt and suspenders).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { bottomNavH } from '../../src/ui/widgets/HubTabs';
import { initI18n, t } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { MailView } from '../../src/net/ApiClient';
import { setToastSink } from '../../src/net/log';
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

// FriendsScene toasts now route through the global sink (net/log) → GlobalToast, no longer a
// per-scene toastKey field. Capture what the scene emits so the "delete blocked" case can assert it.
const toastMsgs: string[] = [];
setToastSink((text) => { toastMsgs.push(text); });

const [W, H] = [800, 1280];

function build(opts: { deleteMail: (id: string) => Promise<void> }): any {
  const { openTextInput } = createFakeTextInput();
  return new FriendsScene(createLayout(W, H), new InputManager(), {
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
    deleteMail: opts.deleteMail,
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
  });
}

function deleteHit(scene: any): { rect: { x: number; y: number; w: number; h: number }; fn: () => void } {
  const hits = scene.core.hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
  // [800, 1280] below is portrait (w < h → scene.core.landscape === false), so drawSocialTabRail
  // renders the 5-tab bottom nav bar (LOBBY_IA_REDESIGN.md §18/§20) pinned to the very bottom of
  // the screen — bodyBottom (base.ts) reserves bottomNavH above it so the Delete button itself
  // sits higher up, but a naive "greatest y" pick still lands on a bottom-nav cell instead of
  // Delete, since the nav bar's y is closer to h. Exclude anything at/below the nav bar's top
  // edge before picking the bottom-most (Delete, addButton()'d last) of what's left.
  const navTop = scene.core.landscape ? Infinity : scene.core.h - bottomNavH(scene.core.h);
  const contentHits = hits.filter((hp) => hp.rect.y < navTop);
  return contentHits.reduce((a, b) => (b.rect.y > a.rect.y ? b : a));
}

const unclaimedGiftMail: MailView = {
  mailId: 'gift:a', from: 'system', subject: 'Gift', body: 'enjoy',
  createdAt: 1000, expireAt: 999999999999, read: true, claimed: false,
  attachments: [{ kind: 'coins', count: 100 }],
} as unknown as MailView;

const claimedGiftMail: MailView = { ...unclaimedGiftMail, claimed: true } as MailView;

const plainMail: MailView = {
  mailId: 'plain:a', from: 'system', subject: 'Hello', body: 'hi',
  createdAt: 1000, expireAt: 999999999999, read: true, claimed: false,
} as unknown as MailView;

describe('FriendsScene mail detail — delete blocked while an attachment is unclaimed', () => {
  it('unclaimed attachment: Delete tap toasts instead of deleting', () => {
    let deleteCalls = 0;
    const scene = build({ deleteMail: async () => { deleteCalls++; } });
    scene.core.openMailItem = unclaimedGiftMail;
    scene.render();

    deleteHit(scene).fn();

    expect(deleteCalls).toBe(0);
    expect(scene.core.openMailItem).toBe(unclaimedGiftMail); // detail stays open
    expect(toastMsgs[toastMsgs.length - 1]).toBe(t('mail.deleteBlockedAttachment'));
    scene.destroy();
  });

  it('claimed attachment: Delete tap calls deleteMail and closes the detail view', async () => {
    let deletedId: string | null = null;
    const scene = build({ deleteMail: async (id: string) => { deletedId = id; } });
    scene.core.openMailItem = claimedGiftMail;
    scene.render();

    deleteHit(scene).fn();
    await Promise.resolve(); await Promise.resolve();

    expect(deletedId).toBe('gift:a');
    expect(scene.core.openMailItem).toBeNull();
    scene.destroy();
  });

  it('no attachment: Delete tap calls deleteMail as before', async () => {
    let deletedId: string | null = null;
    const scene = build({ deleteMail: async (id: string) => { deletedId = id; } });
    scene.core.openMailItem = plainMail;
    scene.render();

    deleteHit(scene).fn();
    await Promise.resolve(); await Promise.resolve();

    expect(deletedId).toBe('plain:a');
    expect(scene.core.openMailItem).toBeNull();
    scene.destroy();
  });

  it('server rejects with MAIL_HAS_UNCLAIMED_ATTACHMENT: detail view stays open with the blocked toast', async () => {
    const scene = build({
      deleteMail: async () => { throw { code: 'MAIL_HAS_UNCLAIMED_ATTACHMENT' }; },
    });
    // Simulate the guard somehow missing client-side (defense in depth): call doMailDelete directly.
    scene.core.openMailItem = claimedGiftMail;
    await scene.network.doMailDelete(claimedGiftMail);

    expect(scene.core.openMailItem).toBe(claimedGiftMail);
    expect(toastMsgs[toastMsgs.length - 1]).toBe(t('mail.deleteBlockedAttachment'));
    scene.destroy();
  });
});

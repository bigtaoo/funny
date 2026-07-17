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
import { initI18n, t } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { MailView } from '../../src/net/ApiClient';
import { setToastSink } from '../../src/net/log';

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
    deleteMail: opts.deleteMail,
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
  });
}

function deleteHit(scene: any): { rect: { x: number; y: number; w: number; h: number }; fn: () => void } {
  const hits = scene.hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
  // Delete button is pinned to the bottom of the detail panel, addButton()'d last.
  return hits.reduce((a, b) => (b.rect.y > a.rect.y ? b : a));
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
    scene.openMailItem = unclaimedGiftMail;
    scene.render();

    deleteHit(scene).fn();

    expect(deleteCalls).toBe(0);
    expect(scene.openMailItem).toBe(unclaimedGiftMail); // detail stays open
    expect(toastMsgs[toastMsgs.length - 1]).toBe(t('mail.deleteBlockedAttachment'));
    scene.destroy();
  });

  it('claimed attachment: Delete tap calls deleteMail and closes the detail view', async () => {
    let deletedId: string | null = null;
    const scene = build({ deleteMail: async (id: string) => { deletedId = id; } });
    scene.openMailItem = claimedGiftMail;
    scene.render();

    deleteHit(scene).fn();
    await Promise.resolve(); await Promise.resolve();

    expect(deletedId).toBe('gift:a');
    expect(scene.openMailItem).toBeNull();
    scene.destroy();
  });

  it('no attachment: Delete tap calls deleteMail as before', async () => {
    let deletedId: string | null = null;
    const scene = build({ deleteMail: async (id: string) => { deletedId = id; } });
    scene.openMailItem = plainMail;
    scene.render();

    deleteHit(scene).fn();
    await Promise.resolve(); await Promise.resolve();

    expect(deletedId).toBe('plain:a');
    expect(scene.openMailItem).toBeNull();
    scene.destroy();
  });

  it('server rejects with MAIL_HAS_UNCLAIMED_ATTACHMENT: detail view stays open with the blocked toast', async () => {
    const scene = build({
      deleteMail: async () => { throw { code: 'MAIL_HAS_UNCLAIMED_ATTACHMENT' }; },
    });
    // Simulate the guard somehow missing client-side (defense in depth): call doMailDelete directly.
    scene.openMailItem = claimedGiftMail;
    await scene.doMailDelete(claimedGiftMail);

    expect(scene.openMailItem).toBe(claimedGiftMail);
    expect(toastMsgs[toastMsgs.length - 1]).toBe(t('mail.deleteBlockedAttachment'));
    scene.destroy();
  });
});

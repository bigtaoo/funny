// Regression coverage for the mail-tab unread badge not decrementing on read (2026-08-03 fix).
//
// Before: FriendsScene/mail.ts's openMail() flipped the individual mail's own `read` flag once
// markMailRead() resolved, but never adjusted `this.mailUnread` (the counter driving the Mail-tab
// dot / lobby mail-strip badge) — the badge stayed at its stale pre-read count until some other
// trigger forced a full refresh() (tab switch, inbound push). A player who read every mail without
// switching tabs still saw a nonzero unread badge.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

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

function unreadMail(id: string): MailView {
  return {
    mailId: id, from: 'system', subject: 'Hello', body: 'hi',
    createdAt: 1000, expireAt: 999999999999, read: false, claimed: false,
  } as unknown as MailView;
}

function build(mail: MailView[]): { scene: any; markCalls: string[] } {
  const markCalls: string[] = [];
  const input = new InputManager();
  const scene = new FriendsScene(createLayout(W, H), input, {
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
    loadMail: async () => ({ mail, unread: mail.filter((m) => !m.read).length }),
    markMailRead: async (id: string) => { markCalls.push(id); },
    claimMail: async () => true,
    deleteMail: async () => {},
    loadSLGStatus: async () => null,
    loadWorldChat: async () => [],
    sendWorldChat: async () => {},
    defaultTab: 'mail',
  } as any);
  return { scene, markCalls };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('FriendsScene — mail unread badge decrements immediately on read (2026-08-03 fix)', () => {
  it('opening an unread mail decrements mailUnread as soon as markMailRead resolves, without a full refresh()', async () => {
    const m1 = unreadMail('m1');
    const m2 = unreadMail('m2');
    const { scene, markCalls } = build([m1, m2]);
    await flush(); // load() resolves → mailUnread starts at 2

    expect(scene.mailUnread).toBe(2);

    scene.openMail(m1);
    expect(markCalls).toEqual(['m1']);
    await flush(); // markMailRead resolves synchronously-ish → the fix's decrement runs

    expect(m1.read).toBe(true);
    expect(scene.mailUnread).toBe(1); // decremented immediately, not stuck at 2 until a refresh()
    scene.destroy();
  });

  it('opening an already-read mail does not decrement (nothing to mark, no double-count)', async () => {
    const readMail: MailView = { ...unreadMail('m3'), read: true } as unknown as MailView;
    const { scene, markCalls } = build([readMail]);
    await flush();
    expect(scene.mailUnread).toBe(0);

    scene.openMail(readMail);
    await flush();

    expect(markCalls).toEqual([]); // markMailRead is only called for unread mail
    expect(scene.mailUnread).toBe(0);
    scene.destroy();
  });

  it('mailUnread never goes negative even if opened twice in quick succession', async () => {
    const m1 = unreadMail('m1');
    const { scene, markCalls } = build([m1]);
    await flush();
    expect(scene.mailUnread).toBe(1);

    scene.openMail(m1); // first open: marks read, will decrement to 0
    scene.openMail(m1); // second open: m1.read is still false locally until the first markMailRead resolves
    await flush();

    // Both opens race past the `!m.read` guard before either resolves, so markMailRead is
    // genuinely called twice here (this is the scenario the clamp below exists to survive —
    // asserting the exact call count keeps this test from passing regardless of whether the
    // clamp actually fired).
    expect(markCalls).toEqual(['m1', 'm1']);
    expect(scene.mailUnread).toBe(0); // clamped, not -1
    scene.destroy();
  });
});

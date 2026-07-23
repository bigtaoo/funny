// Regression test for the "world-map chat shortcut opens FriendsScene stuck on
// 'loading' forever" bug (14.07.2026).
//
// Root cause: nav.goFriends({ defaultTab: 'world' }) (used by the world-map chat
// shortcut, app/nav/world.ts) sets `cb.defaultTab` on FriendsSceneCallbacks. The
// FriendsSceneBase constructor applied `this.tab = cb.defaultTab` directly but
// never triggered loadWorldMessages()/loadSLGStatus() for that tab — only
// switchTab() did. Entering via the constructor's defaultTab path therefore left
// the world-chat tab rendering forever without ever calling loadWorldMessages().
// Fixed by factoring switchTab()'s load-trigger logic into a shared
// triggerTabLoads() helper called from both the constructor and switchTab() (base.ts).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import type { WorldChatMessage } from '../../src/net/WorldApiClient';

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

describe('FriendsScene — entering via defaultTab kicks off the same loads as switchTab', () => {
  it("defaultTab: 'world' triggers loadWorldChat() without an explicit switchTab() call", async () => {
    let loadWorldChatCalls = 0;
    const messages: WorldChatMessage[] = [];

    const scene: any = new FriendsScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onOpenRoom() {},
      myPublicId: '',
      getProfileExtra: async () => ({}),
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
      loadWorldChat: async () => { loadWorldChatCalls++; return messages; },
      defaultTab: 'world',
    });

    expect(scene.tab).toBe('world');
    expect(scene.worldLoaded).toBe(false);

    await Promise.resolve();
    await Promise.resolve();

    expect(loadWorldChatCalls).toBe(1);
    expect(scene.worldLoaded).toBe(true);
  });
});

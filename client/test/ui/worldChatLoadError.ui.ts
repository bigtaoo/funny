// Regression test: world chat stuck on "Loading…" forever after a failed fetch
// (18.07.2026, reported live on account tao1 — request to worldsvc timed out/failed
// once and the UI had no error/retry state, so `worldLoaded` stayed false forever
// with no way for the player to recover short of a full page reload).
//
// Fix: loadWorldMessages() now tracks `worldLoading`/`worldLoadError` so a failed
// load surfaces an error label + retry button (worldChat.ts) instead of silently
// re-showing "Loading…" indefinitely, and tapping retry re-triggers the load.
//
// Run: npm run test:ui

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

describe('FriendsScene — world chat load failure surfaces an error + retry instead of spinning forever', () => {
  it('a failed loadWorldChat sets worldLoadError and leaves worldLoaded false; retry recovers', async () => {
    let shouldFail = true;
    const messages: WorldChatMessage[] = [];

    const scene: any = new FriendsScene(createLayout(W, H), new InputManager(), {
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
      loadWorldChat: async () => {
        if (shouldFail) throw new TypeError('world api GET /nation/channel failed: network error');
        return messages;
      },
      defaultTab: 'world',
    });

    await Promise.resolve();
    await Promise.resolve();

    // Failed load: stuck-forever bug would leave worldLoaded=false with no error surfaced.
    expect(scene.worldLoaded).toBe(false);
    expect(scene.worldLoadError).toBe(true);
    expect(scene.worldLoading).toBe(false);

    // Re-entering the tab must not spin indefinitely on the stale error — retrying should work.
    shouldFail = false;
    await scene.loadWorldMessages();

    expect(scene.worldLoaded).toBe(true);
    expect(scene.worldLoadError).toBe(false);
  });
});

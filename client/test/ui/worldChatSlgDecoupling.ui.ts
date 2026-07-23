// Regression test for "world chat shows a loading spinner for 10+ seconds" (14.07.2026).
//
// Root cause: FriendsScene's world tab (drawWorldTab) refused to show chat messages until
// `slgLoaded` was true — but `slgLoaded` is set by loadSLGStatus(), which resolves family/sect
// membership via a chain of worldsvc/socialsvc calls that have nothing to do with world chat
// itself (chat's own worldId resolution happens transparently inside loadWorldChat/
// sendWorldChat). So opening the world tab silently blocked a fast chat-history fetch behind a
// slow, unrelated family/sect status fetch. Fixed by gating the message list purely on
// `worldLoaded` and no longer triggering loadSLGStatus() when switching to the world tab.
//
// This test pins both halves of the fix: (1) the world tab renders messages as soon as they
// arrive even if loadSLGStatus never resolves, and (2) switching to the world tab does not call
// loadSLGStatus at all (only family/sect tabs still need it).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts),
// real display objects, no renderer/WebGL. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
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

/** All PIXI.Text content currently in the display tree, recursing sub-containers. */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

const MSG: WorldChatMessage = {
  id: 'm1', senderId: 'acc1', senderName: 'Bob', senderPublicId: '123456789',
  body: 'hello world', ts: 1000,
};

function buildScene(opts: { slgStatusHangs: boolean; loadSLGStatusCalls: { count: number } }): any {
  const cb = {
    onBack() {}, onOpenRoom() {},
    myPublicId: '', getProfileExtra: async () => ({}),
    loadFriends: async () => [],
    loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => ({ publicId: '1', displayName: 'x' }),
    addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, blockUser: async () => {},
    loadConversations: async () => [], openChat() {},
    loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {}, claimMail: async () => true, deleteMail: async () => {},
    // Never resolves — simulates the slow family/sect status chain.
    loadSLGStatus: async () => {
      opts.loadSLGStatusCalls.count++;
      if (opts.slgStatusHangs) return new Promise<never>(() => {});
      return { worldId: 'world:1:0', familyId: undefined, isLeader: false };
    },
    loadWorldChat: async () => [MSG],
    sendWorldChat: async () => {},
    playerName: () => 'Tester',
    getCoins: () => 0,
    refreshWallet: async () => {},
  };
  return new FriendsScene(createLayout(W, H), new InputManager(), cb);
}

describe('regression: world chat no longer waits on family/sect (SLG) status', () => {
  it('renders chat messages as soon as loadWorldChat resolves, even while loadSLGStatus never resolves', async () => {
    const loadSLGStatusCalls = { count: 0 };
    const scene = buildScene({ slgStatusHangs: true, loadSLGStatusCalls });

    // Real interaction path: clicking the "world" tab (switchTab), not the defaultTab
    // constructor shortcut — see the separate defaultTab bug noted below.
    scene.switchTab('world');
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    expect(scene.worldLoaded).toBe(true);
    expect(scene.slgLoaded).toBe(false); // family/sect status still hung — must not block chat
    const texts = collectTexts(scene.container);
    expect(texts).toContain('Bob');
    expect(texts.some((s: string) => s.includes('hello world'))).toBe(true);
    expect(texts).not.toContain(t('friends.loading'));

    scene.destroy();
  });

  it('switching to the world tab does not trigger loadSLGStatus at all', async () => {
    const loadSLGStatusCalls = { count: 0 };
    const scene = buildScene({ slgStatusHangs: true, loadSLGStatusCalls });

    scene.switchTab('world');
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    expect(loadSLGStatusCalls.count).toBe(0);
    scene.destroy();
  });

  it('switching to the family tab still triggers loadSLGStatus (unaffected by the fix)', async () => {
    const loadSLGStatusCalls = { count: 0 };
    const scene = buildScene({ slgStatusHangs: false, loadSLGStatusCalls });

    scene.switchTab('family');
    await Promise.resolve();
    await Promise.resolve();

    expect(loadSLGStatusCalls.count).toBe(1);
    scene.destroy();
  });
});

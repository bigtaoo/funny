// Regression coverage for the 2026-07-17 chat display rework (design/game/UI_DESIGN.md §21):
// World/Family/Sect chat rows used to draw the sender name and message body on two separate
// lines. They now share `render/chatRow.ts`'s `drawChatLine()`, which draws a single line —
// "[title][sectName][familyName]senderName: body" — with a background tag behind the name only
// (content has no background). This file drives the three real scenes headlessly and asserts
// the resulting PIXI text nodes land on one line with the expected bracket prefix.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import type { WorldChatMessage, FamilyMessageView, SectMessageView, FamilyDetailView } from '../../src/net/WorldApiClient';

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

/** Collects every PIXI.Text/Graphics node under `root`, in tree order. */
function collect(root: PIXI.Container): { texts: PIXI.Text[]; graphics: PIXI.Graphics[] } {
  const texts: PIXI.Text[] = [];
  const graphics: PIXI.Graphics[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children) {
      if (child instanceof PIXI.Text) texts.push(child);
      else if (child instanceof PIXI.Graphics) graphics.push(child);
      if (child instanceof PIXI.Container) walk(child as PIXI.Container);
    }
  };
  walk(root);
  return { texts, graphics };
}

describe('World chat — single-line name-tag row', () => {
  it('renders [title][sectName][familyName]name on the same line as ": body", with a tag graphic', async () => {
    const messages: WorldChatMessage[] = [{
      id: 'm1', senderId: 'a1', senderName: 'tao', senderPublicId: '123456789',
      title: 'Grandmaster', sectName: 'IronSect', familyName: 'WangFam',
      body: 'hello world', ts: 1,
    }];
    const scene: any = new FriendsScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onOpenRoom() {},
      myPublicId: '', getProfileExtra: async () => ({}),
      loadFriends: async () => [],
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '999999999', displayName: 'Nobody' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, blockUser: async () => {},
      loadConversations: async () => [], openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {}, claimMail: async () => true, deleteMail: async () => {},
      loadSLGStatus: async () => null,
      loadWorldChat: async () => messages,
      defaultTab: 'world',
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const { texts, graphics } = collect(scene.container);
    const nameText = texts.find((t) => t.text.startsWith('['));
    const bodyText = texts.find((t) => t.text.includes('hello world'));

    expect(nameText?.text).toBe('[Grandmaster][IronSect][WangFam]tao');
    expect(bodyText?.text).toBe(': hello world');
    expect(bodyText!.y).toBeCloseTo(nameText!.y, 1); // same line
    expect(bodyText!.x).toBeGreaterThan(nameText!.x); // content follows the name, not stacked below it
    expect(graphics.length).toBeGreaterThan(0); // at least one tag background drawn
  });

  it('omits every bracket when title/sectName/familyName are all absent', async () => {
    const messages: WorldChatMessage[] = [{
      id: 'm2', senderId: 'a2', senderName: 'bare', senderPublicId: '', body: 'no tags', ts: 1,
    }];
    const scene: any = new FriendsScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onOpenRoom() {},
      myPublicId: '', getProfileExtra: async () => ({}),
      loadFriends: async () => [],
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '999999999', displayName: 'Nobody' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, blockUser: async () => {},
      loadConversations: async () => [], openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {}, claimMail: async () => true, deleteMail: async () => {},
      loadSLGStatus: async () => null,
      loadWorldChat: async () => messages,
      defaultTab: 'world',
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const { texts } = collect(scene.container);
    expect(texts.some((t) => t.text === 'bare')).toBe(true);
    expect(texts.some((t) => t.text.includes('['))).toBe(false);
  });
});

describe('Family chat — single-line name-tag row', () => {
  it('renders [title][familyName]name on the same line as ": body"', async () => {
    const family: FamilyDetailView = {
      familyId: 'fam1', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me',
      memberCount: 1, prosperity: 0, announcement: '',
      members: [{ accountId: 'me', role: 'leader', joinedAt: 0, displayName: 'tao', publicId: '1' }],
    };
    const messages: FamilyMessageView[] = [{
      id: 'm1', senderId: 'u0', senderName: 'tao', title: 'Grandmaster', familyName: 'WangFam',
      body: 'hello family', ts: 1,
    }];
    // Landscape dims: renderChannel() only runs in the split view (both columns simultaneously);
    // portrait requires an explicit tab switch to 'channel' first.
    const worldApi = { getMyFamily: async () => family, getFamilyChannel: async () => messages };
    const scene: any = new FamilyScene(createLayout(1200, 950), new InputManager(), {
      onBack() {}, onOpenSect() {}, onNavTab() {},
      worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
      getFriendPublicIds: async () => new Set<string>(),
    } as any);
    await scene.loadData();
    scene.render();

    const { texts } = collect(scene.bodyLayer);
    const nameText = texts.find((t) => t.text.startsWith('[') && t.text.endsWith('tao'));
    const bodyText = texts.find((t) => t.text.includes('hello family'));
    expect(nameText?.text).toBe('[Grandmaster][WangFam]tao');
    expect(bodyText?.text).toBe(': hello family');
    expect(bodyText!.y).toBeCloseTo(nameText!.y, 1);
    scene.destroy();
  });
});

describe('Sect chat — single-line name-tag row', () => {
  it('renders [title][sectName][familyName]name on the same line as ": body"', () => {
    const messages: SectMessageView[] = [{
      id: 'm1', senderId: 'u0', senderName: 'tao', title: 'Grandmaster', sectName: 'IronSect', familyName: 'WangFam',
      body: 'hello sect', ts: 1,
    }];
    const scene: any = new SectScene(createLayout(W, H), new InputManager(), {
      onBack() {}, onNavTab() {},
      worldApi: { getMyFamily: () => new Promise<never>(() => {}) } as any,
      worldId: 'w1', myAccountId: 'me', playerName: 'tao',
      getCoins: () => 0, refreshWallet: async () => {},
    } as any);
    scene.mode = 'mySect';
    scene.activeTab = 'channel';
    scene.sect = { sectId: 's1', worldId: 'w1', name: 'Sky Sect', tag: 'SKY', leaderId: 'me', leaderFamilyId: 'fam1', memberFamilyCount: 1, prosperity: 0, memberFamilies: [], allySectIds: [] };
    scene.messages = messages;
    scene.render();

    const { texts } = collect(scene.bodyLayer);
    const nameText = texts.find((t) => t.text.startsWith('['));
    const bodyText = texts.find((t) => t.text.includes('hello sect'));
    expect(nameText?.text).toBe('[Grandmaster][IronSect][WangFam]tao');
    expect(bodyText?.text).toBe(': hello sect');
    expect(bodyText!.y).toBeCloseTo(nameText!.y, 1);
    scene.destroy();
  });
});

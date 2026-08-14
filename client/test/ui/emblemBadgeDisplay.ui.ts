// Coverage for the emblem badge's VISUAL PRESENCE across all four display surfaces
// (family-emblem-art-prompts.md, 2026-08-14): FamilyScene/SectScene header (landscape) + info band
// (portrait), FriendsScene's family browse row + detail preview, SectScene's member-family list
// row, and ProfilePopup.
//
// Mocks render/emblemIcon.ts's buildEmblemIcon to always return a marked, non-null node (a real
// atlas never finishes decoding under the headless PIXI adapter — confirmed by hand: loadEmblemAtlas()
// never resolves there, since the stubbed 1×1 PNG's BaseTexture never fires PIXI's 'loaded' event —
// so without this mock, `key ? buildEmblemIcon(...) : null` is always null and the "an emblem IS set"
// branch can never be observed at all here). isEmblemAtlasReady/loadEmblemAtlas are mocked to the
// synchronous "already ready" case so callers' lazy-load kick-and-redraw plumbing is a no-op. This
// intentionally does NOT test the real .png/.json atlas decode path (nothing meaningful to unit-test
// there beyond "does createAtlasLoader work", already covered by the other atlas loaders' own
// precedent) — it tests the CONSUMER logic: does each surface correctly gate the icon-vs-placeholder-
// vs-nothing branch on (emblemKey present) × (viewer is the leader who could pick one).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';

const EMBLEM_MARK = Symbol('emblemBadgeMock');

vi.mock('../../src/render/emblemIcon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/emblemIcon')>();
  return {
    ...actual,
    isEmblemAtlasReady: () => true,
    loadEmblemAtlas: async () => {},
    buildEmblemIcon: (key: string, size: number, tint: number) => {
      const node = new PIXI.Container() as PIXI.Container & { [EMBLEM_MARK]: { key: string; tint: number } };
      node.width = size; node.height = size;
      node[EMBLEM_MARK] = { key, tint };
      return node;
    },
  };
});

import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { EMBLEM_KEYS, EMBLEM_COLORS } from '../../src/render/emblemIcon';
import type { FamilyDetailView, SectDetailView, SectMemberFamilyView, FamilyView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Walk a display tree, returning every node the mocked buildEmblemIcon produced. */
function findBadges(root: PIXI.Container): Array<{ key: string; tint: number }> {
  const out: Array<{ key: string; tint: number }> = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      const mark = (ch as unknown as Record<symbol, { key: string; tint: number }>)[EMBLEM_MARK];
      if (mark) out.push(mark);
      if ((ch as PIXI.Container).children) walk(ch as PIXI.Container);
    }
  };
  walk(root);
  return out;
}

// ── FamilyScene: header (landscape) + info band (portrait) ──────────────────────

function makeFamily(role: 'leader' | 'member', overrides: Partial<FamilyDetailView> = {}): FamilyDetailView {
  return {
    familyId: 'fam:AA', name: 'Alpha', tag: 'AA', leaderId: role === 'leader' ? 'me' : 'boss',
    memberCount: 1, prosperity: 0,
    members: [{ accountId: 'me', role, joinedAt: 0 }],
    ...overrides,
  };
}

function buildFamilyScene(fam: FamilyDetailView, orientation: 'landscape' | 'portrait'): any {
  const layout = orientation === 'landscape'
    ? { designWidth: 1280, designHeight: 800, orientation: 'landscape' }
    : { designWidth: 800, designHeight: 1280, orientation: 'portrait' };
  const worldApi = {
    getMyFamily: async () => fam, getFamily: async () => fam,
    getFamilyChannel: async () => [], listJoinRequests: async () => [],
  };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    async addFriend() {}, async getFriendPublicIds() { return new Set<string>(); },
    openChat() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
  };
  return new FamilyScene(layout as any, new InputManager(), cb as any);
}

async function flush(scene: any): Promise<void> {
  await scene.data.loadData();
  scene.render();
}

/** Hits sized emblemSize×emblemSize and square (the badge tap target; distinct from every other
 *  hit rect in the header/info-band, none of which are square at these sizes). */
function badgeHits(scene: any): any[] {
  return scene.core.hitRects.filter((h: any) => h.rect.w === h.rect.h && h.rect.w > 0 && h.rect.w < 60);
}

describe('FamilyScene — emblem badge visual presence', () => {
  it('landscape header: emblem set → badge renders for BOTH leader and plain member (viewing your own family, but the same code path any viewer sees)', async () => {
    const leaderScene = buildFamilyScene(makeFamily('leader', { emblemKey: EMBLEM_KEYS[3], emblemColor: EMBLEM_COLORS[2] } as any), 'landscape');
    await flush(leaderScene);
    expect(findBadges(leaderScene.container)).toEqual([{ key: EMBLEM_KEYS[3], tint: EMBLEM_COLORS[2] }]);

    const memberScene = buildFamilyScene(makeFamily('member', { emblemKey: EMBLEM_KEYS[3], emblemColor: EMBLEM_COLORS[2] } as any), 'landscape');
    await flush(memberScene);
    expect(findBadges(memberScene.container)).toEqual([{ key: EMBLEM_KEYS[3], tint: EMBLEM_COLORS[2] }]);
  });

  it('landscape header: no emblem chosen + leader → placeholder circle IS a tap target; plain member → nothing, no tap target', async () => {
    const leaderScene = buildFamilyScene(makeFamily('leader'), 'landscape');
    await flush(leaderScene);
    expect(findBadges(leaderScene.container)).toHaveLength(0); // no real icon (nothing chosen)
    expect(badgeHits(leaderScene)).toHaveLength(1); // but the leader gets a tappable placeholder

    const memberScene = buildFamilyScene(makeFamily('member'), 'landscape');
    await flush(memberScene);
    expect(findBadges(memberScene.container)).toHaveLength(0);
    expect(badgeHits(memberScene)).toHaveLength(0); // no placeholder, no tap target at all
  });

  it('portrait info band: same three-way gate as the landscape header', async () => {
    const withEmblem = buildFamilyScene(makeFamily('member', { emblemKey: EMBLEM_KEYS[5], emblemColor: EMBLEM_COLORS[1] } as any), 'portrait');
    await flush(withEmblem);
    expect(findBadges(withEmblem.container)).toEqual([{ key: EMBLEM_KEYS[5], tint: EMBLEM_COLORS[1] }]);

    const leaderNoEmblem = buildFamilyScene(makeFamily('leader'), 'portrait');
    await flush(leaderNoEmblem);
    expect(badgeHits(leaderNoEmblem)).toHaveLength(1);

    const memberNoEmblem = buildFamilyScene(makeFamily('member'), 'portrait');
    await flush(memberNoEmblem);
    expect(badgeHits(memberNoEmblem)).toHaveLength(0);
  });
});

// ── SectScene: header (landscape) + summary row (portrait) ──────────────────────

function makeSect(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect1', worldId: 'w1', name: 'Great Nation', tag: 'TAO',
    leaderFamilyId: 'fam:LEAD', leaderId: 'boss', memberFamilyCount: 1,
    allySectIds: [], prosperity: 0, memberFamilies: [],
    ...overrides,
  };
}

function makeMyFamily(role: 'leader' | 'member'): FamilyDetailView {
  return {
    familyId: 'fam:LEAD', name: 'Lead Fam', tag: 'LF', leaderId: role === 'leader' ? 'boss' : 'someone-else',
    memberCount: 1, prosperity: 0, sectId: 'sect1',
    members: [{ accountId: 'boss', role, joinedAt: 0 }],
  };
}

function buildSectScene(sect: SectDetailView, fam: FamilyDetailView, orientation: 'landscape' | 'portrait'): any {
  const layout = orientation === 'landscape'
    ? { designWidth: 1280, designHeight: 800, orientation: 'landscape' }
    : { designWidth: 800, designHeight: 1280, orientation: 'portrait' };
  const worldApi = { getMyFamily: async () => fam, getSect: async () => sect, getSectChannel: async () => [], listSects: async () => [] };
  const cb = { onBack() {}, onNavTab() {}, worldApi, worldId: 'w1', myAccountId: 'boss', playerName: 'tao', getCoins: () => 0, refreshWallet: async () => {} };
  return new SectScene(layout as any, new InputManager(), cb as any);
}

async function flushSect(scene: any): Promise<void> {
  await scene.data.loadData();
  scene.render();
}

function sectBadgeHits(scene: any): any[] {
  return scene.core.hitRects.filter((h: any) => h.rect.w === h.rect.h && h.rect.w > 0 && h.rect.w < 60);
}

describe('SectScene — emblem badge visual presence (sect-leader gate, not family-leader)', () => {
  it('landscape header: emblem set → renders for both the sect leader and a mere member-family leader', async () => {
    const sect = makeSect({ emblemKey: EMBLEM_KEYS[6], emblemColor: EMBLEM_COLORS[4] } as any);
    const leaderScene = buildSectScene(sect, makeMyFamily('leader'), 'landscape');
    await flushSect(leaderScene);
    expect(findBadges(leaderScene.container)).toEqual([{ key: EMBLEM_KEYS[6], tint: EMBLEM_COLORS[4] }]);
  });

  it('landscape header: no emblem + sect leader → tappable placeholder; a member-family leader (not sect leader) → nothing tappable', async () => {
    const sect = makeSect({ leaderId: 'boss' });
    const sectLeaderScene = buildSectScene(sect, makeMyFamily('leader'), 'landscape');
    await flushSect(sectLeaderScene);
    expect(sectBadgeHits(sectLeaderScene)).toHaveLength(1);

    const notSectLeader = makeSect({ leaderId: 'someone-else' });
    const memberFamLeaderScene = buildSectScene(notSectLeader, makeMyFamily('leader'), 'landscape');
    await flushSect(memberFamLeaderScene);
    expect(sectBadgeHits(memberFamLeaderScene)).toHaveLength(0);
  });

  it('portrait summary row: same three-way gate', async () => {
    const withEmblem = makeSect({ emblemKey: EMBLEM_KEYS[2], emblemColor: EMBLEM_COLORS[0] } as any);
    const scene1 = buildSectScene(withEmblem, makeMyFamily('member'), 'portrait');
    await flushSect(scene1);
    expect(findBadges(scene1.container)).toEqual([{ key: EMBLEM_KEYS[2], tint: EMBLEM_COLORS[0] }]);

    const noEmblemSectLeader = makeSect({ leaderId: 'boss' });
    const scene2 = buildSectScene(noEmblemSectLeader, makeMyFamily('leader'), 'portrait');
    await flushSect(scene2);
    expect(sectBadgeHits(scene2)).toHaveLength(1);
  });
});

// ── FriendsScene: family browse rows + detail preview ────────────────────────────

function makeFriendsCb(overrides: Record<string, unknown> = {}): any {
  return {
    onBack() {}, onOpenRoom() {}, myPublicId: '',
    getProfileExtra: async () => ({}),
    loadFriends: async () => [], loadRequests: async () => ({ incoming: [], outgoing: [] }),
    search: async () => null, addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {},
    blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
    openChat() {}, loadMail: async () => ({ mail: [], unread: 0 }),
    markMailRead: async () => {}, claimMail: async () => true, deleteMail: async () => {},
    loadSLGStatus: async () => ({ worldId: 'w1', isLeader: false }),
    ...overrides,
  };
}

describe('FriendsScene orgForm.ts — family browse row + detail preview badge', () => {
  it('browse row: a family with an emblem shows the badge before its name', async () => {
    const { FriendsScene } = await import('../../src/scenes/FriendsScene');
    const families: FamilyView[] = [
      { familyId: 'fam:AA', name: 'Alpha', tag: 'AA', leaderId: 'x', memberCount: 3, prosperity: 10, emblemKey: EMBLEM_KEYS[1], emblemColor: EMBLEM_COLORS[6] } as FamilyView,
    ];
    const scene = new FriendsScene(
      { designWidth: 1280, designHeight: 800, orientation: 'landscape' } as any, new InputManager(),
      makeFriendsCb({ browseFamilies: async () => families }),
    ) as any;
    scene.core.tab = 'family';
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'w1', isLeader: false }; // no familyId → stays on the browse/join subview
    scene.core.familySubview = 'joinById';
    scene.core.familyBrowseResults = families;
    scene.core.familyBrowseLoaded = true;
    scene.render();

    expect(findBadges(scene.container)).toEqual([{ key: EMBLEM_KEYS[1], tint: EMBLEM_COLORS[6] }]);
  });

  it('detail preview: shows the badge next to [TAG] Name', async () => {
    const { FriendsScene } = await import('../../src/scenes/FriendsScene');
    const detail: FamilyDetailView = {
      familyId: 'fam:BB', name: 'Beta', tag: 'BB', leaderId: 'x', memberCount: 2, prosperity: 5,
      emblemKey: EMBLEM_KEYS[8], emblemColor: EMBLEM_COLORS[3],
      members: [{ accountId: 'x', role: 'leader', joinedAt: 0, displayName: 'X' }],
    } as FamilyDetailView;
    const scene = new FriendsScene(
      { designWidth: 1280, designHeight: 800, orientation: 'landscape' } as any, new InputManager(), makeFriendsCb(),
    ) as any;
    scene.core.tab = 'family';
    scene.core.slgLoaded = true;
    scene.core.slgStatus = { worldId: 'w1', isLeader: false };
    scene.core.familyDetailView = detail; // drawFamilyTab checks this BEFORE the familyId/subview branching
    scene.render();

    expect(findBadges(scene.container)).toEqual([{ key: EMBLEM_KEYS[8], tint: EMBLEM_COLORS[3] }]);
  });
});

// ── SectScene lists.ts: member-family list rows ──────────────────────────────────

describe('SectScene lists.ts — member-family row badge', () => {
  it('each member family with an emblem shows its own badge in the roster row', async () => {
    const memberFamilies: SectMemberFamilyView[] = [
      { familyId: 'fam:LEAD', name: 'Lead Fam', tag: 'LF', leaderId: 'boss', memberCount: 1, territoryCount: 0, emblemKey: EMBLEM_KEYS[0], emblemColor: EMBLEM_COLORS[0] } as SectMemberFamilyView,
      { familyId: 'fam:OTHER', name: 'Guild One', tag: 'G1', leaderId: 'x', memberCount: 1, territoryCount: 0 }, // no emblem
    ];
    const sect = makeSect({ memberFamilies });
    const scene = buildSectScene(sect, makeMyFamily('leader'), 'landscape');
    await flushSect(scene);

    expect(findBadges(scene.container)).toEqual([{ key: EMBLEM_KEYS[0], tint: EMBLEM_COLORS[0] }]);
  });
});

// ── ProfilePopup ──────────────────────────────────────────────────────────────────

describe('ProfilePopup — family emblem badge next to the family line', () => {
  it('shows the badge when fetchExtra resolves familyEmblemKey/Color', async () => {
    const { ProfilePopup } = await import('../../src/ui/dialogs/ProfilePopup');
    const popup = new ProfilePopup(1280, 800, async () => ({
      familyName: 'Alpha', familyEmblemKey: EMBLEM_KEYS[9], familyEmblemColor: EMBLEM_COLORS[7],
    }));
    popup.show({ name: 'Bob', publicId: '123456789' });
    await new Promise((r) => setTimeout(r, 0)); // let the fetchExtra .then() land + re-render

    expect(findBadges(popup.container)).toEqual([{ key: EMBLEM_KEYS[9], tint: EMBLEM_COLORS[7] }]);
  });

  it('no familyEmblemKey in the resolved extras → no badge', async () => {
    const { ProfilePopup } = await import('../../src/ui/dialogs/ProfilePopup');
    const popup = new ProfilePopup(1280, 800, async () => ({ familyName: 'Alpha' }));
    popup.show({ name: 'Bob', publicId: '123456789' });
    await new Promise((r) => setTimeout(r, 0));

    expect(findBadges(popup.container)).toHaveLength(0);
  });
});

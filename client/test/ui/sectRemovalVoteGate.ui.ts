// Coverage for the leader-removal vote's UI gating (RenderMixin.renderFamiliesList) and the
// removal-vote-in-progress banner (SectSceneBase's split view / renderFamilies portrait path) —
// neither had any test before the 2026-08-05 full-suite audit flagged "leader-removal vote: zero
// coverage" (sectAllianceControls.ui.ts covers the sibling ally/manage-allies buttons but never
// the per-family Vote button, and sectActions.test.ts only drives confirmVote/doVote's own body).
//
// Rule under test: any family leader (isFamilyLeader) may nominate a removal vote against any
// OTHER family in the sect (not the current leader family itself) — a plain member never sees the
// button regardless of which family row it would attach to.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { SectScene } from '../../src/scenes/SectScene';
import type { FamilyDetailView, SectDetailView, SectMemberFamilyView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Three families: the current leader family (excluded from voting entirely), the player's own
// family (included — a family leader may nominate their own family as the replacement, i.e.
// self-nominate), and a third, unrelated family (included — nominating someone else).
function makeFamilies(): SectMemberFamilyView[] {
  return [
    { familyId: 'fam:LEAD', name: 'Iron Quill', tag: 'IRQ', leaderId: 'boss', memberCount: 3, territoryCount: 2 },
    { familyId: 'fam:OTHER', name: 'Guild One', tag: 'G1', leaderId: 'me', memberCount: 1, territoryCount: 0 },
    { familyId: 'fam:THIRD', name: 'Guild Two', tag: 'G2', leaderId: 'someone', memberCount: 1, territoryCount: 0 },
  ];
}

function makeSect(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect1', worldId: 'w1', name: 'Great Nation', tag: 'TAO',
    leaderFamilyId: 'fam:LEAD', leaderId: 'boss', memberFamilyCount: 3,
    allySectIds: [], prosperity: 0, memberFamilies: makeFamilies(),
    ...overrides,
  };
}

/** `role` models the current player's role within their OWN family (fam:OTHER, leaderId 'me'). */
function makeMyFamily(role: 'leader' | 'member'): FamilyDetailView {
  return {
    familyId: 'fam:OTHER', name: 'Guild One', tag: 'G1', leaderId: 'me',
    memberCount: 1, prosperity: 0, sectId: 'sect1',
    members: [{ accountId: 'me', role, joinedAt: 0 }],
  };
}

function buildScene(sect: SectDetailView, fam: FamilyDetailView): any {
  const worldApi = {
    getMyFamily: async () => fam,
    getSect: async () => sect,
    getSectChannel: async () => [],
    listSects: async () => [],
  };
  const cb = {
    onBack() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
    getCoins: () => 0, refreshWallet: async () => {},
  };
  // Landscape's split view still renders the families column via the same renderFamiliesList
  // vote-button gating, and it's the layout most of this codebase already exercises for Sect.
  const layout = { designWidth: 1200, designHeight: 950, orientation: 'landscape' } as any;
  return new SectScene(layout, new InputManager(), cb as any);
}

async function flush(scene: any): Promise<void> {
  await scene.loadData();
  scene.render();
}

function voteHits(scene: any): any[] {
  return scene.hitRects.filter((h: any) => {
    // Vote buttons are the only 34-tall action rects in the families column (see ROW_H=68's
    // vote row math in render.ts) — distinguish them from the header alliance buttons (~0.4·headerH).
    return h.rect.h === 34;
  });
}

describe('SectScene — removal-vote button gating', () => {
  it('a family leader sees a Vote button on every OTHER family (including their own), never the current leader family', async () => {
    const scene = buildScene(makeSect(), makeMyFamily('leader'));
    await flush(scene);

    // 3 families total; only fam:LEAD (the current leader family) is excluded — fam:OTHER (the
    // player's own family, a valid self-nomination) and fam:THIRD both get a Vote button.
    expect(voteHits(scene)).toHaveLength(2);
  });

  it('a plain member (not their family leader) sees no Vote button at all', async () => {
    const scene = buildScene(makeSect(), makeMyFamily('member'));
    await flush(scene);

    expect(voteHits(scene)).toHaveLength(0);
  });

  it('tapping Vote on a third family calls confirmVote with that family\'s id and a resolved label', async () => {
    const scene = buildScene(makeSect(), makeMyFamily('leader'));
    await flush(scene);
    const confirmVoteSpy = vi.spyOn(scene, 'confirmVote');

    // Rows render in memberFamilies order (fam:LEAD skipped, fam:OTHER, then fam:THIRD) — hits are
    // pushed in that same order, so the second surviving hit is fam:THIRD's.
    const hits = voteHits(scene);
    hits[1]!.action();

    expect(confirmVoteSpy).toHaveBeenCalledWith('fam:THIRD', '[G2] Guild Two');
  });

  it('when a removal vote is in progress, the banner shows the nominee and the running tally', async () => {
    const sect = makeSect({ removalVote: { nomineeFamilyId: 'fam:LEAD', voteCount: 1, needed: 2 } });
    const scene = buildScene(sect, makeMyFamily('leader'));
    await flush(scene);

    const banner = allTexts(scene).find((s) => s.includes('Iron Quill'));
    expect(banner).toBeTruthy();
    expect(banner).toContain('1');
    expect(banner).toContain('2');
  });

  it('falls back to the raw family id in the banner if the nominee has since left the sect', async () => {
    const sect = makeSect({ removalVote: { nomineeFamilyId: 'fam:GONE', voteCount: 1, needed: 2 } });
    const scene = buildScene(sect, makeMyFamily('leader'));
    await flush(scene);

    expect(allTexts(scene).some((s) => s.includes('fam:GONE'))).toBe(true);
  });
});

// ── Test helpers ──────────────────────────────────────────────────────────────

function allTexts(scene: any): string[] {
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text) out.push(c.text);
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(scene.bodyLayer);
  return out;
}

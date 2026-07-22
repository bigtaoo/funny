// Coverage for the 2026-07-22 alliance-controls move: the ally / manage-allies actions moved off
// the bottom bar onto the top summary band. Viewing allies is open to every member (a read-only
// "Allies (n)" button); forming (ally) and breaking (manage allies) alliances stay sect-leader only.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
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

function makeFamilies(n: number): SectMemberFamilyView[] {
  return Array.from({ length: n }, (_, i) => ({
    familyId: i === 0 ? 'fam:LEAD' : `fam:${i}`,
    name: i === 0 ? 'Iron Quill' : `Guild ${i}`,
    tag: i === 0 ? 'IRQ' : `G${i}`,
    leaderId: i === 0 ? 'boss' : `boss${i}`,
    memberCount: 1 + i,
    territoryCount: i,
  }));
}

function makeSect(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect1', worldId: 'w1', name: 'Great Nation', tag: 'TAO',
    leaderFamilyId: 'fam:LEAD', leaderId: 'boss', memberFamilyCount: 1,
    allySectIds: [], prosperity: 0, memberFamilies: makeFamilies(1),
    ...overrides,
  };
}

/** `role`/`leaderId` let a test model the current player as sect leader or a plain member. */
function makeMyFamily(role: 'leader' | 'member', leaderId: string): FamilyDetailView {
  return {
    familyId: 'fam:LEAD', name: 'Iron Quill', tag: 'IRQ', leaderId,
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
  const layout = { designWidth: 1200, designHeight: 950, orientation: 'landscape' } as any;
  return new SectScene(layout, new InputManager(), cb as any);
}

/** All Text objects with their absolute-ish y (position within bodyLayer subtree). */
function texts(scene: any): { text: string; y: number }[] {
  const out: { text: string; y: number }[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text) out.push({ text: c.text, y: c.y });
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(scene.bodyLayer);
  return out;
}

describe('SectScene — alliance controls', () => {
  it('sect leader sees Ally + Manage Allies on the top summary band', async () => {
    const scene = buildScene(makeSect({ leaderId: 'me' }), makeMyFamily('leader', 'me'));
    await scene.loadData();
    scene.render();

    const all = texts(scene);
    const manage = all.find((t) => t.text === 'Manage Allies');
    const ally = all.find((t) => t.text === 'Ally');
    expect(manage).toBeTruthy();
    expect(ally).toBeTruthy();
    // Seated near the header (top summary band), not down in the old bottom bar.
    expect(manage!.y).toBeLessThan(scene.h / 2);
    // The member-only read-only view button is not shown to the leader.
    expect(all.some((t) => t.text.startsWith('Allies ('))).toBe(false);
  });

  it('regular member sees a read-only Allies (n) button, no Manage Allies', async () => {
    const scene = buildScene(
      makeSect({ leaderId: 'boss', allySectIds: ['a1', 'a2'] }),
      makeMyFamily('member', 'boss'),
    );
    await scene.loadData();
    scene.render();

    const all = texts(scene);
    expect(all.some((t) => t.text === 'Allies (2)')).toBe(true);
    expect(all.some((t) => t.text === 'Manage Allies')).toBe(false);
    expect(all.some((t) => t.text === 'Ally')).toBe(false);
  });
});

// Coverage for the 2026-07-22 alliance-controls move (off the bottom bar) and the 2026-07-25
// header-declutter pass (landscape lifts them again, off the body's summary band and into the
// header itself, alongside the sect identity — see SectSceneBase.drawHeaderTitle). Viewing allies
// is open to every member (a read-only "Allies (n)" button); forming (ally) and breaking (manage
// allies) alliances stay sect-leader only.
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

/** All Text objects with their absolute-ish y, from both the header (this.container's direct
 *  children — see SectSceneBase.drawHeaderTitle) and the body subtree, since landscape now draws
 *  the alliance controls in the header while portrait still draws them in the body. */
function texts(scene: any): { text: string; y: number }[] {
  const out: { text: string; y: number }[] = [];
  for (const c of scene.container.children) {
    if (c instanceof PIXI.Text) out.push({ text: c.text, y: c.y });
  }
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text) out.push({ text: c.text, y: c.y });
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(scene.core.bodyLayer);
  return out;
}

/** Index of `label` within `scene.container.children` (the header layer) — used by the z-order
 *  regression checks below, which need the raw sibling order rather than just presence/absence. */
function headerChildIndexOf(scene: any, label: string): number {
  const children: PIXI.DisplayObject[] = scene.container.children;
  return children.findIndex((c) => c instanceof PIXI.Text && c.text === label);
}

describe('SectScene — alliance controls', () => {
  it('sect leader sees Ally + Manage Allies in the header (landscape)', async () => {
    const scene = buildScene(makeSect({ leaderId: 'me' }), makeMyFamily('leader', 'me'));
    await scene.data.loadData();
    scene.render();

    const all = texts(scene);
    const manage = all.find((t) => t.text === 'Manage Allies');
    const ally = all.find((t) => t.text === 'Ally');
    expect(manage).toBeTruthy();
    expect(ally).toBeTruthy();
    // Seated in the header, not down in the old bottom bar.
    expect(manage!.y).toBeLessThan(scene.core.h / 2);
    // The member-only read-only view button is not shown to the leader.
    expect(all.some((t) => t.text.startsWith('Allies ('))).toBe(false);
  });

  it('regular member sees a read-only Allies (n) button, no Manage Allies', async () => {
    const scene = buildScene(
      makeSect({ leaderId: 'boss', allySectIds: ['a1', 'a2'] }),
      makeMyFamily('member', 'boss'),
    );
    await scene.data.loadData();
    scene.render();

    const all = texts(scene);
    expect(all.some((t) => t.text === 'Allies (2)')).toBe(true);
    expect(all.some((t) => t.text === 'Manage Allies')).toBe(false);
    expect(all.some((t) => t.text === 'Ally')).toBe(false);
  });

  // Regression coverage for the 2026-08-09 fix: drawHeaderAllianceButtons' addBtn closure used to
  // add() the label *before* the sketchPanel backdrop, so the opaque panel (later child = painted
  // on top in PixiJS) fully hid the label — button still clickable, just visually empty. These
  // assert sibling order directly rather than mere presence, since a plain texts() presence check
  // (as above) passes either way and did not catch the original bug.
  it('sect leader header buttons: label paints above its own backdrop, not hidden by it', async () => {
    const scene = buildScene(makeSect({ leaderId: 'me' }), makeMyFamily('leader', 'me'));
    await scene.data.loadData();
    scene.render();

    const children: PIXI.DisplayObject[] = scene.container.children;
    const manageIdx = headerChildIndexOf(scene, 'Manage Allies');
    const allyIdx = headerChildIndexOf(scene, 'Ally');
    expect(manageIdx).toBeGreaterThan(-1);
    expect(allyIdx).toBeGreaterThan(-1);
    // addBtn adds each button's sketchPanel backdrop then immediately its label — so a correctly
    // ordered label's direct predecessor is always the (non-Text) panel, never another label's
    // text. Checking global "everything after the first label is text" doesn't work here since
    // two buttons interleave (panel1, label1, panel2, label2) — panel2 legitimately follows
    // label1 without occluding it, so the per-button adjacency check below is the real invariant.
    expect(children[manageIdx - 1]).not.toBeInstanceOf(PIXI.Text);
    expect(children[allyIdx - 1]).not.toBeInstanceOf(PIXI.Text);
  });

  it('regular member header button: label paints above its own backdrop, not hidden by it', async () => {
    const scene = buildScene(
      makeSect({ leaderId: 'boss', allySectIds: ['a1', 'a2'] }),
      makeMyFamily('member', 'boss'),
    );
    await scene.data.loadData();
    scene.render();

    const children: PIXI.DisplayObject[] = scene.container.children;
    const alliesIdx = headerChildIndexOf(scene, 'Allies (2)');
    expect(alliesIdx).toBeGreaterThan(-1);
    expect(children[alliesIdx - 1]).not.toBeInstanceOf(PIXI.Text);
  });
});

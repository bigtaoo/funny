// FamilyScene / SectScene are the two scenes that pass `title: null` to `drawSceneHeader` and lay
// their own `[icon][gap][title]` group out by hand (they also carry an org identity cluster in the
// same bar), so `sceneHeaderTitleIcon.ui.ts` — which drives the shared widget — cannot see them.
// Both are also the two hand-rolled TAB strips that had no `icon` field at all before batch 5
// (members/channel, families/channel), for the same reason: they predate HubTabs.
//
// What this pins down, per scene:
//   1. The title glyph exists, occupies the group's leading slot, and is added BEFORE the title text
//      so add order (== z-order) can't put the picture on top of the words.
//   2. It clears the back-button pill and the title stays inside the bar — the two layout bugs the
//      outlet pass hit (icon painted across "← Back"; group pushed off the right edge) were invisible
//      to the whole UI suite and only showed up in a real portrait capture.
//   3. Each cell of the hand-rolled tab strip draws a glyph beside its label, not just the label.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { FS } from '../../src/render/fontScale';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import type {
  FamilyDetailView, FamilyMessageView, SectDetailView, SectMessageView,
} from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const MY_FAMILY: FamilyDetailView = {
  familyId: 'fam:LEAD', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me',
  memberCount: 1, prosperity: 480, sectId: 'sect1',
  members: [{ accountId: 'me', role: 'leader', joinedAt: 0, displayName: 'tao', publicId: '1' }],
};
const MY_SECT: SectDetailView = {
  sectId: 'sect1', worldId: 'w1', name: 'Great Nation', tag: 'TAO',
  leaderFamilyId: 'fam:LEAD', leaderId: 'me', memberFamilyCount: 1,
  allySectIds: [], prosperity: 0,
  memberFamilies: [{ familyId: 'fam:LEAD', name: 'Iron Quill', tag: 'IRQ', leaderId: 'me', memberCount: 1, territoryCount: 0 }],
};
const FAMILY_MSGS: FamilyMessageView[] = [{ id: 'm0', senderId: 'u0', senderName: 'Player0', body: 'hello', ts: 0 }];
const SECT_MSGS: SectMessageView[] = [{ id: 'm0', senderId: 'u0', senderName: 'Player0', body: 'hello', ts: 0 }];

/* eslint-disable @typescript-eslint/no-explicit-any */

function buildFamily(w: number, h: number, orientation: 'portrait' | 'landscape'): any {
  const worldApi = { getMyFamily: async () => MY_FAMILY, getFamilyChannel: async () => FAMILY_MSGS };
  const cb = {
    onBack() {}, onOpenSect() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
    getFriendPublicIds: async () => new Set<string>(),
  };
  return new FamilyScene({ designWidth: w, designHeight: h, orientation } as any, new InputManager(), cb as any);
}

function buildSect(w: number, h: number, orientation: 'portrait' | 'landscape'): any {
  const worldApi = {
    getMyFamily: async () => MY_FAMILY, getSect: async () => MY_SECT, getSectChannel: async () => SECT_MSGS,
  };
  const cb = {
    onBack() {}, onNavTab() {},
    worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
    getCoins: () => 0, refreshWallet: async () => {},
  };
  return new SectScene({ designWidth: w, designHeight: h, orientation } as any, new InputManager(), cb as any);
}

/**
 * The title Text, plus the glyph of its `[icon][gap][title]` group — identified by POSITION, not by
 * "the sibling drawn before it": under the headless harness a raster tab icon's texture never
 * decodes, so `buildIcon` returns a Container holding one never-shown Sprite (see
 * `buildFittedSprite`), which is indistinguishable by type from the header chrome nodes sitting in
 * the same parent — and draws nothing, so it has no measurable box either. The x it
 * must occupy is fully determined by `buildTitleIcon`'s two ratios, so match on that instead —
 * verified to fail when the `add(titleIcon.node)` call is removed.
 *
 * Scans ONLY the scene container's direct children: both scenes draw the header title (and its
 * glyph) straight onto it, while `bodyLayer` — a child of the same container — holds the social rail,
 * whose Family/Sect tab cell has a label with the exact same text. A recursive search finds that
 * label first and reports no glyph, which is how this test passed while the icon was disabled.
 */
function titleAndGlyph(root: PIXI.Container, title: string): { node: PIXI.Text; glyph: PIXI.Container | null; size: number } {
  const size = Math.round(FS.headline * 1.25);   // TITLE_ICON_RATIO
  const gap = Math.round(FS.headline * 0.34);    // TITLE_ICON_GAP_RATIO
  const kids = root.children as PIXI.Container[];
  const i = kids.findIndex((c) => c instanceof PIXI.Text && c.text === title);
  if (i < 0) throw new Error(`no header title "${title}" drawn on the scene container`);
  const node = kids[i] as PIXI.Text;
  const wantX = node.x - gap - size;
  const glyph = kids.filter((c, j) => j < i && !(c instanceof PIXI.Text) && Math.abs(c.x - wantX) <= 1)[0] ?? null;
  return { node, glyph, size };
}

/** Every Text in the tree with the position it renders at, for the tab-strip assertions. */
function textNodes(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text) out.push(c);
      if ((c as PIXI.Container).children) walk(c as PIXI.Container);
    }
  };
  walk(root);
  return out;
}

/**
 * Non-Text display objects (glyph containers/sprites) whose box vertically overlaps `y`.
 *
 * "Carries no text of its own" is the glyph test, expressed as "every child is a Sprite" (an empty
 * container passes vacuously). It used to be the stricter `children.length === 0`: under the
 * headless harness every `.png` stubs to a data URI that never decodes, and the icon builders drew
 * nothing at all until the texture was valid, so an icon box here could only ever be empty. Since
 * 2026-08-30 they always add the art Sprite (invisible until it decodes — see `buildFittedSprite`),
 * so emptiness no longer identifies a glyph.
 */
function glyphsNear(root: PIXI.Container, y: number): PIXI.Container[] {
  const out: PIXI.Container[] = [];
  const isGlyph = (c: PIXI.Container): boolean =>
    !(c instanceof PIXI.Text) && (c.children ?? []).every((ch) => ch instanceof PIXI.Sprite);
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children as PIXI.Container[]) {
      if (isGlyph(c) && c.y <= y && y <= c.y + 64) out.push(c);
      if (c.children?.length) walk(c);
    }
  };
  walk(root);
  return out;
}

describe.each([
  ['FamilyScene', buildFamily, 'family.title', 'family.tabMembers', 'family.channel'],
  ['SectScene', buildSect, 'sect.title', 'sect.tabFamilies', 'sect.tabChannel'],
] as const)('%s — hand-laid-out header title glyph (batch 5)', (_name, build, titleKey, tabAKey, tabBKey) => {
  it.each(['portrait', 'landscape'] as const)('draws the glyph left of the title, clear of the back pill (%s)', async (orientation) => {
    const [w, h] = orientation === 'portrait' ? [430, 932] : [1280, 800];
    const scene = build(w, h, orientation);
    await scene.data.loadData();
    scene.render();

    const { node, glyph, size } = titleAndGlyph(scene.container, t(titleKey as never));
    // The glyph is drawn, at the group's leading slot, and before the title in add (== z) order.
    expect(glyph, 'no title glyph at the [icon][gap][title] leading position').not.toBeNull();
    expect(glyph!.x + size).toBeLessThan(node.x);
    // Clear of the back-button pill: SceneHeader draws it at x=10 with a 0.039·h-derived label.
    expect(glyph!.x).toBeGreaterThan(10 + Math.round(h * 0.039));
    // Inside the bar, not off the right edge.
    expect(node.x + node.width).toBeLessThanOrEqual(w);
  });

  it('gives every hand-rolled tab cell a glyph beside its label', async () => {
    // Portrait: the strip is the two-cell members/channel (families/channel) bar under the header.
    const scene = build(430, 932, 'portrait');
    await scene.data.loadData();
    scene.render();

    for (const key of [tabAKey, tabBKey]) {
      const label = textNodes(scene.core.bodyLayer).find((n) => n.text === t(key as never));
      expect(label, `tab label "${key}" not drawn`).toBeTruthy();
      const glyphs = glyphsNear(scene.core.bodyLayer, label!.y).filter((g) => g.x < label!.x && label!.x - g.x < 80);
      expect(glyphs.length, `tab "${key}" has no glyph left of its label`).toBeGreaterThan(0);
    }
  });
});

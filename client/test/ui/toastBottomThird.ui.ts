// Regression coverage for the 2026-07-16 toast unification (design/game/UI_DESIGN.md §18): every
// scene's showToast() font size was doubled (13px→26px; relative h*0.028→h*0.056) and its vertical
// position moved off the literal bottom edge (`h-80`/`h-92`) onto the bottom-third boundary
// `h*(2/3)` — matching what DailyScene already did before this change. The later font-scale
// unification (858cba0e) moved most of those scenes' literal 26px onto the semantic FS scale
// (FS.heading=28 for the bordered/plain-text patterns, FS.headline=42 for CityScene's larger
// render()-driven toast) — assertions below check against the FS tokens, not the original px.
//
// Covers all three structural toast patterns found in the codebase:
//   1. Bordered-panel toast (EquipmentScene, CardScene, TeamsScene): sketchPanel bg + a
//      center-anchored (0.5,0.5) label — the label's own .y IS the panel's vertical center.
//   2. Plain-text toast, no background (AuctionScene, FamilyScene, SectScene): label
//      center-anchored directly at (w/2, h*2/3).
//   3. render()-driven `this.toast` string (CityScene, DailyScene): DailyScene's label is
//      center-anchored like pattern 2; CityScene's is NOT anchor-centered (drawn inset at the
//      panel's top-left + 20px), so its assertion checks the *panel*'s vertical center instead.
// Plus GlobalToast (ui/GlobalToast.ts), the non-scene network-error fallback banner, which shares
// pattern 1's box-centered-label shape.
//
// Not independently covered here (same formula as an already-covered sibling, skipped to avoid
// extra scene-construction overhead): EventScene/BattlePassScene (== DailyScene's pattern),
// DefenseEditorScene (== AuctionScene's pattern).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { TeamsScene, type TeamsCallbacks } from '../../src/scenes/TeamsScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { DailyScene } from '../../src/scenes/DailyScene';
import { GlobalToast } from '../../src/ui/GlobalToast';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';
import { FS } from '../../src/render/fontScale';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1280, 800];
// Landscape pins designHeight to a fixed 1080 regardless of the physical screen height passed to
// createLayout() (see LandscapeLayout's DESIGN_H — designWidth is the axis that stretches instead;
// see [[ilayout-landscape-design-width-stretches]]) — every scene under test reads `this.h` off
// that pinned design height, not the raw H above, so the "bottom third" line must be derived from it.
const DESIGN_H = createLayout(W, H).designHeight;
const BOTTOM_THIRD_Y = Math.round(DESIGN_H * 2 / 3);
const MSG = 'Enhance failed (materials spent)';

/** First PIXI.Text node in the tree whose text matches `text`. */
function findText(root: PIXI.Container, text: string): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (found) return;
      if (ch instanceof PIXI.Text && ch.text === text) { found = ch; return; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return found;
}

/**
 * The PIXI.Graphics sibling immediately preceding a matched Text node under the same parent —
 * i.e. that Text's own background panel, not just "the first Graphics anywhere" (the scene tree
 * has many unrelated Graphics nodes — building cards, decor, etc. — a global search would grab
 * the wrong one). Matches the toast draw order (`container.addChild(bgGraphics, label)` /
 * `addChild(bgGraphics); addChild(label)` — bg always added directly before its label).
 */
function findPanelBehindText(root: PIXI.Container, text: string): PIXI.Graphics | null {
  let found: PIXI.Graphics | null = null;
  const walk = (c: PIXI.Container): void => {
    if (found) return;
    const idx = c.children.findIndex((ch) => ch instanceof PIXI.Text && ch.text === text);
    if (idx > 0 && c.children[idx - 1] instanceof PIXI.Graphics) { found = c.children[idx - 1] as PIXI.Graphics; return; }
    for (const ch of c.children) {
      if (found) return;
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return found;
}

// ── Pattern 1: bordered-panel toast, label center-anchored inside the panel ────────────────────

describe('showToast() — bordered-panel toasts sit centered on the bottom-third line (h*2/3)', () => {
  it('EquipmentScene', () => {
    const save = makeNewSave('acc_test');
    const cb: EquipmentCallbacks = {
      onBack() {}, getSave: () => save,
      craft: async () => ({ ok: true }), enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }), equip: async () => ({ ok: true }), reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const scene = new EquipmentScene(createLayout(W, H), new InputManager(), cb) as any;
    scene.showToast(MSG);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.heading);
    expect(Math.abs(lbl!.y - BOTTOM_THIRD_Y)).toBeLessThanOrEqual(1);
    scene.destroy();
  });

  it('CardScene', () => {
    const save = makeNewSave('acc_test');
    const cb: CardCallbacks = {
      onBack() {}, getSave: () => save,
      feedCards: async () => ({ ok: true }), setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => [], getEquippedSkin: () => null, equipSkin() {},
    };
    const scene = new CardScene(createLayout(W, H), new InputManager(), cb) as any;
    scene.showToast(MSG);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.heading);
    expect(Math.abs(lbl!.y - BOTTOM_THIRD_Y)).toBeLessThanOrEqual(1);
    scene.destroy();
  });

  it('TeamsScene', async () => {
    const worldApi = {
      getTeams: async () => [], getMe: async () => ({ joined: true } as PlayerWorldView),
      distributeTroops: async () => ({ ok: true }), getMarches: async () => [], getOccupations: async () => [],
    } as unknown as WorldApiClient;
    const cb: TeamsCallbacks = {
      onBack: () => {}, onEditTeam: () => {}, getSave: () => ({ cardInv: {} } as any),
      worldApi, worldId: 'world:1:0',
    };
    const scene = new TeamsScene(createLayout(W, H), new InputManager(), cb) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();
    scene.showToast(MSG, 0xc0392b);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.heading);
    expect(Math.abs(lbl!.y - BOTTOM_THIRD_Y)).toBeLessThanOrEqual(1);
    scene.destroy();
  });

  it('GlobalToast (non-scene network-error fallback)', () => {
    const fakeApp = {
      screen: { width: W, height: H },
      stage: new PIXI.Container(),
      ticker: { add: () => {} },
    } as unknown as PIXI.Application;
    const toast = new GlobalToast(fakeApp) as any;
    toast.show(MSG);
    const lbl = findText(toast.layer, MSG);
    expect(lbl).not.toBeNull();
    // GlobalToast's own convention is h*0.052, not the 0.056 the scene toasts use (pre-existing —
    // this asserts the box is still centered at h*2/3, not that its font matches the scene toasts).
    expect(lbl!.style.fontSize).toBe(Math.round(H * 0.052)); // GlobalToast takes raw app.screen H, not designHeight
    expect(Math.abs(lbl!.y - Math.round(H * 2 / 3))).toBeLessThanOrEqual(1);
  });
});

// ── Pattern 2: plain-text toast (no background), centered directly at (w/2, h*2/3) ─────────────

describe('showToast() — plain-text toasts sit centered on the bottom-third line (h*2/3)', () => {
  it('AuctionScene', () => {
    const worldApi = { listAuctions: async () => [], getMyListings: async () => [] } as unknown as WorldApiClient;
    const scene = new AuctionScene(createLayout(W, H), new InputManager(), { onBack() {}, worldApi }) as any;
    scene.showToast(MSG);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.heading);
    expect(lbl!.y).toBe(BOTTOM_THIRD_Y);
    scene.destroy();
  });

  it('FamilyScene', () => {
    const worldApi = { getMyFamily: () => new Promise<never>(() => {}) } as unknown as WorldApiClient;
    const cb = { onBack() {}, onOpenSect() {}, onNavTab() {}, worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao' };
    const scene = new FamilyScene(createLayout(W, H), new InputManager(), cb as any) as any;
    scene.showToast(MSG);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.heading);
    expect(lbl!.y).toBe(BOTTOM_THIRD_Y);
    scene.destroy();
  });

  it('SectScene', () => {
    const worldApi = { getMyFamily: () => new Promise<never>(() => {}) } as unknown as WorldApiClient;
    const cb = {
      onBack() {}, onNavTab() {}, worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
      getCoins: () => 0, refreshWallet: async () => {},
    };
    const scene = new SectScene(createLayout(W, H), new InputManager(), cb as any) as any;
    scene.showToast(MSG);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.heading);
    expect(lbl!.y).toBe(BOTTOM_THIRD_Y);
    scene.destroy();
  });
});

// ── Pattern 3: render()-driven `this.toast` string toasts ──────────────────────────────────────

describe('showToast() — render()-driven toasts sit centered on the bottom-third line (h*2/3)', () => {
  it('DailyScene (label center-anchored, same as pattern 2)', () => {
    // render() early-returns a "log in" placeholder before reaching the toast block when
    // getSave() is falsy (see DailyScene.render()) — must supply a save to reach it.
    const scene = new DailyScene(createLayout(W, H), new InputManager(), {
      onBack() {}, getSave: () => makeNewSave('acc_test'),
    }) as any;
    scene.showToast(MSG);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(Math.round(DESIGN_H * 0.056));
    expect(lbl!.y).toBe(BOTTOM_THIRD_Y);
    scene.destroy();
  });

  it('CityScene (label inset at the panel corner — assert the panel center, not the label)', () => {
    const worldApi = {
      getMe: () => new Promise<PlayerWorldView>(() => {}),
      upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
      speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
    } as unknown as WorldApiClient;
    const cb: CitySceneCallbacks = { onBack: () => {}, worldApi, worldId: 'world:1:0' };
    const scene = new CityScene(createLayout(W, H), new InputManager(), cb) as any;
    scene.showToast(MSG, 0xc0392b);
    const lbl = findText(scene.container, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.headline);
    const panel = findPanelBehindText(scene.container, MSG);
    expect(panel).not.toBeNull();
    // th=84 (see CityScene.ts's toast block, sized for FS.headline text) — panel's vertical center.
    expect(Math.abs((panel!.y + 42) - BOTTOM_THIRD_Y)).toBeLessThanOrEqual(1);
    scene.destroy();
  });
});

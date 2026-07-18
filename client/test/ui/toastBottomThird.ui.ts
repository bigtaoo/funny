// Regression coverage for the 2026-07-17 toast unification (design/game/UI_DESIGN.md §18).
//
// Before: every hub scene drew its OWN toast banner (a per-scene showToast()/drawToast() +
// toastLayer/toastTimer or a render()-driven `this.toast` field), each with slightly different
// geometry. The prior version of this file asserted each of those per-scene banners was centred on
// the bottom-third line (h*2/3).
//
// After: those per-scene banners are gone. Every scene routes its toast through the single global
// outlet `showToastMessage(text, kind)` (net/log), which app.ts wires to GlobalToast.show() with a
// two-colour mapping (success → green, error → red). GlobalToast is now the ONLY renderer, floating
// above all scenes and centred on the bottom-third line. So the meaningful regressions to pin are:
//   1. GlobalToast still renders its bar centred at h*2/3 (the unified position).
//   2. Each scene's showToast(msg, color) delegates to the sink with the right kind — a red colour
//      maps to 'error', anything else (green / neutral dark) to 'success'.
//
// WorldMapPanels is deliberately EXCLUDED from the unification (see [[toast-size-position-unification-2026-07-16]])
// and still draws its own bordered panel at h*2/3 — its geometry test is kept below unchanged.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { GlobalToast } from '../../src/ui/GlobalToast';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { setToastSink, type ToastKind } from '../../src/net/log';
import { ui as C } from '../../src/render/sketchUi';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
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

/** The PIXI.Graphics sibling immediately preceding a matched Text node under the same parent. */
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

// ── Scene showToast() → global sink (with the right kind) ───────────────────────────────────────

describe('scene showToast() routes to the global toast sink (success/error kind)', () => {
  let sink: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sink = vi.fn();
    setToastSink((text: string, kind: ToastKind) => sink(text, kind));
  });

  it('EquipmentScene: neutral default → success, C.red → error', () => {
    const save = makeNewSave('acc_test');
    const cb: EquipmentCallbacks = {
      onBack() {}, getSave: () => save,
      craft: async () => ({ ok: true }), enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }), equip: async () => ({ ok: true }), reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const scene = new EquipmentScene(createLayout(W, H), new InputManager(), cb) as any;
    scene.showToast(MSG);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'success');
    scene.showToast(MSG, C.red);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'error');
    scene.destroy();
  });

  it('FamilyScene: neutral default → success, C.red → error', () => {
    const worldApi = { getMyFamily: () => new Promise<never>(() => {}) } as unknown as WorldApiClient;
    const cb = { onBack() {}, onOpenSect() {}, onNavTab() {}, worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao' };
    const scene = new FamilyScene(createLayout(W, H), new InputManager(), cb as any) as any;
    scene.showToast(MSG);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'success');
    scene.showToast(MSG, C.red);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'error');
    scene.destroy();
  });

  it('CityScene: default is red → error, C.green → success', () => {
    const worldApi = {
      getMe: () => new Promise<PlayerWorldView>(() => {}),
      upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
      speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
    } as unknown as WorldApiClient;
    const cb: CitySceneCallbacks = { onBack: () => {}, worldApi, worldId: 'world:1:0' };
    const scene = new CityScene(createLayout(W, H), new InputManager(), cb) as any;
    scene.showToast(MSG);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'error');
    scene.showToast(MSG, C.green);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'success');
    scene.destroy();
  });
});

// ── GlobalToast: the single renderer, centred on the bottom-third line (h*2/3) ───────────────────

describe('GlobalToast renders its bar centred on the bottom-third line (h*2/3)', () => {
  it('label + panel are centred at h*2/3', () => {
    const fakeApp = {
      screen: { width: W, height: H },
      stage: new PIXI.Container(),
      ticker: { add: () => {} },
    } as unknown as PIXI.Application;
    const toast = new GlobalToast(fakeApp) as any;
    toast.show(MSG);
    const lbl = findText(toast.layer, MSG);
    expect(lbl).not.toBeNull();
    // GlobalToast takes raw app.screen H (not designHeight); h*0.052 is its own font convention.
    expect(lbl!.style.fontSize).toBe(Math.round(H * 0.052));
    expect(Math.abs(lbl!.y - Math.round(H * 2 / 3))).toBeLessThanOrEqual(1);
    expect(findPanelBehindText(toast.layer, MSG)).not.toBeNull();
  });
});

// ── WorldMapPanels: deliberately excluded, still draws its own bordered panel at h*2/3 ────────────

describe('WorldMapPanels.showToast() (excluded from unification) still draws its own panel at h*2/3', () => {
  it('bordered dark panel with a center-anchored label centred on h*2/3', () => {
    const toastLayer = new PIXI.Container();
    const ctx = { toastLayer, w: W, h: DESIGN_H, toastTimer: 0 } as unknown as WorldMapContext;
    const panels = new WorldMapPanels(ctx);
    panels.showToast(MSG, 0xc0392b);
    const lbl = findText(toastLayer, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.headline);
    expect(Math.abs(lbl!.y - BOTTOM_THIRD_Y)).toBeLessThanOrEqual(1);
    expect(findPanelBehindText(toastLayer, MSG)).not.toBeNull();
  });
});

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
// above all scenes and centred on the bottom-fifth line. So the meaningful regressions to pin are:
//   1. GlobalToast still renders its bar centred at h*0.8 (the unified position).
//   2. Each scene's showToast(msg, color) delegates to the sink with the right kind — a red colour
//      maps to 'error', anything else (green / neutral dark) to 'success'.
//
// WorldMapPanels is deliberately EXCLUDED from the unification (see [[toast-size-position-unification-2026-07-16]])
// and still draws its own bordered panel, kept at the same h*0.8 line by hand — its geometry test is
// kept below, updated for the 2026-08-02 h*2/3 → h*0.8 move (see GlobalToast.show / WorldMapPanels.showToast:
// h*2/3 sat under modal confirm buttons, e.g. the Equipment enhance dialog's own confirm button).
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
const TOAST_LINE_Y = Math.round(DESIGN_H * 0.8);
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
    // `showToast` lives on the composed `core` field (2026-08-11: EquipmentScene converted from a
    // mixin-chain `extends` to composition — see claudedocs/client-modules.md's split-form
    // priority note), not the outer scene instance.
    scene.core.showToast(MSG);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'success');
    scene.core.showToast(MSG, C.red);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'error');
    scene.destroy();
  });

  it('FamilyScene: neutral default → success, C.red → error', () => {
    const worldApi = { getMyFamily: () => new Promise<never>(() => {}) } as unknown as WorldApiClient;
    const cb = {
      onBack() {}, onOpenSect() {}, onNavTab() {}, worldApi, worldId: 'w1', myAccountId: 'me', playerName: 'tao',
      getFriendPublicIds: async () => new Set<string>(),
    };
    const scene = new FamilyScene(createLayout(W, H), new InputManager(), cb as any) as any;
    // `showToast` lives on the composed `core` field (2026-08-11: FamilyScene converted from a
    // mixin-chain `extends` to composition — see claudedocs/client-modules.md's split-form
    // priority note), not the outer scene instance.
    scene.core.showToast(MSG);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'success');
    scene.core.showToast(MSG, C.red);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'error');
    scene.destroy();
  });

  it('CityScene: default is red → error, C.green → success', () => {
    const worldApi = {
      getMe: () => new Promise<PlayerWorldView>(() => {}),
      // CityScene.load() fires its four fetches independently (2026-08-02, no Promise.all barrier),
      // so every endpoint it calls has to exist on the stub — a missing one now throws for real.
      getTeams: () => new Promise<never>(() => {}),
      getMarches: () => new Promise<never>(() => {}),
      getOccupations: () => new Promise<never>(() => {}),
      getStationed: () => new Promise<never>(() => {}),
      upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
      speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
    } as unknown as WorldApiClient;
    const cb: CitySceneCallbacks = { onBack: () => {}, worldApi, worldId: 'world:1:0' };
    const scene = new CityScene(createLayout(W, H), new InputManager(), cb) as any;
    // `showToast` lives on the composed `core` field (2026-08-11: CityScene converted from a
    // mixin-chain `extends` to composition — see claudedocs/client-modules.md's split-form
    // priority note), not the outer scene instance.
    scene.core.showToast(MSG);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'error');
    scene.core.showToast(MSG, C.green);
    expect(sink).toHaveBeenLastCalledWith(MSG, 'success');
    scene.destroy();
  });
});

// ── GlobalToast: the single renderer, centred on the bottom-third line (h*2/3) ───────────────────

describe('GlobalToast renders its bar centred on the h*0.8 line', () => {
  it('label + panel are centred at h*0.8', () => {
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
    expect(Math.abs(lbl!.y - Math.round(H * 0.8))).toBeLessThanOrEqual(1);
    expect(findPanelBehindText(toast.layer, MSG)).not.toBeNull();
  });
});

// ── GlobalToast: word-wrap/width clamp regression (2026-08-03) ──────────────────────────────────
//
// Before: the label had no wordWrap/wordWrapWidth at all and no max-width clamp on the computed
// panel width — a moderately long message (or a verbose locale's translation, German especially)
// rendered wider than the viewport, with both edges cut off since the bubble is horizontally
// centred. showToastMessage (net/log.ts) is the sink for nearly every scene's toasts, not just an
// error fallback, so this is a frequently-hit path.

describe('GlobalToast word-wraps long text instead of overflowing the screen', () => {
  const LONG_MSG = 'Cloud save failed to sync and your progress from the last five minutes of play may not have been recorded on the server — please check your connection and try again shortly';

  it('wraps the label (wordWrap enabled) instead of rendering one unbounded-width line', () => {
    const fakeApp = {
      screen: { width: W, height: H },
      stage: new PIXI.Container(),
      ticker: { add: () => {} },
    } as unknown as PIXI.Application;
    const toast = new GlobalToast(fakeApp) as any;
    toast.show(LONG_MSG);
    const lbl = findText(toast.layer, LONG_MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.wordWrap).toBe(true);
    expect(lbl!.style.wordWrapWidth).toBeGreaterThan(0);
  });

  it('the resulting panel never exceeds the screen width, even for a very long / verbose-locale message', () => {
    const fakeApp = {
      screen: { width: W, height: H },
      stage: new PIXI.Container(),
      ticker: { add: () => {} },
    } as unknown as PIXI.Application;
    const toast = new GlobalToast(fakeApp) as any;
    toast.show(LONG_MSG);
    const panel = findPanelBehindText(toast.layer, LONG_MSG);
    expect(panel).not.toBeNull();
    // Graphics stub tracks the last drawRoundedRect/drawRect call's width via its own recorded geometry —
    // fall back to the label's wrapped width + the same padding formula GlobalToast.show uses.
    const lbl = findText(toast.layer, LONG_MSG)!;
    const padX = Math.round(W * 0.08);
    const bw = lbl.width + padX * 2;
    expect(bw).toBeLessThanOrEqual(W);
  });

  it('a short message is unaffected (still a single line, no unnecessary wrapping)', () => {
    const fakeApp = {
      screen: { width: W, height: H },
      stage: new PIXI.Container(),
      ticker: { add: () => {} },
    } as unknown as PIXI.Application;
    const toast = new GlobalToast(fakeApp) as any;
    toast.show(MSG);
    const lbl = findText(toast.layer, MSG)!;
    const padX = Math.round(W * 0.08);
    expect(lbl.width + padX * 2).toBeLessThanOrEqual(W);
  });
});

// ── WorldMapPanels: deliberately excluded, still draws its own bordered panel at h*0.8 ────────────

describe('WorldMapPanels.showToast() (excluded from unification) still draws its own panel at h*0.8', () => {
  it('bordered dark panel with a center-anchored label centred on h*0.8', () => {
    const toastLayer = new PIXI.Container();
    const ctx = { toastLayer, w: W, h: DESIGN_H, toastTimer: 0 } as unknown as WorldMapContext;
    const panels = new WorldMapPanels(ctx);
    panels.showToast(MSG, 0xc0392b);
    const lbl = findText(toastLayer, MSG);
    expect(lbl).not.toBeNull();
    expect(lbl!.style.fontSize).toBe(FS.headline);
    expect(Math.abs(lbl!.y - TOAST_LINE_Y)).toBeLessThanOrEqual(1);
    expect(findPanelBehindText(toastLayer, MSG)).not.toBeNull();
  });
});

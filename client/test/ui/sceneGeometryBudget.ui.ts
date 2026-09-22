// A per-frame geometry budget for the screen players sit on longest.
//
// The regression this gate exists for (measured 2026-09-08 in real Chrome): the idle lobby was
// submitting 253,737 indices per frame — 82% of it four hand-drawn panel borders that never moved.
// `SketchPen.trace` needs a fresh `lineStyle` per segment for its taper, and with round caps and
// joins one 976x105 panel came out as 735 un-batchable primitives and 68,496 indices. Nothing was
// wrong with the code in review; it just looked like every other `SketchPen` call in the repo.
//
// So the guard is a NUMBER, not a rule about which helper to call. `render/panelFrame.ts`'s baked
// atlas is the cheap way to draw that same wobble, and any future frame drawn the expensive way —
// whichever helper it goes through — pushes this over budget and fails.
//
// How the count is taken: PIXI builds `Graphics` geometry (earcut + `buildLine`) in pure JS inside
// `GraphicsGeometry.updateBatches()`, which the renderer calls during a paint. There is no renderer
// in this harness, so the test calls it directly — that is what makes an exact triangle count
// available in CI with no GPU. `bake()` is given a stub renderer so the shipped (atlas) path is the
// one measured; without one every panel would fall back to live strokes and the budget would be
// measuring the fallback instead of the product.
//
// Run: npm run test:ui

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';
import { SketchPen } from '../../src/render/sketch';
import { clearBakeCache, setBakeRenderer } from '../../src/render/bake';
import { sketchPanel } from '../../src/render/sketchUi';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/**
 * Budget for one lobby paint, in indices (3 per triangle).
 *
 * Measured 15,582 in this harness after the fix. The budget sits above that with room for ordinary
 * UI work, and well below what ONE page-wide live-stroked panel costs (39,786 here — the case below
 * asserts exactly that), so the step change this exists to catch cannot slip under it. Raise it only
 * with a measurement saying the new geometry is genuinely needed.
 */
const LOBBY_INDEX_BUDGET = 25_000;

/**
 * Budget for one settings paint, in indices.
 *
 * This screen was found at **590,214** on 2026-09-09 — 2.3x the pre-ADR-083 lobby, and the most
 * expensive screen in the game at the time. Two causes, both invisible in review because the code
 * looked like every other `SketchPen` call: a third hand-rolled copy of the notebook background
 * that never called `bake()` (462,420 on its own — every other scene goes through
 * `buildPaperBackground`), and six live-stroked control frames (125,844). Both now go through the
 * baked atlas, measured **1,986** here.
 *
 * The budget is deliberately tighter than the lobby's: `render()` on this screen tears the whole
 * tree down and rebuilds it on every avatar-picker wheel tick and twice a second while the rename
 * caret blinks, so re-introducing even ONE live-stroked control here is paid far more often than
 * on a screen that is built once. 12,000 leaves 6x headroom for ordinary UI work while sitting
 * below 1,986 + the cheapest of the six frames that used to be here (13,482).
 */
const SETTINGS_INDEX_BUDGET = 12_000;

/** The lobby's own hero panel, as laid out on a 1280x631 desktop canvas — the 68,496-index one. */
const HERO_PANEL = { w: 976, h: 105 } as const;

/** Enough of a renderer for `bake()`: it reads `.resolution` and calls `.render()`. */
function stubBakeRenderer(): void {
  setBakeRenderer({ resolution: 1, render: () => {} } as unknown as PIXI.IRenderer);
}

/** Indices PIXI would submit for this subtree, with every `Graphics` geometry built on the spot. */
function indexCount(root: PIXI.DisplayObject): number {
  let total = 0;
  const visit = (o: PIXI.DisplayObject): void => {
    const geom = (o as PIXI.Graphics).geometry as (PIXI.Graphics['geometry'] | undefined);
    if (geom && typeof geom.updateBatches === 'function') {
      geom.updateBatches();
      total += geom.indices.length;
    }
    const kids = (o as PIXI.Container).children;
    if (kids) for (const k of kids) visit(k);
  };
  visit(root);
  return total;
}

function buildLobby(): LobbyScene {
  return new LobbyScene(createLayout(1280, 631), new InputManager(), {
    onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
    onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
    onOpenWorld() {}, onOpenLeaderboard() {},
    pvp: { rank: 'gold', elo: 1425 },
    playerName: 'Tester',
  });
}

beforeEach(() => {
  clearBakeCache();
  stubBakeRenderer();
});

afterEach(() => {
  clearBakeCache();
  setBakeRenderer(null as unknown as PIXI.IRenderer);
});

function buildSettings(): SettingsScene {
  return new SettingsScene(createLayout(1280, 631), new InputManager(), {
    onBack() {},
    openTextInput: createFakeTextInput().openTextInput,
    playerName: 'Tester',
    publicId: '123456789',
    pvp: { rank: 'gold', elo: 1425 },
    renameCost: 100,
    getCoins: () => 500,
    onLogout() {},
    onSetAvatar() {},
    avatarId: 'preset:a',
    onReplayTutorial() {},
  });
}

describe('lobby per-frame geometry', () => {
  it('stays inside the budget', () => {
    const lobby = buildLobby();
    const indices = indexCount(lobby.container);
    // Reported on failure: the number is the whole point of this test.
    expect(indices, `lobby geometry = ${indices} indices (budget ${LOBBY_INDEX_BUDGET})`)
      .toBeLessThan(LOBBY_INDEX_BUDGET);
    lobby.destroy();
  });

  it('would fail if a single page-wide panel went back to live strokes (the gate can fire)', () => {
    // A gate nobody has seen fail is not a gate. This is the exact call the lobby used to make for
    // its hero button, on the exact size it laid out — one of them is over budget on its own.
    const live = new PIXI.Graphics();
    live.beginFill(0x2c2c2a).drawRect(0, 0, HERO_PANEL.w, HERO_PANEL.h).endFill();
    new SketchPen(live, 5).rect(2, 2, HERO_PANEL.w - 4, HERO_PANEL.h - 4, {
      color: 0x4477cc, width: 2.4, jitter: 1.0,
    });
    expect(indexCount(live)).toBeGreaterThan(LOBBY_INDEX_BUDGET);
  });

  it('the baked panel draws the same frame for a rounding error of the cost', () => {
    const baked = sketchPanel(HERO_PANEL.w, HERO_PANEL.h, { fill: 0x2c2c2a, border: 0x4477cc, width: 2.4 });
    // Sprites off the atlas baseTexture, so the only geometry left is the flat fill rect.
    expect(indexCount(baked)).toBeLessThan(100);
    // ...and it is a real frame, not an empty container that trivially costs nothing.
    expect(baked.children.length).toBeGreaterThan(4);
  });

  // There is deliberately no "falls back to live strokes without a bake renderer" case here:
  // panelFrame.ts caches its sliced atlas at module level, so once ANY earlier test in the file has
  // built it, clearing bake.ts's cache no longer forces the fallback. That path is covered anyway —
  // every other test in this suite runs with no bake renderer at all.
});

/**
 * The states this screen can be in, each measured separately.
 *
 * The overlays are NOT in the tree when the scene is merely constructed, so a budget over the base
 * screen alone leaves `SettingsScene/overlays.ts` and `avatarPicker.ts` unguarded — and the rename
 * field is the single most-often-rebuilt piece of geometry on the screen (the caret blinks twice a
 * second, and `render()` rebuilds the whole tree each time). Measured 2026-09-09, in order:
 * 2,004 / 2,034 / 2,028 / 12,366.
 *
 * The picker gets its own, larger budget: its 20 avatar tiles are ~600 indices each of real,
 * already-baked art, and there is no way to express that as a smaller number. It is still far below
 * one live-stroked control, which is what the budget is for.
 */
const SETTINGS_STATES: Array<{ name: string; open: (s: SettingsScene) => void; budget: number }> = [
  { name: 'base screen',    open: () => {},                        budget: SETTINGS_INDEX_BUDGET },
  { name: 'rename overlay', open: (s) => { s.openRename(); },       budget: SETTINGS_INDEX_BUDGET },
  { name: 'delete confirm', open: (s) => { s.openDelete(); },       budget: SETTINGS_INDEX_BUDGET },
  { name: 'avatar picker',  open: (s) => { s.openAvatarPicker(); }, budget: 20_000 },
];

describe('settings per-frame geometry', () => {
  for (const state of SETTINGS_STATES) {
    it(`stays inside the budget — ${state.name}`, () => {
      const settings = buildSettings();
      state.open(settings);
      const indices = indexCount(settings.container);
      expect(indices, `settings (${state.name}) = ${indices} indices (budget ${state.budget})`)
        .toBeLessThan(state.budget);
      settings.destroy();
    });
  }

  it('draws the notebook page as a baked sprite, not 27 live ruled lines', () => {
    // The specific regression: SettingsScene.drawBackground() used to stroke the ruled lines and the
    // red margin rule itself and add the raw Graphics to the tree. A budget alone would catch that,
    // but only for as long as the number stays where it is — this pins the mechanism, so a future
    // resize/refactor cannot quietly put the live copy back under a raised budget.
    const settings = buildSettings();
    const page = settings.container.children[0]!;
    expect(page).toBeInstanceOf(PIXI.Sprite);
    expect(indexCount(page)).toBe(0);
    settings.destroy();
  });

  it('would fail if the background went back to live strokes (the gate can fire)', () => {
    // The exact loop that used to be in drawBackground(), on the exact canvas it laid out.
    const w = 1280, h = 631;
    const live = new PIXI.Graphics();
    live.beginFill(0xf4efe2).drawRect(0, 0, w, h).endFill();
    const pen = new SketchPen(live, 0x5bd1c7);
    const lineGap = Math.round(h / 28);
    for (let y = lineGap; y < h; y += lineGap) {
      pen.line(0, y, w, y, { color: 0xb9cfe4, width: 1.1, jitter: 0.7, taper: 0.9, double: false });
    }
    pen.line(Math.round(w * 0.09), 0, Math.round(w * 0.09), h, { color: 0xcc4433, width: 2.2, jitter: 1.0, taper: 0.95 });
    expect(indexCount(live)).toBeGreaterThan(SETTINGS_INDEX_BUDGET);
  });
});

// ── Battle screen (GameRenderer) — the screen this gate was missing (2026-09-22) ──────────────────
//
// The regression this half of the file exists for: HUD HP bars, HUD buttons, the upgrade glow, unit/
// building HP bars, unit body sketches and faction markers were ALL live-`Graphics`, re-triangulated
// every single frame — `test/liveStrokedInkCallSites.test.ts` even had them in a bucket labeled
// "GAMEPLAY — redrawn every frame by design", so nothing here ever looked like a bug in review.
// Measured 2026-09-22 in real Chrome (1280x631, vs-AI match, 120 frames): 96,534 indices in one
// frame, 10,173 of them re-triangulated on EVERY frame — the battle screen never had a budget at
// all, which is exactly how the lobby/settings regressions above went undetected as long as they
// did. See claudedocs/client-render-budget.md for the full accounting.
//
// A local-vs-AI campaign match (ch1_lv1) is used instead of a synthetic scene so every layer that
// spawns real geometry (HUD, board, at least the AI's own units/buildings) gets exercised the same
// way a real match would — same shape as gameRendererEvents.ui.ts's buildRenderer(). `.tao` decode
// fails in this headless harness (no real zip/DOM), so units render via the circle-placeholder path
// (stickmanDraft.ts's draft figure + the faction marker) — the exact geometry this change bakes.

/** Same shape as gameRendererEvents.ui.ts's buildRenderer(): a real local-vs-AI campaign match. */
function buildBattleRenderer(): { renderer: GameRenderer } {
  const level = getLevel('ch1_lv1')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(1280, 631);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  return { renderer };
}

/**
 * Indices re-triangulated across `frames` calls to `tick()`, divided by `frames` — the per-frame
 * average rebuild cost. A `Graphics`' `geometry.dirty` counter (protected in the type defs, real at
 * runtime — see GraphicsGeometry.js) increments once per `drawShape`/`clear()` call, so comparing it
 * frame to frame is exactly "did this node get re-triangulated just now", with no renderer needed to
 * observe it. Only counted the frame it actually changes — unlike {@link indexCount}, this must NOT
 * charge every frame for geometry that hasn't moved, or it would just be `indexCount` in a loop.
 */
function perFrameRebuildIndices(root: PIXI.DisplayObject, frames: number, tick: () => void): number {
  const lastDirty = new WeakMap<object, number>();
  let total = 0;
  const visit = (o: PIXI.DisplayObject): void => {
    const geom = (o as PIXI.Graphics).geometry as (PIXI.Graphics['geometry'] & { dirty?: number }) | undefined;
    if (geom && typeof geom.updateBatches === 'function' && typeof geom.dirty === 'number') {
      const prev = lastDirty.get(geom);
      if (prev !== geom.dirty) {
        lastDirty.set(geom, geom.dirty);
        geom.updateBatches();
        total += geom.indices.length;
      }
    }
    const kids = (o as PIXI.Container).children;
    if (kids) for (const k of kids) visit(k);
  };
  for (let i = 0; i < frames; i++) {
    tick();
    visit(root);
  }
  return total;
}

/**
 * Static submitted geometry for one battle frame, in indices.
 *
 * Measured 9,090 in this harness (a stub renderer, so the sprite/bake paths this change adds are the
 * ones counted — see this file's shared `stubBakeRenderer()`; `.tao` decode fails headless, so this
 * is the circle-placeholder path's cost, not the real client's `.tao` sprites). Budget leaves ~2x
 * headroom for ordinary match variance (more units alive, more HUD chrome) — raise it only with a
 * measurement.
 */
const BATTLE_STATIC_INDEX_BUDGET = 18_000;

/**
 * Per-frame REBUILD geometry for the battle screen, in indices/frame — the number this whole change
 * exists to shrink. Measured 89/frame in this harness after the fix (10,173/frame in real Chrome
 * before it — see file-header comment); budget is set well below the pre-fix number so a HUD bar /
 * unit bar / upgrade glow regressing back to a per-frame `clear()`+redraw fails this test long
 * before it reaches a user's battery, with headroom over the measured 89 for ordinary match
 * variance (units taking damage, more bars visible at once).
 */
const BATTLE_REBUILD_INDEX_BUDGET = 1_500;

describe('battle screen (GameRenderer) per-frame geometry', () => {
  it('static: one frame after warm-up stays inside the budget', () => {
    const { renderer } = buildBattleRenderer();
    for (let i = 0; i < 600; i++) renderer.update(1 / 30);
    const indices = indexCount(renderer.container);
    expect(indices, `battle static geometry = ${indices} indices (budget ${BATTLE_STATIC_INDEX_BUDGET})`)
      .toBeLessThan(BATTLE_STATIC_INDEX_BUDGET);
  });

  it('per-frame rebuild: stays far below the pre-fix 10,173/frame', () => {
    const { renderer } = buildBattleRenderer();
    const avg = perFrameRebuildIndices(renderer.container, 120, () => renderer.update(1 / 30)) / 120;
    expect(avg, `battle rebuild geometry = ${avg.toFixed(0)} indices/frame (budget ${BATTLE_REBUILD_INDEX_BUDGET})`)
      .toBeLessThan(BATTLE_REBUILD_INDEX_BUDGET);
  });
});

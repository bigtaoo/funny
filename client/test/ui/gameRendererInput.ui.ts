// GameRenderer InputMixin coverage — drag-to-place, tap-select-to-place, and the reject branches
// (occupied lane / occupied building cell / drop outside board). Added alongside the
// GameRenderer.ts → GameRenderer/{base,input,events}.ts mixin split: the startup smoke in
// gameScenes.ui.ts proves the scene builds/steps/destroys, but never actually drives a card
// placement — this file closes that gap for the input domain.
//
// Same headless approach as gameScenes.ui.ts: the pixiHeadless adapter (vitest.ui.config.ts
// setupFiles) builds the real PIXI tree in plain Node; InputManager's `_emitDown/_emitMove/_emitUp`
// are called directly (the same entry points a platform adapter would call), so this exercises the
// real handleDown/handleMove/handleUp chain, not a re-implementation of it.
//
// Level: ch1_lv1 (startInk: 40, deterministic seed 65537 — same level already used by
// gameScenes.ui.ts's recordCampaignReplay). After 5 ticks the bottom hand is deterministically
// [tower_1, barracks_2, shieldbearer_1, tower_2, tower_1, barracks_2] — verified once via a scratch
// probe and pinned here; if CARD_DEFINITIONS or the draw RNG ever changes this, these tests fail
// loudly rather than silently drawing the wrong card type.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';

// In-memory storage so initI18n (which persists the locale) has somewhere to write.
const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Hand-slot indices in the deterministic ch1_lv1 opening hand (see file banner). */
const SLOT_UNIT_SHIELDBEARER = 2; // cost 6
const SLOT_BUILDING_TOWER_A  = 0; // cost 12
const SLOT_BUILDING_TOWER_B  = 3; // cost 12

function buildRenderer() {
  const level = getLevel('ch1_lv1')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(800, 1280);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  // Settle the initial hand deal (staggered draw timers) before hit-testing hand cards —
  // HandView only populates its slot containers on the first sync() (driven by update()).
  for (let i = 0; i < 5; i++) renderer.update(1 / 30);
  return { engine, layout, input, renderer };
}

describe('GameRenderer InputMixin — drag to place', () => {
  it('dragging a unit card onto an attack lane calls engine.playCard(handIndex, col)', () => {
    const { engine, layout, input, renderer } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');

    const from = (renderer as any).handView.slotCenter(SLOT_UNIT_SHIELDBEARER);
    const to   = layout.gridToScreen(1, 1); // col 1 is an attack lane; row 1 = bottom spawn row

    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y); // far past DRAG_THRESHOLD → starts a card drag
    input._emitUp(to.x, to.y);

    expect(playCard).toHaveBeenCalledWith(SLOT_UNIT_SHIELDBEARER, 1);
    expect((renderer as any).drag).toBeNull();
    renderer.destroy();
  });

  it('dragging a building card onto a free cell calls engine.playCard(handIndex, col)', () => {
    const { engine, layout, input, renderer } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');

    const from = (renderer as any).handView.slotCenter(SLOT_BUILDING_TOWER_A);
    const to   = layout.gridToScreen(3, 0); // row 0 = bottom building row

    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y);
    input._emitUp(to.x, to.y);

    expect(playCard).toHaveBeenCalledWith(SLOT_BUILDING_TOWER_A, 3);
    renderer.destroy();
  });

  it('rejects a second building dropped on a cell that already has one — engine.playCard is not called again', () => {
    const { engine, layout, input, renderer } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');
    const col = 3;
    const buildRect = layout.gridToScreen(col, 0);

    // First building lands normally.
    const from1 = (renderer as any).handView.slotCenter(SLOT_BUILDING_TOWER_A);
    input._emitDown(from1.x, from1.y);
    input._emitMove(buildRect.x, buildRect.y);
    input._emitUp(buildRect.x, buildRect.y);
    expect(playCard).toHaveBeenCalledTimes(1);

    // The play_card command is only processed on a later tick (LocalInputSource queues it) —
    // advance the engine so hasBuildingAt() actually reflects the placement.
    for (let i = 0; i < 5; i++) renderer.update(1 / 30);
    expect(engine.state.board.hasBuildingAt(col, 0)).toBe(true);

    // Second building dragged onto the SAME cell must be rejected by
    // commitCardPlay's hasBuildingAt() guard — no second engine.playCard call.
    const from2 = (renderer as any).handView.slotCenter(SLOT_BUILDING_TOWER_B);
    input._emitDown(from2.x, from2.y);
    input._emitMove(buildRect.x, buildRect.y);
    input._emitUp(buildRect.x, buildRect.y);

    expect(playCard).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('dropping a dragged card outside the board cancels the drag without playing it', () => {
    const { engine, renderer, input } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');

    const from    = (renderer as any).handView.slotCenter(SLOT_BUILDING_TOWER_A);
    const outside = { x: -5000, y: -5000 };
    input._emitDown(from.x, from.y);
    input._emitMove(outside.x, outside.y); // far past DRAG_THRESHOLD → starts a card drag
    input._emitUp(outside.x, outside.y);

    expect(playCard).not.toHaveBeenCalled();
    expect((renderer as any).drag).toBeNull();
    expect((renderer as any).pendingCardDown).toBeNull();
    renderer.destroy();
  });
});

describe('GameRenderer InputMixin — tap-select to place', () => {
  it('tapping the same hand card twice toggles the selection off', () => {
    const { renderer, input } = buildRenderer();
    const center = (renderer as any).handView.slotCenter(SLOT_UNIT_SHIELDBEARER);

    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y);
    expect((renderer as any).tapSelect?.handIndex).toBe(SLOT_UNIT_SHIELDBEARER);

    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y);
    expect((renderer as any).tapSelect).toBeNull();
    renderer.destroy();
  });

  it('tap-select a unit card, then tap a board lane, calls engine.playCard(handIndex, col)', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');
    const center = (renderer as any).handView.slotCenter(SLOT_UNIT_SHIELDBEARER);

    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y);
    expect((renderer as any).tapSelect?.handIndex).toBe(SLOT_UNIT_SHIELDBEARER);

    const boardPt = layout.gridToScreen(1, 1);
    input._emitDown(boardPt.x, boardPt.y);
    input._emitUp(boardPt.x, boardPt.y);

    expect(playCard).toHaveBeenCalledWith(SLOT_UNIT_SHIELDBEARER, 1);
    expect((renderer as any).tapSelect).toBeNull();
    renderer.destroy();
  });
});

describe('GameRenderer InputMixin — placement highlight stays in sync with board state', () => {
  it('a lane blocked by an occupied spawn-row cell un-blocks on the next tick once the cell frees up, with no pointer movement', () => {
    const { engine, layout, renderer } = buildRenderer();
    const boardView = (renderer as any).boardView;
    const spy = vi.spyOn(boardView, 'showUnitLaneHighlights');
    const lane = 1;
    const spawnRow = (renderer as any).localSpawnRow;
    const unitGrid = (engine.state.board as any).unitGrid;

    // Fake-occupy the spawn-row cell directly (equivalent to a unit currently standing there).
    unitGrid[spawnRow][lane] = 12345;

    const from = (renderer as any).handView.slotCenter(SLOT_UNIT_SHIELDBEARER);
    const to   = layout.gridToScreen(lane, 1);
    // handleDown/handleMove — same drag-start path as the "drag to place" tests above.
    (renderer as any).handleDown(from.x, from.y);
    (renderer as any).handleMove(to.x, to.y);

    expect(spy).toHaveBeenLastCalledWith(expect.anything(), new Set([lane]), lane);

    // The unit walks away from the spawn-row cell — board state changes, but the pointer doesn't move.
    // The refresh is throttled to ~10Hz (see HIGHLIGHT_REFRESH_INTERVAL in input.ts), so advance
    // past that window rather than a single frame.
    unitGrid[spawnRow][lane] = null;
    for (let i = 0; i < 5; i++) renderer.update(1 / 30);

    expect(spy).toHaveBeenLastCalledWith(expect.anything(), new Set(), lane);
    renderer.destroy();
  });
});

describe('GameRenderer InputMixin — upgrade button (tap, no drag)', () => {
  it('a plain tap on the upgrade button calls engine.upgradeBase() immediately', () => {
    const { engine, renderer, input } = buildRenderer();
    const upgradeBase = vi.spyOn(engine, 'upgradeBase');
    const hudView = (renderer as any).hudView;

    expect(hudView.upgradeEnabled).toBe(true); // ch1_lv1 startInk 40 >= level-1 cost 30
    const rect = hudView.getUpgradeRect();
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;

    input._emitDown(x, y);
    input._emitUp(x, y); // release at the SAME point — a tap, not a drag onto the base

    expect(upgradeBase).toHaveBeenCalledTimes(1);
    expect((renderer as any).drag).toBeNull();
    renderer.destroy();
  });

  it('tapping the upgrade button while unaffordable does not call engine.upgradeBase()', () => {
    const { engine, renderer, input } = buildRenderer();
    const upgradeBase = vi.spyOn(engine, 'upgradeBase');
    const hudView = (renderer as any).hudView;
    hudView.upgradeEnabled = false; // simulate insufficient ink

    const rect = hudView.getUpgradeRect();
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;

    input._emitDown(x, y);
    input._emitUp(x, y);

    expect(upgradeBase).not.toHaveBeenCalled();
    renderer.destroy();
  });
});

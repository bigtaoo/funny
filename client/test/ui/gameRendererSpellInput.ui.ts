// GameRenderer InputMixin coverage — column-targeted PvE level spells (rockslide, bridge_collapse).
// Regression test: commitCardPlay/updatePlacementHighlights only wired up Haste and Meteor in the
// CardType.Spell branch, so tapping/dragging a rockslide or bridge_collapse card onto the board
// silently did nothing (engine.playCard was never called). Fixed alongside BoardView.showColumnTargetHighlight.
//
// Same headless approach as gameRendererInput.ui.ts: the pixiHeadless adapter builds the real PIXI
// tree in plain Node; InputManager's `_emitDown/_emitMove/_emitUp` drive the real
// handleDown/handleMove/handleUp chain.
//
// Level: ch2_lv5 (startInk: 8, levelSpells: rockslide×1 + bridge_collapse×1 — both affordable from
// the opening hand). Hand slot indices for the injected spells are looked up by card id rather than
// pinned, since only the deterministic PRESENCE of the injected spells (not their exact slot) is
// guaranteed by levelSpells (see laneLengthLevelSpells.test.ts).

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

function buildRenderer() {
  const level = getLevel('ch2_lv5')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(800, 1280);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  // Settle the initial hand deal before hit-testing hand cards.
  for (let i = 0; i < 5; i++) renderer.update(1 / 30);
  return { engine, layout, input, renderer };
}

function findHandSlot(engine: ReturnType<typeof createLocalMatch>['engine'], cardId: string): number {
  const player = engine.state.bottomPlayer;
  const slot = player.hand.slots.findIndex(s => s?.card?.id === cardId);
  expect(slot).toBeGreaterThanOrEqual(0);
  return slot;
}

describe('GameRenderer InputMixin — column-targeted spell cards', () => {
  it('tap-select rockslide, then tap a board column, calls engine.playCard(handIndex, col)', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');
    const slot = findHandSlot(engine, 'rockslide');
    const center = (renderer as any).handView.slotCenter(slot);

    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y);
    expect((renderer as any).tapSelect?.handIndex).toBe(slot);

    const boardPt = layout.gridToScreen(3, 5);
    input._emitDown(boardPt.x, boardPt.y);
    input._emitUp(boardPt.x, boardPt.y);

    expect(playCard).toHaveBeenCalledWith(slot, 3);
    expect((renderer as any).tapSelect).toBeNull();
    renderer.destroy();
  });

  it('tap-select bridge_collapse, then tap a board column, calls engine.playCard(handIndex, col)', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');
    const slot = findHandSlot(engine, 'bridge_collapse');
    const center = (renderer as any).handView.slotCenter(slot);

    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y);
    expect((renderer as any).tapSelect?.handIndex).toBe(slot);

    const boardPt = layout.gridToScreen(5, 5);
    input._emitDown(boardPt.x, boardPt.y);
    input._emitUp(boardPt.x, boardPt.y);

    expect(playCard).toHaveBeenCalledWith(slot, 5);
    expect((renderer as any).tapSelect).toBeNull();
    renderer.destroy();
  });

  it('dragging a rockslide card onto the board calls engine.playCard(handIndex, col)', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');
    const slot = findHandSlot(engine, 'rockslide');
    const from = (renderer as any).handView.slotCenter(slot);
    const to   = layout.gridToScreen(7, 5);

    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y); // far past DRAG_THRESHOLD → starts a card drag
    input._emitUp(to.x, to.y);

    expect(playCard).toHaveBeenCalledWith(slot, 7);
    expect((renderer as any).drag).toBeNull();
    renderer.destroy();
  });

  it('dropping a dragged rockslide card outside the board cancels without playing it', () => {
    const { engine, renderer, input } = buildRenderer();
    const playCard = vi.spyOn(engine, 'playCard');
    const slot = findHandSlot(engine, 'rockslide');
    const from    = (renderer as any).handView.slotCenter(slot);
    const outside = { x: -5000, y: -5000 };

    input._emitDown(from.x, from.y);
    input._emitMove(outside.x, outside.y);
    input._emitUp(outside.x, outside.y);

    expect(playCard).not.toHaveBeenCalled();
    expect((renderer as any).drag).toBeNull();
    renderer.destroy();
  });
});

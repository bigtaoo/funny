// GameRenderer InputMixin — spell-target unit outline preview (2026-08-08 fix). User feedback: for
// AoE spells in PvP/PvE — especially the frequently-used 2×2 Meteor — there was no visual cue for
// which units actually sit inside the target footprint, so casts kept missing the intended unit.
// updatePlacementHighlights (input.ts) now computes the exact unit-id set inside the hovered/dragged
// footprint (mirroring SpellSystem.castMeteor's 2×2-and-enemies-only hit test, and
// castRockslide's whole-column-both-sides hit test) and hands it to UnitView.setSpellTargetPreview,
// which asserts an outline flash on each matching unit's StickmanRuntime.
//
// These tests assert against `unitView.previewUnitIds` directly rather than pixel/texture state —
// the id set is exactly what setSpellTargetPreview() diffs against, and is populated regardless of
// whether a unit's .tao asset has finished loading (see UnitView.setSpellTargetPreview doc comment),
// so this is a fast, deterministic check of the actual hit-test logic without waiting on async asset
// loads. Same headless approach as gameRendererSpellInput.ui.ts (pixiHeadless adapter, real
// InputManager → real handleDown/handleMove/handleUp chain).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel, Side, UnitType } from '../../src/game';
import { CARD_DEFINITIONS, SPELL_CARD_DEFS } from '@nw/engine/config';
import { Unit } from '@nw/engine/Unit';
import { toFp } from '@nw/engine/math/fixed';

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

const meteorCard    = CARD_DEFINITIONS.find((c) => c.id === 'meteor_1')!;
const rockslideCard = SPELL_CARD_DEFS.get('rockslide')!;

function buildRenderer() {
  const level = getLevel('ch2_lv5')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(800, 1280);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  // Settle the initial hand deal before hit-testing hand cards.
  for (let i = 0; i < 5; i++) renderer.update(1 / 30);
  return { engine, layout, renderer, input };
}

/** Force a known card into hand slot 0 with ample ink, bypassing the random draw pool (same pattern as GameEngine.test.ts). */
function forceHandSlot(engine: ReturnType<typeof createLocalMatch>['engine'], card: typeof meteorCard): void {
  const p = engine.state.bottomPlayer;
  p.hand.drawIntoSlot(0, card, 9999);
  p.addInkFp(toFp(100));
}

describe('GameRenderer InputMixin — spell target unit preview', () => {
  it('dragging Meteor over the board previews only enemy units inside the 2×2 footprint, sparing friendlies', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    forceHandSlot(engine, meteorCard);

    // 2×2 anchored at (col=3,row=5) covers cells (3,5) (4,5) (3,6) (4,6).
    const insideEnemy   = new Unit(UnitType.Infantry, Side.Top,    4, 6); // inside, enemy → hit
    const outsideEnemy  = new Unit(UnitType.Infantry, Side.Top,    6, 6); // outside → spared
    const insideFriend  = new Unit(UnitType.Infantry, Side.Bottom, 3, 5); // inside but own side → Meteor spares it
    engine.state.board.addUnit(insideEnemy);
    engine.state.board.addUnit(outsideEnemy);
    engine.state.board.addUnit(insideFriend);

    const from = (renderer as any).handView.slotCenter(0);
    const to   = layout.gridToScreen(3, 5);
    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y); // past DRAG_THRESHOLD → starts the card drag, hovering (3,5)

    const preview: Set<number> = (renderer as any).unitView.previewUnitIds;
    expect(preview.has(insideEnemy.id)).toBe(true);
    expect(preview.has(outsideEnemy.id)).toBe(false);
    expect(preview.has(insideFriend.id)).toBe(false);
    expect(preview.size).toBe(1);

    renderer.destroy();
  });

  it('moving the drag to a new anchor recomputes the preview (units correctly drop out / in)', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    forceHandSlot(engine, meteorCard);

    const nearOrigin = new Unit(UnitType.Infantry, Side.Top, 1, 1);
    const nearFar     = new Unit(UnitType.Infantry, Side.Top, 8, 8);
    engine.state.board.addUnit(nearOrigin);
    engine.state.board.addUnit(nearFar);

    const from = (renderer as any).handView.slotCenter(0);
    input._emitDown(from.x, from.y);

    const p1 = layout.gridToScreen(1, 1);
    input._emitMove(p1.x, p1.y);
    let preview: Set<number> = (renderer as any).unitView.previewUnitIds;
    expect(preview.has(nearOrigin.id)).toBe(true);
    expect(preview.has(nearFar.id)).toBe(false);

    const p2 = layout.gridToScreen(8, 8);
    input._emitMove(p2.x, p2.y);
    preview = (renderer as any).unitView.previewUnitIds;
    expect(preview.has(nearOrigin.id)).toBe(false);
    expect(preview.has(nearFar.id)).toBe(true);

    renderer.destroy();
  });

  it('cancelling a Meteor drag (drop outside the board) clears the preview', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    forceHandSlot(engine, meteorCard);

    const enemy = new Unit(UnitType.Infantry, Side.Top, 4, 6);
    engine.state.board.addUnit(enemy);

    const from = (renderer as any).handView.slotCenter(0);
    const to   = layout.gridToScreen(3, 5);
    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y);
    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(1);

    input._emitMove(-5000, -5000); // off board
    input._emitUp(-5000, -5000);   // cancels the drag

    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(0);
    renderer.destroy();
  });

  it('tap-selecting Meteor, then hovering the board, previews the footprint under the pointer', () => {
    // Unlike Rockslide/BridgeCollapse, Meteor's tap-select mode DOES track the pointer live
    // (the `tapSelect?.spellType === SpellType.Meteor` branch in handleMove) — this is the
    // primary path a player actually aims a tap-selected Meteor with before tapping to confirm.
    const { engine, layout, renderer, input } = buildRenderer();
    forceHandSlot(engine, meteorCard);

    const enemy = new Unit(UnitType.Infantry, Side.Top, 4, 6); // inside the 2×2 anchored at (3,5)
    engine.state.board.addUnit(enemy);

    const center = (renderer as any).handView.slotCenter(0);
    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y); // tap-select, no drag
    expect((renderer as any).tapSelect?.handIndex).toBe(0);
    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(0); // nothing hovered yet

    const boardPt = layout.gridToScreen(3, 5);
    input._emitMove(boardPt.x, boardPt.y);

    expect(((renderer as any).unitView.previewUnitIds as Set<number>).has(enemy.id)).toBe(true);
    renderer.destroy();
  });

  it('cancelling a Meteor tap-select clears the preview', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    forceHandSlot(engine, meteorCard);

    const enemy = new Unit(UnitType.Infantry, Side.Top, 4, 6);
    engine.state.board.addUnit(enemy);

    const center = (renderer as any).handView.slotCenter(0);
    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y);
    const boardPt = layout.gridToScreen(3, 5);
    input._emitMove(boardPt.x, boardPt.y);
    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(1);

    // Tapping the already-selected card again deselects (cancelTapSelect).
    input._emitDown(center.x, center.y);
    input._emitUp(center.x, center.y);

    expect((renderer as any).tapSelect).toBeNull();
    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(0);
    renderer.destroy();
  });

  it('a dead unit inside the Meteor footprint is never previewed', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    forceHandSlot(engine, meteorCard);

    const dead = new Unit(UnitType.Infantry, Side.Top, 4, 6);
    dead.hp = 0; // isDead → true; mirrors SpellSystem.castMeteor's `if (unit.isDead) continue`
    engine.state.board.addUnit(dead);

    const from = (renderer as any).handView.slotCenter(0);
    const to   = layout.gridToScreen(3, 5);
    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y);

    expect(((renderer as any).unitView.previewUnitIds as Set<number>).has(dead.id)).toBe(false);
    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(0);
    renderer.destroy();
  });

  it('switching the drag away from Meteor to any other card clears the leftover spell-target preview', () => {
    // Regression guard for the top-of-updatePlacementHighlights default: every branch other than
    // Meteor/Rockslide must still end up passing an empty set to setSpellTargetPreview, not skip
    // the call and leave a stale outline from the previous (spell) selection.
    const { engine, layout, renderer, input } = buildRenderer();
    forceHandSlot(engine, meteorCard);

    const enemy = new Unit(UnitType.Infantry, Side.Top, 4, 6);
    engine.state.board.addUnit(enemy);

    const meteorFrom = (renderer as any).handView.slotCenter(0);
    const boardPt     = layout.gridToScreen(3, 5);
    input._emitDown(meteorFrom.x, meteorFrom.y);
    input._emitMove(boardPt.x, boardPt.y);
    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(1);
    input._emitMove(-5000, -5000);
    input._emitUp(-5000, -5000); // cancel the meteor drag

    // Now drag whatever other card RNG dealt into some other slot onto the board.
    const player = engine.state.bottomPlayer;
    const otherSlot = player.hand.slots.findIndex((s, i) => i !== 0 && !!s);
    expect(otherSlot).toBeGreaterThanOrEqual(0);
    player.addInkFp(toFp(100));
    const otherFrom = (renderer as any).handView.slotCenter(otherSlot);
    const otherTo   = layout.gridToScreen(2, 15);
    input._emitDown(otherFrom.x, otherFrom.y);
    input._emitMove(otherTo.x, otherTo.y);

    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(0);
    renderer.destroy();
  });

  it('dragging Rockslide over a column previews every unit in it, both sides alike', () => {
    // Rockslide's tap-select mode has no live pointer-hover preview (only Meteor's tap-select
    // wires handleMove → updatePlacementHighlights, see input.ts) — that's a pre-existing gap
    // unrelated to this fix, so this exercises the drag path instead (same as
    // gameRendererSpellInput.ui.ts's "dragging a rockslide card" coverage), which does call
    // updatePlacementHighlights with the real hovered column on every pointer move.
    const { engine, layout, renderer, input } = buildRenderer();
    const p = engine.state.bottomPlayer;
    p.hand.drawIntoSlot(0, rockslideCard, 9999);
    p.addInkFp(toFp(100));

    const inCol      = new Unit(UnitType.Infantry, Side.Top,    5, 6);
    const inColFriend = new Unit(UnitType.Infantry, Side.Bottom, 5, 10); // Rockslide has no side filter (castRockslide)
    const otherCol    = new Unit(UnitType.Infantry, Side.Top,    6, 6);
    engine.state.board.addUnit(inCol);
    engine.state.board.addUnit(inColFriend);
    engine.state.board.addUnit(otherCol);

    const from    = (renderer as any).handView.slotCenter(0);
    const boardPt = layout.gridToScreen(5, 5);
    input._emitDown(from.x, from.y);
    input._emitMove(boardPt.x, boardPt.y); // past DRAG_THRESHOLD → starts the card drag, hovering col 5

    const preview: Set<number> = (renderer as any).unitView.previewUnitIds;
    expect(preview.has(inCol.id)).toBe(true);
    expect(preview.has(inColFriend.id)).toBe(true);
    expect(preview.has(otherCol.id)).toBe(false);
    expect(preview.size).toBe(2);

    renderer.destroy();
  });

  it('a dead unit in the Rockslide column is never previewed', () => {
    const { engine, layout, renderer, input } = buildRenderer();
    const p = engine.state.bottomPlayer;
    p.hand.drawIntoSlot(0, rockslideCard, 9999);
    p.addInkFp(toFp(100));

    const dead = new Unit(UnitType.Infantry, Side.Top, 5, 6);
    dead.hp = 0; // mirrors SpellSystem.castRockslide's `if (unit.isDead) continue`
    engine.state.board.addUnit(dead);

    const from    = (renderer as any).handView.slotCenter(0);
    const boardPt = layout.gridToScreen(5, 5);
    input._emitDown(from.x, from.y);
    input._emitMove(boardPt.x, boardPt.y);

    expect(((renderer as any).unitView.previewUnitIds as Set<number>).has(dead.id)).toBe(false);
    expect(((renderer as any).unitView.previewUnitIds as Set<number>).size).toBe(0);
    renderer.destroy();
  });
});

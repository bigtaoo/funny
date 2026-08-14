// GameRenderer/input.ts's placement-highlight logic, extracted as form① (claudedocs/client-modules.md
// "单文件 500 行收敛") — pure functions of `core` + explicit params, no InputPanel instance state
// involved, same "pass the shared Core object directly" shape as CardScene/feedList.ts's
// drawFuseCandidateRow(core, ...).
import { ATTACK_LANES, BOARD_COLS } from '@nw/engine/config';
import { CardType, SpellType } from '../../game';
import type { GameRendererCore } from './core';

/** Shared empty set passed to UnitView.setSpellTargetPreview when no AoE spell is being aimed. */
export const EMPTY_UNIT_IDS: ReadonlySet<number> = new Set();

/** Enemy units (Meteor spares the caster's own side) whose integer cell falls in the 2×2 area anchored at (col, row) — mirrors SpellSystem.castMeteor's hit test. */
function meteorTargetUnits(core: GameRendererCore, col: number, row: number): Set<number> {
  const targets = new Set<number>();
  const maxCol = col + 1;
  const maxRow = row + 1;
  for (const unit of core.engine.state.board.units.values()) {
    if (unit.isDead) continue;
    if (unit.side === core.layout.localSide) continue; // never hit own units — see SpellSystem.castMeteor
    if (unit.col >= col && unit.col <= maxCol && unit.row >= row && unit.row <= maxRow) targets.add(unit.id);
  }
  return targets;
}

/** All units (both sides) standing in `col` — mirrors SpellSystem.castRockslide's hit test (no side filter). */
function columnTargetUnits(core: GameRendererCore, col: number): Set<number> {
  const targets = new Set<number>();
  for (const unit of core.engine.state.board.units.values()) {
    if (unit.isDead) continue;
    if (unit.col === col) targets.add(unit.id);
  }
  return targets;
}

export function updatePlacementHighlights(
  core: GameRendererCore,
  cardType: CardType, spellType: SpellType | undefined,
  col: number, row: number, x: number, y: number,
): void {
  core.boardView.clearHighlights();
  let spellTargets: Set<number> | null = null;

  switch (cardType) {
    case CardType.Unit: {
      const blocked = new Set<number>();
      for (const lane of ATTACK_LANES) {
        if (core.engine.state.board.isCellOccupiedByUnit(lane, core.localSpawnRow)) blocked.add(lane);
      }
      core.boardView.showUnitLaneHighlights(Array.from(ATTACK_LANES), blocked, col);
      break;
    }
    case CardType.Building: {
      const valid: number[] = [];
      for (let c = 0; c < BOARD_COLS; c++) {
        if (!(ATTACK_LANES as readonly number[]).includes(c)) continue;
        if (core.engine.state.board.isNoBuild(c, core.localBuildRow)) continue;
        if (!core.engine.state.board.hasBuildingAt(c, core.localBuildRow)) valid.push(c);
      }
      core.boardView.showBuildingHighlights(valid, core.localBuildRow);
      break;
    }
    case CardType.Spell: {
      if (spellType === SpellType.Meteor && !core.layout.isOutsideBoard(x, y)) {
        core.boardView.showMeteorTargetHighlight(col, row);
        spellTargets = meteorTargetUnits(core, col, row);
      } else if (
        (spellType === SpellType.Rockslide || spellType === SpellType.BridgeCollapse)
        && !core.layout.isOutsideBoard(x, y)
      ) {
        core.boardView.showColumnTargetHighlight(col);
        // Rockslide (unlike Meteor) hits every unit in the column regardless of side
        // (SpellSystem.castRockslide has no side filter); BridgeCollapse only blocks
        // movement, it deals no damage, so there's no "units hit" set to preview.
        if (spellType === SpellType.Rockslide) spellTargets = columnTargetUnits(core, col);
      }
      break;
    }
  }

  // Outline the units actually inside the hovered AoE footprint — the target-rect
  // fill alone doesn't show which units' centers fall inside it (2026-08-08 fix:
  // the frequently-used 2×2 Meteor kept missing its intended target because of this).
  core.unitView.setSpellTargetPreview(spellTargets ?? EMPTY_UNIT_IDS);
}

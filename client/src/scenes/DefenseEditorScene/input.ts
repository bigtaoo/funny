// Pointer input for the defense editor: grid-tap cell placement, tap-vs-drag/scroll routing for the
// attack-mode card roster, and the drag-ghost that follows the pointer while dragging a card onto the grid.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, sketchPanel, seedFor } from '../../render/sketchUi';
import { unitPortraitUrl, equippedSkinIdFor, getArtTexture } from '../../render/cardArt';
import { ATTACK_LANES, UNIT_BLUEPRINTS } from '@nw/engine/config';
import { CARD_TEAM_MAX_SIZE } from '@nw/shared';
import { MAX_GARRISON } from './core';
import type { DefenseEditorSceneCore } from './core';

export interface InputHandlers {
  onGridTap(sx: number, sy: number): void;
  handleDown(x: number, y: number): void;
  handleMove(x: number, y: number): void;
  handleUp(x: number, y: number): void;
  startDragGhost(x: number, y: number): void;
  moveDragGhost(x: number, y: number): void;
  clearDragGhost(): void;
  clearDrag(): void;
}

/** Pointer-input domain (see ../DefenseEditorScene.ts assembly + ./core.ts for the shared state). */
export class InputPanel implements InputHandlers {
  constructor(private readonly core: DefenseEditorSceneCore) {}

  // ── Cell placement ───────────────────────────────────────────────────────────

  onGridTap(sx: number, sy: number): void {
    const core = this.core;
    if (core.cellW <= 0) return;
    const col = Math.floor((sx - core.gridX) / core.cellW);
    const dr = Math.floor((sy - core.gridY) / core.cellH);
    const buildRows = core.hasBuildingRow ? 1 : 0;
    const rows = buildRows + core.gRows.length;
    if (col < 0 || col > 11 || dr < 0 || dr >= rows) return;
    if (!(ATTACK_LANES as readonly number[]).includes(col)) {
      core.showToast(t('world.defense.baseColBlocked'), C.red);
      return;
    }

    if (core.hasBuildingRow && dr === 0) {
      // Building row (defense only)
      if (core.tool.kind === 'erase') {
        core.buildings.delete(col);
      } else if (core.tool.kind === 'building') {
        core.buildings.set(col, core.tool.type);
      } else {
        core.showToast(t('world.defense.unitsNotHere'), C.red);
        return;
      }
    } else {
      // Garrison / army row
      const row = core.gRows[dr - buildRows]!;
      const key = `${col}:${row}`;
      if (core.tool.kind === 'leader') {
        const entry = core.garrison.get(key);
        if (!entry?.cardInstanceId) {
          core.showToast(t('world.team.leaderNeedsCard'), C.red);
          return;
        }
        core.leaderCardId = entry.cardInstanceId;
      } else if (core.tool.kind === 'erase') {
        core.garrison.delete(key);
      } else if (core.mode === 'attack' && core.tool.kind === 'card') {
        const { cardInstanceId, unitType } = core.tool;
        // A card can only occupy one cell — placing it elsewhere moves it; dropping onto a cell held by
        // another card overwrites that card (removes it from the team). Net size only grows when the card
        // is brand-new to this team AND the target cell was empty.
        const prevCell = core.cellForCard(cardInstanceId);
        const willGrow = !prevCell && !core.garrison.has(key);
        if (willGrow && core.garrison.size >= CARD_TEAM_MAX_SIZE) {
          core.showToast(t('world.team.full'), C.red);
          return;
        }
        if (prevCell && prevCell !== key) core.garrison.delete(prevCell);
        const troops = core.cardState[cardInstanceId]?.currentTroops ?? 0;
        core.garrison.set(key, { unitType, hp: troops, cardInstanceId });
      } else if (core.tool.kind === 'unit') {
        if (!core.garrison.has(key) && core.garrison.size >= MAX_GARRISON) {
          core.showToast(t('world.defense.full'), C.red);
          return;
        }
        const maxHp = UNIT_BLUEPRINTS[core.tool.type].hp;
        core.garrison.set(key, { unitType: core.tool.type, hp: maxHp });
      } else {
        core.showToast(t('world.defense.buildingsNotHere'), C.red);
        return;
      }
    }
    core.render();
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    const core = this.core;
    let hit: (() => void) | null = null;
    for (const { rect, action } of core.hits) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        hit = action;
        break;
      }
    }
    // The card roster (attack mode, right half) scrolls — defer its hit to pointer-up so a drag that
    // starts on a card scrolls instead of selecting it (see scroll-drag-throttle-pattern memory).
    const inRoster =
      core.mode === 'attack' &&
      x >= core.rosterX &&
      x <= core.rosterX + core.rosterW &&
      y >= core.rosterY &&
      y <= core.rosterY + core.rosterH;
    if (inRoster) {
      // Arm a drag candidate if the down landed on a roster card — promotes to a real drag in
      // handleMove once the pointer leaves the roster. Scroll/tap are still handled by the gesture.
      for (const rc of core.rosterCardHits) {
        if (
          x >= rc.rect.x &&
          x <= rc.rect.x + rc.rect.w &&
          y >= rc.rect.y &&
          y <= rc.rect.y + rc.rect.h
        ) {
          core.dragCardId = rc.cardId;
          core.dragUnitType = rc.unitType;
          break;
        }
      }
      core.gesture.down(core.scrollY, y, hit);
      return;
    }
    if (hit) {
      hit();
      return;
    }
    this.onGridTap(x, y);
  }

  handleMove(x: number, y: number): void {
    const core = this.core;
    // Promote an armed roster candidate to an active card-drag once the pointer crosses out of the
    // roster into the grid half — cancel the scroll gesture so a horizontal drag-out never scrolls.
    if (core.dragCardId && !core.dragging && x < core.rosterX) {
      core.dragging = true;
      core.gesture.up(); // discard: cancels any pending scroll/tap for this gesture
      this.startDragGhost(x, y);
    }
    if (core.dragging) {
      this.moveDragGhost(x, y);
      return;
    }
    const scroll = core.gesture.move(y);
    if (scroll !== null) {
      core.scrollY = Math.min(core.scrollMax, scroll);
      core.scrollDirty = true;
    }
  }

  handleUp(x: number, y: number): void {
    const core = this.core;
    if (core.dragging) {
      const cardId = core.dragCardId,
        unitType = core.dragUnitType;
      this.clearDrag();
      if (cardId && unitType) {
        // Reuse the tap-placement path: select the dragged card, then drop it at the release point.
        core.tool = { kind: 'card', cardInstanceId: cardId, unitType };
        this.onGridTap(x, y); // places (and renders) if the drop is on a valid cell; no-op otherwise
      }
      core.render(); // reflect selection / guarantee the (already-removed) ghost is gone
      return;
    }
    core.dragCardId = null;
    core.dragUnitType = null;
    core.gesture.up()?.();
  }

  // ── Drag ghost (attack mode drag-to-place) ─────────────────────────────────

  /** Build a translucent unit portrait that follows the pointer while dragging a card onto the grid. */
  startDragGhost(x: number, y: number): void {
    const core = this.core;
    this.clearDragGhost();
    const size = core.cellW > 0 ? core.cellW * 0.72 : 60;
    const ghost = new PIXI.Container();
    const frame = sketchPanel(size, size, {
      fill: 0xf0eee7,
      border: C.gold,
      width: 2.4,
      seed: seedFor(0, 0, size),
    });
    frame.x = -size / 2;
    frame.y = -size / 2;
    ghost.addChild(frame);
    const url = core.dragUnitType
      ? unitPortraitUrl(
          core.dragUnitType,
          equippedSkinIdFor(core.dragUnitType, core.cb.getSave?.()?.equipped)
        ) ?? undefined
      : undefined;
    if (url) {
      const tex = getArtTexture(url);
      if (tex.baseTexture.valid) {
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(Math.min((size - 2) / tex.width, (size - 2) / tex.height));
        ghost.addChild(sp);
      }
    }
    ghost.alpha = 0.75;
    ghost.x = x;
    ghost.y = y;
    core.dragLayer.addChild(ghost);
    core.dragGhost = ghost;
  }

  moveDragGhost(x: number, y: number): void {
    const core = this.core;
    if (core.dragGhost) {
      core.dragGhost.x = x;
      core.dragGhost.y = y;
    }
  }

  clearDragGhost(): void {
    const core = this.core;
    if (core.dragGhost) {
      core.dragGhost.destroy({ children: true });
      core.dragGhost = null;
    }
  }

  /** Reset all drag state (candidate + active flag + ghost). */
  clearDrag(): void {
    const core = this.core;
    core.dragCardId = null;
    core.dragUnitType = null;
    core.dragging = false;
    this.clearDragGhost();
  }
}

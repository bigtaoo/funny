// Pointer input for the defense editor: grid-tap cell placement, tap-vs-drag/scroll routing for the
// attack-mode card roster, and the drag-ghost that follows the pointer while dragging a card onto the grid.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, sketchPanel, seedFor } from '../../render/sketchUi';
import { UNIT_ART_URLS, getArtTexture } from '../../render/cardArt';
import { ATTACK_LANES, UNIT_BLUEPRINTS } from '../../game/config';
import { CARD_TEAM_MAX_SIZE } from '@nw/shared';
import { type Constructor, type DefenseEditorSceneBaseCtor, MAX_GARRISON } from './base';

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

export function InputMixin<TBase extends DefenseEditorSceneBaseCtor>(Base: TBase): TBase & Constructor<InputHandlers> {
  return class extends Base {
    // ── Cell placement ───────────────────────────────────────────────────────────

    onGridTap(sx: number, sy: number): void {
      if (this.cellW <= 0) return;
      const col = Math.floor((sx - this.gridX) / this.cellW);
      const dr = Math.floor((sy - this.gridY) / this.cellH);
      const buildRows = this.hasBuildingRow ? 1 : 0;
      const rows = buildRows + this.gRows.length;
      if (col < 0 || col > 11 || dr < 0 || dr >= rows) return;
      if (!(ATTACK_LANES as readonly number[]).includes(col)) {
        this.showToast(t('world.defense.baseColBlocked'), C.red);
        return;
      }

      if (this.hasBuildingRow && dr === 0) {
        // Building row (defense only)
        if (this.tool.kind === 'erase') {
          this.buildings.delete(col);
        } else if (this.tool.kind === 'building') {
          this.buildings.set(col, this.tool.type);
        } else {
          this.showToast(t('world.defense.unitsNotHere'), C.red);
          return;
        }
      } else {
        // Garrison / army row
        const row = this.gRows[dr - buildRows]!;
        const key = `${col}:${row}`;
        if (this.tool.kind === 'leader') {
          const entry = this.garrison.get(key);
          if (!entry?.cardInstanceId) {
            this.showToast(t('world.team.leaderNeedsCard'), C.red);
            return;
          }
          this.leaderCardId = entry.cardInstanceId;
        } else if (this.tool.kind === 'erase') {
          this.garrison.delete(key);
        } else if (this.mode === 'attack' && this.tool.kind === 'card') {
          const { cardInstanceId, unitType } = this.tool;
          // A card can only occupy one cell — placing it elsewhere moves it; dropping onto a cell held by
          // another card overwrites that card (removes it from the team). Net size only grows when the card
          // is brand-new to this team AND the target cell was empty.
          const prevCell = this.cellForCard(cardInstanceId);
          const willGrow = !prevCell && !this.garrison.has(key);
          if (willGrow && this.garrison.size >= CARD_TEAM_MAX_SIZE) {
            this.showToast(t('world.team.full'), C.red);
            return;
          }
          if (prevCell && prevCell !== key) this.garrison.delete(prevCell);
          const troops = this.cardState[cardInstanceId]?.currentTroops ?? 0;
          this.garrison.set(key, { unitType, hp: troops, cardInstanceId });
        } else if (this.tool.kind === 'unit') {
          if (!this.garrison.has(key) && this.garrison.size >= MAX_GARRISON) {
            this.showToast(t('world.defense.full'), C.red);
            return;
          }
          const maxHp = UNIT_BLUEPRINTS[this.tool.type].hp;
          this.garrison.set(key, { unitType: this.tool.type, hp: maxHp });
        } else {
          this.showToast(t('world.defense.buildingsNotHere'), C.red);
          return;
        }
      }
      this.render();
    }

    // ── Scene interface ───────────────────────────────────────────────────────

    handleDown(x: number, y: number): void {
      let hit: (() => void) | null = null;
      for (const { rect, action } of this.hits) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) { hit = action; break; }
      }
      // The card roster (attack mode, right half) scrolls — defer its hit to pointer-up so a drag that
      // starts on a card scrolls instead of selecting it (see scroll-drag-throttle-pattern memory).
      const inRoster = this.mode === 'attack' && x >= this.rosterX && x <= this.rosterX + this.rosterW
        && y >= this.rosterY && y <= this.rosterY + this.rosterH;
      if (inRoster) {
        // Arm a drag candidate if the down landed on a roster card — promotes to a real drag in
        // handleMove once the pointer leaves the roster. Scroll/tap are still handled by the gesture.
        for (const rc of this.rosterCardHits) {
          if (x >= rc.rect.x && x <= rc.rect.x + rc.rect.w && y >= rc.rect.y && y <= rc.rect.y + rc.rect.h) {
            this.dragCardId = rc.cardId; this.dragUnitType = rc.unitType; break;
          }
        }
        this.gesture.down(this.scrollY, y, hit);
        return;
      }
      if (hit) { hit(); return; }
      this.onGridTap(x, y);
    }

    handleMove(x: number, y: number): void {
      // Promote an armed roster candidate to an active card-drag once the pointer crosses out of the
      // roster into the grid half — cancel the scroll gesture so a horizontal drag-out never scrolls.
      if (this.dragCardId && !this.dragging && x < this.rosterX) {
        this.dragging = true;
        this.gesture.up(); // discard: cancels any pending scroll/tap for this gesture
        this.startDragGhost(x, y);
      }
      if (this.dragging) { this.moveDragGhost(x, y); return; }
      const scroll = this.gesture.move(y);
      if (scroll !== null) { this.scrollY = Math.min(this.scrollMax, scroll); this.scrollDirty = true; }
    }

    handleUp(x: number, y: number): void {
      if (this.dragging) {
        const cardId = this.dragCardId, unitType = this.dragUnitType;
        this.clearDrag();
        if (cardId && unitType) {
          // Reuse the tap-placement path: select the dragged card, then drop it at the release point.
          this.tool = { kind: 'card', cardInstanceId: cardId, unitType };
          this.onGridTap(x, y); // places (and renders) if the drop is on a valid cell; no-op otherwise
        }
        this.render(); // reflect selection / guarantee the (already-removed) ghost is gone
        return;
      }
      this.dragCardId = null; this.dragUnitType = null;
      this.gesture.up()?.();
    }

    // ── Drag ghost (attack mode drag-to-place) ─────────────────────────────────

    /** Build a translucent unit portrait that follows the pointer while dragging a card onto the grid. */
    startDragGhost(x: number, y: number): void {
      this.clearDragGhost();
      const size = this.cellW > 0 ? this.cellW * 0.72 : 60;
      const ghost = new PIXI.Container();
      const frame = sketchPanel(size, size, { fill: 0xf0eee7, border: C.gold, width: 2.4, seed: seedFor(0, 0, size) });
      frame.x = -size / 2; frame.y = -size / 2;
      ghost.addChild(frame);
      const url = this.dragUnitType ? UNIT_ART_URLS[this.dragUnitType] : undefined;
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
      ghost.x = x; ghost.y = y;
      this.dragLayer.addChild(ghost);
      this.dragGhost = ghost;
    }

    moveDragGhost(x: number, y: number): void {
      if (this.dragGhost) { this.dragGhost.x = x; this.dragGhost.y = y; }
    }

    clearDragGhost(): void {
      if (this.dragGhost) { this.dragGhost.destroy({ children: true }); this.dragGhost = null; }
    }

    /** Reset all drag state (candidate + active flag + ghost). */
    clearDrag(): void {
      this.dragCardId = null; this.dragUnitType = null; this.dragging = false;
      this.clearDragGhost();
    }
  };
}

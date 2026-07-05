// Input domain: drag-to-place, tap-select-then-tap-to-place, and the upgrade-button drag, plus the
// shared placement-highlight / card-commit logic they both drive. All hit-testing is manual in design
// space (no PIXI interactive/hitArea). Chained onto GameRendererBase (./base.ts) — see ../GameRenderer.ts.
import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BOARD_COLS } from '../../game/config';
import { CardType, SpellType } from '../../game';
import { Rect } from '../../layout/ILayout';
import { t, type TranslationKey } from '../../i18n';
import type { Constructor, GameRendererBaseCtor } from './base';

// ── Drag state ─────────────────────────────────────────────────────────────────

interface CardDragState {
  kind: 'card';
  handIndex: number;
  cardType: CardType;
  spellType?: SpellType;
  ghost: PIXI.Container;
}

interface UpgradeDragState {
  kind: 'upgrade';
  ghost: PIXI.Container;
}

export type DragState = CardDragState | UpgradeDragState;

// ── Tap-select state ───────────────────────────────────────────────────────────

export interface TapSelectState {
  handIndex: number;
  cardType: CardType;
  spellType?: SpellType;
}

const DRAG_THRESHOLD = 8; // px in design space before a press becomes a drag

export interface InputHandlers {
  handleDown(x: number, y: number): void;
  handleMove(x: number, y: number): void;
  handleUp(x: number, y: number): void;
  cancelDrag(): void;
  cancelTapSelect(): void;
}

export function InputMixin<TBase extends GameRendererBaseCtor>(Base: TBase): TBase & Constructor<InputHandlers> {
  return class extends Base {
    drag:      DragState | null = null;
    dragCol    = -1;
    dragRow    = -1;
    dragOnBoard = false;

    // Tap-select: card selected by tap, placement confirmed by tapping a column
    tapSelect: TapSelectState | null = null;

    // Pending card press — deferred until we know if it's a tap or drag
    pendingCardDown: { x: number; y: number; handIndex: number } | null = null;
    private downX = 0;
    private downY = 0;

    // ── Input handling (design-space coords) ─────────────────────────────────

    handleDown(x: number, y: number): void {
      this.downX = x;
      this.downY = y;

      // Tutorial director intercepts taps first: if it hits its own buttons (next/finish/skip)
      // or is in tour/graduation phase → swallow the tap, don't pass to board/hand (§3.4).
      // During phase B checkpoint it passes non-button taps through so the player can drag cards normally.
      if (this.tutorial?.handleDown(x, y)) return;

      // Profile popup open → its own dim backdrop (PIXI interactive) handles the
      // close tap; swallow the manual hit-test so nothing behind it fires.
      if (this.profilePopup?.isOpen) return;

      // Pause overlay intercepts all input
      if (this.hudView.isPaused) {
        const resume = this.hudView.getPauseResumeRect();
        const exit   = this.hudView.getPauseExitRect();
        if (resume && this.overRect(x, y, resume)) {
          this.hudView.hidePause();
        } else if (exit && this.overRect(x, y, exit)) {
          this.hudView.hidePause();
          this.onExitToLobby?.();
        }
        return;
      }

      // Settings button
      if (this.overRect(x, y, this.hudView.getSettingsRect())) {
        this.cancelTapSelect();
        this.hudView.onExitToLobby = () => this.onExitToLobby?.();
        this.hudView.showPause();
        return;
      }

      // Upgrade button
      if (this.hudView.upgradeEnabled && this.overRect(x, y, this.hudView.getUpgradeRect())) {
        this.cancelTapSelect();
        this.startUpgradeDrag(x, y);
        return;
      }

      // Refresh-hand button — simple tap (no drag): spend ink, redraw all cards.
      if (this.hudView.refreshEnabled && this.overRect(x, y, this.hudView.getRefreshRect())) {
        this.cancelTapSelect();
        this.cancelDrag();
        this.engine.refreshHand();
        return;
      }

      // Opponent profile (top strip, netplay only — no cards live up there).
      if (this.profilePopup && this.oppProfile && this.overRect(x, y, this.hudView.getEnemyInfoRect())) {
        this.profilePopup.show(this.oppProfile);
        return;
      }

      // Hand cards — defer drag start until we see movement (tap vs drag)
      const cardIdx = this.handView.hitTestCardIndex(x, y);
      if (cardIdx >= 0) {
        this.pendingCardDown = { x, y, handIndex: cardIdx };
        return;
      }

      // Local profile (bottom-strip info column) — checked AFTER cards so a card
      // in the same area always wins; only empty HUD space opens the popup.
      if (this.profilePopup && this.selfProfile && this.overRect(x, y, this.hudView.getPlayerInfoRect())) {
        this.profilePopup.show(this.selfProfile);
        return;
      }

      // Board area while in tap-select: placement handled on handleUp
    }

    handleMove(x: number, y: number): void {
      // Pending card down: check if moved far enough to become a drag
      if (this.pendingCardDown && !this.drag) {
        const dx = x - this.pendingCardDown.x;
        const dy = y - this.pendingCardDown.y;
        if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
          const handIndex = this.pendingCardDown.handIndex;
          this.pendingCardDown = null;
          this.cancelTapSelect();
          this.startCardDrag(handIndex);
        }
      }

      if (this.drag) {
        this.drag.ghost.x = x;
        this.drag.ghost.y = y;

        if (this.drag.kind === 'card') {
          const onBoard = !this.layout.isOutsideBoard(x, y);
          const col = this.layout.screenToCol(x, y);
          const row = this.layout.screenToRow(x, y);
          if (col !== this.dragCol || row !== this.dragRow || onBoard !== this.dragOnBoard) {
            this.dragCol     = col;
            this.dragRow     = row;
            this.dragOnBoard = onBoard;
            this.updatePlacementHighlights(this.drag.cardType, this.drag.spellType, col, row, x, y);
          }
        } else {
          const baseRect = this.boardView.getPlayerBaseRect();
          this.boardView.showBaseUpgradeHighlight(this.overRect(x, y, baseRect));
        }
        return;
      }

      // Tap-select hover: update Meteor target preview as pointer moves over board
      if (this.tapSelect?.cardType === CardType.Spell && this.tapSelect?.spellType === SpellType.Meteor) {
        if (!this.layout.isOutsideBoard(x, y)) {
          const col = this.layout.screenToCol(x, y);
          const row = this.layout.screenToRow(x, y);
          this.updatePlacementHighlights(CardType.Spell, SpellType.Meteor, col, row, x, y);
        }
      }
    }

    handleUp(x: number, y: number): void {
      // Resolve pending card press
      if (this.pendingCardDown) {
        const pd = this.pendingCardDown;
        this.pendingCardDown = null;

        if (this.tapSelect && this.tapSelect.handIndex === pd.handIndex) {
          // Tapped the already-selected card → deselect
          this.cancelTapSelect();
          return;
        }
        // Activate tap-select for this card (cancels any previous selection first)
        this.cancelTapSelect();
        this.startTapSelect(pd.handIndex);
        return;
      }

      if (this.drag) {
        if (this.drag.kind === 'upgrade') {
          const baseRect = this.boardView.getPlayerBaseRect();
          if (this.overRect(x, y, baseRect)) this.engine.upgradeBase();
          this.cancelDrag();
          return;
        }
        // card drag
        if (this.layout.isOutsideBoard(x, y)) { this.cancelDrag(); return; }
        const col = this.layout.screenToCol(x, y);
        const row = this.layout.screenToRow(x, y);
        this.commitCardPlay(
          this.drag.handIndex, this.drag.cardType, this.drag.spellType, col, row,
        );
        this.cancelDrag();
        return;
      }

      // Tap-select mode: tap the board to place
      if (this.tapSelect) {
        // Tapping the selected card itself cancels
        const cardIdx = this.handView.hitTestCardIndex(x, y);
        if (cardIdx === this.tapSelect.handIndex) {
          this.cancelTapSelect();
          return;
        }
        if (!this.layout.isOutsideBoard(x, y)) {
          const col = this.layout.screenToCol(x, y);
          const row = this.layout.screenToRow(x, y);
          const { handIndex, cardType, spellType } = this.tapSelect;
          this.cancelTapSelect();
          this.commitCardPlay(handIndex, cardType, spellType, col, row);
        }
      }
    }

    // ── Card drag ──────────────────────────────────────────────────────────────

    private startCardDrag(handIndex: number): void {
      const player = this.localPlayer(this.engine.state);
      const slot   = player.hand.slots[handIndex];
      if (!slot || player.ink < slot.card.cost) return;

      const card   = slot.card;
      const ghost  = this.buildDragGhost(t(card.nameKey as TranslationKey), card.cost);
      const center = this.handView.slotCenter(handIndex);
      ghost.x = center.x;
      ghost.y = center.y;
      this.container.addChild(ghost);

      this.drag        = { kind: 'card', handIndex, cardType: card.cardType, spellType: card.spellType, ghost };
      this.dragCol     = -1;
      this.dragRow     = -1;
      this.dragOnBoard = false;
      this.handView.setSelectedCard(handIndex);
      this.updatePlacementHighlights(card.cardType, card.spellType, -1, -1, center.x, center.y);
    }

    // ── Tap-select ─────────────────────────────────────────────────────────────

    private startTapSelect(handIndex: number): void {
      const player = this.localPlayer(this.engine.state);
      const slot   = player.hand.slots[handIndex];
      if (!slot || player.ink < slot.card.cost) return;

      const card = slot.card;
      this.tapSelect = { handIndex, cardType: card.cardType, spellType: card.spellType };
      this.handView.setSelectedCard(handIndex);
      // Show placement highlights immediately (static for unit/building, empty for meteor until hover)
      this.updatePlacementHighlights(card.cardType, card.spellType, -1, -1, 0, 0);
    }

    cancelTapSelect(): void {
      if (!this.tapSelect) return;
      this.tapSelect = null;
      this.handView.clearSelection();
      this.boardView.clearHighlights();
    }

    // ── Shared placement logic ─────────────────────────────────────────────────

    private commitCardPlay(
      handIndex: number, cardType: CardType, spellType: SpellType | undefined,
      col: number, row: number,
    ): void {
      // Tutorial checkpoint: only the target card type is allowed this beat; wrong plays are rejected (avoids waste / going off-script, §3.4).
      if (this.tutorial && !this.tutorial.allowCardPlay(cardType, spellType)) return;
      switch (cardType) {
        case CardType.Unit: {
          if (!(ATTACK_LANES as readonly number[]).includes(col)) return;
          if (this.engine.state.board.isCellOccupiedByUnit(col, this.localSpawnRow)) return;
          this.engine.playCard(handIndex, col);
          break;
        }
        case CardType.Building: {
          if (this.engine.state.board.hasBuildingAt(col, this.localBuildRow)) return;
          if (this.engine.state.board.isNoBuild(col, this.localBuildRow)) return;
          this.engine.playCard(handIndex, col);
          break;
        }
        case CardType.Spell: {
          if (spellType === SpellType.Haste)       this.engine.playCard(handIndex, 0);
          else if (spellType === SpellType.Meteor)  this.engine.playCard(handIndex, col, row);
          else if (spellType === SpellType.Rockslide || spellType === SpellType.BridgeCollapse) {
            this.engine.playCard(handIndex, col);
          }
          break;
        }
      }
    }

    private updatePlacementHighlights(
      cardType: CardType, spellType: SpellType | undefined,
      col: number, row: number, x: number, y: number,
    ): void {
      this.boardView.clearHighlights();

      switch (cardType) {
        case CardType.Unit: {
          const blocked = new Set<number>();
          for (const lane of ATTACK_LANES) {
            if (this.engine.state.board.isCellOccupiedByUnit(lane, this.localSpawnRow)) blocked.add(lane);
          }
          this.boardView.showUnitLaneHighlights(Array.from(ATTACK_LANES), blocked, col);
          break;
        }
        case CardType.Building: {
          const valid: number[] = [];
          for (let c = 0; c < BOARD_COLS; c++) {
            if (!(ATTACK_LANES as readonly number[]).includes(c)) continue;
            if (this.engine.state.board.isNoBuild(c, this.localBuildRow)) continue;
            if (!this.engine.state.board.hasBuildingAt(c, this.localBuildRow)) valid.push(c);
          }
          this.boardView.showBuildingHighlights(valid, this.localBuildRow);
          break;
        }
        case CardType.Spell: {
          if (spellType === SpellType.Meteor && !this.layout.isOutsideBoard(x, y)) {
            this.boardView.showMeteorTargetHighlight(col, row);
          } else if (
            (spellType === SpellType.Rockslide || spellType === SpellType.BridgeCollapse)
            && !this.layout.isOutsideBoard(x, y)
          ) {
            this.boardView.showColumnTargetHighlight(col);
          }
          break;
        }
      }
    }

    // ── Upgrade drag ───────────────────────────────────────────────────────────

    private startUpgradeDrag(x: number, y: number): void {
      const player = this.localPlayer(this.engine.state);
      if (!player.canUpgradeBase()) return;
      const ghost = this.buildDragGhost(t('hud.upgrade'), player.nextUpgradeCost!, 0xffcc00);
      ghost.x = x;
      ghost.y = y;
      this.container.addChild(ghost);
      this.drag = { kind: 'upgrade', ghost };
      this.boardView.showBaseUpgradeHighlight(false);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    cancelDrag(): void {
      this.pendingCardDown = null;
      if (!this.drag) return;
      this.drag.ghost.parent?.removeChild(this.drag.ghost);
      this.drag.ghost.destroy();
      this.drag        = null;
      this.dragCol     = -1;
      this.dragRow     = -1;
      this.dragOnBoard = false;
      this.handView.clearSelection();
      this.boardView.clearHighlights();
    }

    private overRect(x: number, y: number, r: Rect): boolean {
      return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    private buildDragGhost(label: string, cost: number, accentColor = 0x2244aa): PIXI.Container {
      const c   = new PIXI.Container();
      const gfx = new PIXI.Graphics();
      gfx.beginFill(0xfaf6ee, 0.9);
      gfx.lineStyle(2, accentColor);
      gfx.drawRoundedRect(-32, -42, 64, 84, 6);
      gfx.endFill();

      const nameText = new PIXI.Text(label, { fontSize: 11, fill: 0x222222, align: 'center' });
      nameText.anchor.set(0.5, 0.5);
      nameText.y = -10;

      const costText = new PIXI.Text(String(cost), { fontSize: 14, fill: accentColor, fontWeight: 'bold' });
      costText.anchor.set(0.5, 0.5);
      costText.y = 18;

      c.addChild(gfx, nameText, costText);
      c.alpha = 0.9;
      return c;
    }
  };
}

// Input domain: drag-to-place, tap-select-then-tap-to-place, and the upgrade-button drag, plus the
// shared placement-highlight / card-commit logic they both drive. All hit-testing is manual in design
// space (no PIXI interactive/hitArea). Independent class constructed with `core` (see
// ../GameRenderer.ts's assembly) — never reaches into EventsPanel (one-directional: events.ts reaches
// this file's cancelDrag/cancelTapSelect/drag/tapSelect through `core.input`, not the other way).
//
// 2026-08-11: converted from the former `InputMixin(Base)` mixin chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The `update(dt)` override that used to
// call `super.update(dt)` then run the highlight-refresh accumulator is now a plain `update(dt)`
// method the outer assembly calls AFTER `core.update(dt)` — same order, no `super` needed.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { ATTACK_LANES } from '@nw/engine/config';
import { CardType, SpellType } from '../../game';
import { t, type TranslationKey } from '../../i18n';
import type { GameRendererCore } from './core';
import { FS } from '../fontScale';
import { EMPTY_UNIT_IDS, updatePlacementHighlights as updatePlacementHighlightsImpl } from './placementHighlights';
import { playSfx } from '../../audio/audioBus';
import { dispatchHit, type Hit } from '../../ui/hits';

// ── Drag state ─────────────────────────────────────────────────────────────────

interface CardDragState {
  kind: 'card';
  handIndex: number;
  cardType: CardType;
  spellType?: SpellType;
  ghost: PIXI.Container;
}

export type DragState = CardDragState;

// ── Tap-select state ───────────────────────────────────────────────────────────

export interface TapSelectState {
  handIndex: number;
  cardType: CardType;
  spellType?: SpellType;
}

const DRAG_THRESHOLD = 8; // px in design space before a press becomes a drag

// Throttle for the board-state-driven highlight refresh (see update() below) — this is a
// display-only staleness fix (occupancy can change while the pointer holds still), not
// something that needs per-frame precision, so recompute at ~10Hz instead of every tick.
const HIGHLIGHT_REFRESH_INTERVAL = 0.1;

export class InputPanel {
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

  // Last pointer position while a drag/tap-select is active, so per-tick highlight
  // refreshes (see update()) can recompute without a fresh pointer-move event.
  private lastPointerX = 0;
  private lastPointerY = 0;

  private highlightRefreshAccum = 0;

  constructor(private readonly core: GameRendererCore) {}

  // Board state (unit occupancy) changes every tick independent of pointer input,
  // so the active placement highlight must be re-evaluated periodically too — see
  // refreshPlacementHighlights() below for why. Called by the outer assembly right
  // after core.update(dt) — same order the old InputMixin's `super.update(dt)` then
  // own-body sequence ran in.
  update(dt: number): void {
    this.highlightRefreshAccum += dt;
    if (this.highlightRefreshAccum >= HIGHLIGHT_REFRESH_INTERVAL) {
      this.highlightRefreshAccum = 0;
      this.refreshPlacementHighlights();
    }
  }

  // ── Input handling (design-space coords) ─────────────────────────────────

  handleDown(x: number, y: number): void {
    this.downX = x;
    this.downY = y;

    // Tutorial director intercepts taps first: if it hits its own buttons (next/finish/skip)
    // or is in tour/graduation phase → swallow the tap, don't pass to board/hand (§3.4).
    // During phase B checkpoint it passes non-button taps through so the player can drag cards normally.
    if (this.core.tutorial?.handleDown(x, y)) return;

    // Profile popup open → its own dim backdrop (PIXI interactive) handles the
    // close tap; swallow the manual hit-test so nothing behind it fires.
    if (this.core.profilePopup?.isOpen) return;

    // Match already decided (game_over/game_draw/tutorial graduation): settlement
    // (onGameEnd) is scheduled but deferred a couple seconds (see events.ts/core.ts).
    // Nothing — surrender included — should still be actionable in that window; the
    // player must not be able to fire onExitToLobby while a deferred onGameEnd is
    // still pending (double-settlement / stray navigation after the match ended).
    if (this.core.gameEnded) return;

    // Surrender confirmation overlay intercepts all input
    if (this.core.hudView.isPaused) {
      const cancel  = this.core.hudView.getSurrenderCancelRect();
      const confirm = this.core.hudView.getSurrenderConfirmRect();
      const overlay: Hit[] = [];
      if (cancel)  overlay.push({ rect: cancel, sound: 'sfx.ui.back', fn: () => this.core.hudView.hideSurrenderConfirm() });
      if (confirm) overlay.push({ rect: confirm, fn: () => {
        this.core.hudView.hideSurrenderConfirm();
        this.core.onExitToLobby?.();
      } });
      dispatchHit(overlay, x, y);
      return;
    }

    // HUD buttons. Collected into one table (ui/hits.ts) rather than a chain of overRect ifs, for
    // the same reason the menu scenes were: this is where their tap cue comes from. Order below is
    // the old if-chain's order, and hitTest keeps first-pushed-wins, so precedence is unchanged.
    const hud: Hit[] = [
      // Surrender button — opens the confirmation overlay above.
      { rect: this.core.hudView.getSurrenderRect(), fn: () => {
        this.cancelTapSelect();
        this.core.hudView.showSurrenderConfirm();
      } },
    ];
    // Upgrade button — tap to upgrade immediately, no drag-onto-base needed.
    if (this.core.hudView.upgradeEnabled) {
      hud.push({ rect: this.core.hudView.getUpgradeRect(), fn: () => {
        this.cancelTapSelect();
        // Drawn enabled but not currently affordable: the tap is a real rejection, so it squeaks
        // rather than tapping (same cue an unaffordable card gets — see rejectPlay).
        if (this.core.localPlayer(this.core.engine.state).canUpgradeBase()) this.core.engine.upgradeBase();
        else this.rejectPlay(true);
      } });
    }
    // Refresh-hand button — simple tap (no drag): spend ink, redraw all cards.
    if (this.core.hudView.refreshEnabled) {
      hud.push({ rect: this.core.hudView.getRefreshRect(), fn: () => {
        this.cancelTapSelect();
        this.cancelDrag();
        this.core.engine.refreshHand();
      } });
    }
    // Opponent profile (top strip, netplay only — no cards live up there).
    if (this.core.profilePopup && this.core.oppProfile) {
      const opp = this.core.oppProfile;
      hud.push({ rect: this.core.hudView.getEnemyInfoRect(), fn: () => this.core.profilePopup!.show(opp) });
    }
    if (dispatchHit(hud, x, y)) return;

    // Hand cards — defer drag start until we see movement (tap vs drag)
    const cardIdx = this.core.handView.hitTestCardIndex(x, y);
    if (cardIdx >= 0) {
      this.pendingCardDown = { x, y, handIndex: cardIdx };
      return;
    }

    // Local profile (bottom-strip info column) — checked AFTER cards so a card
    // in the same area always wins; only empty HUD space opens the popup.
    if (this.core.profilePopup && this.core.selfProfile) {
      const self = this.core.selfProfile;
      if (dispatchHit([{ rect: this.core.hudView.getPlayerInfoRect(), fn: () => this.core.profilePopup!.show(self) }], x, y)) return;
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

    this.lastPointerX = x;
    this.lastPointerY = y;

    if (this.drag) {
      this.drag.ghost.x = x;
      this.drag.ghost.y = y;

      const onBoard = !this.core.layout.isOutsideBoard(x, y);
      const col = this.core.layout.screenToCol(x, y);
      const row = this.core.layout.screenToRow(x, y);
      if (col !== this.dragCol || row !== this.dragRow || onBoard !== this.dragOnBoard) {
        this.dragCol     = col;
        this.dragRow     = row;
        this.dragOnBoard = onBoard;
        this.updatePlacementHighlights(this.drag.cardType, this.drag.spellType, col, row, x, y);
      }
      return;
    }

    // Tap-select hover: update Meteor target preview as pointer moves over board
    if (this.tapSelect?.cardType === CardType.Spell && this.tapSelect?.spellType === SpellType.Meteor) {
      if (!this.core.layout.isOutsideBoard(x, y)) {
        const col = this.core.layout.screenToCol(x, y);
        const row = this.core.layout.screenToRow(x, y);
        this.updatePlacementHighlights(CardType.Spell, SpellType.Meteor, col, row, x, y);
      }
    }
  }

  /**
   * Re-evaluate the active drag/tap-select highlight against current board state.
   * Occupancy (e.g. the spawn-row slot a lane is blocked on) can change every tick
   * as units move/die, independent of pointer movement, so a highlight painted once
   * at drag/select-start would otherwise go stale (still red after the slot frees up).
   */
  refreshPlacementHighlights(): void {
    if (this.drag) {
      this.updatePlacementHighlights(
        this.drag.cardType, this.drag.spellType, this.dragCol, this.dragRow,
        this.lastPointerX, this.lastPointerY,
      );
      return;
    }
    if (this.tapSelect) {
      // Meteor's targeting reticle tracks the pointer even in tap-select mode;
      // other card types don't use col/row here (see updatePlacementHighlights).
      if (this.tapSelect.cardType === CardType.Spell && this.tapSelect.spellType === SpellType.Meteor) {
        const col = this.core.layout.screenToCol(this.lastPointerX, this.lastPointerY);
        const row = this.core.layout.screenToRow(this.lastPointerX, this.lastPointerY);
        this.updatePlacementHighlights(
          this.tapSelect.cardType, this.tapSelect.spellType, col, row,
          this.lastPointerX, this.lastPointerY,
        );
      } else {
        this.updatePlacementHighlights(this.tapSelect.cardType, this.tapSelect.spellType, -1, -1, 0, 0);
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
      // card drag
      if (this.core.layout.isOutsideBoard(x, y)) { this.cancelDrag(); return; }
      const col = this.core.layout.screenToCol(x, y);
      const row = this.core.layout.screenToRow(x, y);
      this.commitCardPlay(
        this.drag.handIndex, this.drag.cardType, this.drag.spellType, col, row,
      );
      this.cancelDrag();
      return;
    }

    // Tap-select mode: tap the board to place
    if (this.tapSelect) {
      // Tapping the selected card itself cancels
      const cardIdx = this.core.handView.hitTestCardIndex(x, y);
      if (cardIdx === this.tapSelect.handIndex) {
        this.cancelTapSelect();
        return;
      }
      if (!this.core.layout.isOutsideBoard(x, y)) {
        const col = this.core.layout.screenToCol(x, y);
        const row = this.core.layout.screenToRow(x, y);
        const { handIndex, cardType, spellType } = this.tapSelect;
        this.cancelTapSelect();
        this.commitCardPlay(handIndex, cardType, spellType, col, row);
      }
    }
  }

  // ── Card drag ──────────────────────────────────────────────────────────────

  private startCardDrag(handIndex: number): void {
    const player = this.core.localPlayer(this.core.engine.state);
    const slot   = player.hand.slots[handIndex];
    if (!slot || player.ink < slot.card.cost) { this.rejectPlay(!!slot); return; }

    const card   = slot.card;
    const ghost  = this.buildDragGhost(t(card.nameKey as TranslationKey), card.cost);
    const center = this.core.handView.slotCenter(handIndex);
    ghost.x = center.x;
    ghost.y = center.y;
    this.core.container.addChild(ghost);

    this.drag        = { kind: 'card', handIndex, cardType: card.cardType, spellType: card.spellType, ghost };
    this.dragCol     = -1;
    this.dragRow     = -1;
    this.dragOnBoard = false;
    this.core.handView.setSelectedCard(handIndex);
    this.updatePlacementHighlights(card.cardType, card.spellType, -1, -1, center.x, center.y);
  }

  // ── Tap-select ─────────────────────────────────────────────────────────────

  private startTapSelect(handIndex: number): void {
    const player = this.core.localPlayer(this.core.engine.state);
    const slot   = player.hand.slots[handIndex];
    if (!slot || player.ink < slot.card.cost) { this.rejectPlay(!!slot); return; }

    const card = slot.card;
    this.tapSelect = { handIndex, cardType: card.cardType, spellType: card.spellType };
    this.core.handView.setSelectedCard(handIndex);
    // Show placement highlights immediately (static for unit/building, empty for meteor until hover)
    this.updatePlacementHighlights(card.cardType, card.spellType, -1, -1, 0, 0);
  }

  cancelTapSelect(): void {
    if (!this.tapSelect) return;
    this.tapSelect = null;
    this.core.handView.clearSelection();
    this.core.boardView.clearHighlights();
    this.core.unitView.setSpellTargetPreview(EMPTY_UNIT_IDS);
  }

  // ── Shared placement logic ─────────────────────────────────────────────────

  /**
   * `sfx.card.invalid` — "费不够/非法出牌" (AUDIO_DESIGN.md §2.1). The one battle cue with no
   * engine event behind it, which is why it was left out of the events.ts trigger table: an
   * illegal play is rejected HERE, client-side, and `@nw/engine` is never told it happened
   * (deliberately — see AUDIO_DESIGN.md §6's architecture line; a "you tried something illegal"
   * event would be a display concern living in the deterministic sim).
   *
   * Fires at most once per press. Every caller is on a path that has already consumed the
   * gesture — the drag never starts, the tap-select never latches, the commit returns — so a
   * player mashing an unaffordable card gets one squeak per press, not a per-frame stream.
   *
   * `real` distinguishes "you pressed a card you cannot afford / cannot place there" from
   * "you pressed an empty hand slot". The latter is not a rejection, it is nothing at all, and
   * making blank space squeak would teach the player the sound means less than it does.
   */
  private rejectPlay(real: boolean): void {
    if (real) playSfx('sfx.card.invalid');
  }


  private commitCardPlay(
    handIndex: number, cardType: CardType, spellType: SpellType | undefined,
    col: number, row: number,
  ): void {
    // Tutorial checkpoint: only the target card type is allowed this beat; wrong plays are rejected (avoids waste / going off-script, §3.4).
    if (this.core.tutorial && !this.core.tutorial.allowCardPlay(cardType, spellType)) { this.rejectPlay(true); return; }
    switch (cardType) {
      case CardType.Unit: {
        if (!(ATTACK_LANES as readonly number[]).includes(col)) { this.rejectPlay(true); return; }
        if (this.core.engine.state.board.isCellOccupiedByUnit(col, this.core.localSpawnRow)) { this.rejectPlay(true); return; }
        this.core.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Building: {
        if (!(ATTACK_LANES as readonly number[]).includes(col)) { this.rejectPlay(true); return; }
        if (this.core.engine.state.board.hasBuildingAt(col, this.core.localBuildRow)) { this.rejectPlay(true); return; }
        if (this.core.engine.state.board.isNoBuild(col, this.core.localBuildRow)) { this.rejectPlay(true); return; }
        this.core.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Spell: {
        if (spellType === SpellType.Haste)       this.core.engine.playCard(handIndex, 0);
        else if (spellType === SpellType.Meteor)  this.core.engine.playCard(handIndex, col, row);
        else if (spellType === SpellType.Rockslide || spellType === SpellType.BridgeCollapse) {
          this.core.engine.playCard(handIndex, col);
        }
        break;
      }
    }
  }

  /** See ./placementHighlights.ts for the actual highlight logic. */
  private updatePlacementHighlights(
    cardType: CardType, spellType: SpellType | undefined,
    col: number, row: number, x: number, y: number,
  ): void {
    updatePlacementHighlightsImpl(this.core, cardType, spellType, col, row, x, y);
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
    this.core.handView.clearSelection();
    this.core.boardView.clearHighlights();
    this.core.unitView.setSpellTargetPreview(EMPTY_UNIT_IDS);
  }

  private buildDragGhost(label: string, cost: number, accentColor = 0x2244aa): PIXI.Container {
    const c   = new PIXI.Container();
    const gfx = new PIXI.Graphics();
    gfx.beginFill(0xfaf6ee, 0.9);
    gfx.lineStyle(2, accentColor);
    gfx.drawRoundedRect(-32, -42, 64, 84, 6);
    gfx.endFill();

    const nameText = makeText(label, { fontSize: FS.micro, fill: 0x222222, align: 'center' });
    nameText.anchor.set(0.5, 0.5);
    nameText.y = -10;

    const costText = makeText(String(cost), { fontSize: FS.tiny, fill: accentColor, fontWeight: 'bold' });
    costText.anchor.set(0.5, 0.5);
    costText.y = 18;

    c.addChild(gfx, nameText, costText);
    c.alpha = 0.9;
    return c;
  }

  /**
   * Reset drag/tap-select/pending-press state and free the drag ghost — called from
   * GameRendererCore.destroy() as an isolated step (see its file-header comment: this
   * deliberately does NOT call cancelDrag()/cancelTapSelect(), which touch
   * handView/boardView/unitView — those sub-views are already destroyed by the time this
   * runs in the destroy() sequence).
   */
  destroy(): void {
    this.drag?.ghost.destroy();
    this.drag            = null;
    this.tapSelect       = null;
    this.pendingCardDown = null;
  }
}

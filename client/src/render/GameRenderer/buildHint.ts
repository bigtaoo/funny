// buildHint.ts — "build a defense first", the campaign's one in-battle nudge (ONBOARDING_DESIGN §12).
//
// The first live CrazyGames day (2026-10-09) split ch1_lv1's first attempts cleanly by buildings:
// winners had towers/barracks standing most of the match and lost no base HP; losers threw units into
// 190-HP enemies, built little, and fell after the boss wave. The tutorial right before it runs its
// enemies at 6.5% HP, where any one card clears a lane — so it never shows why a building matters.
//
// So: on a level the nav layer opts in (not yet cleared), if the player still has no building
// `atTick` into the battle, an instruction strip names the fix and the tutorial's own ghost-hand demo
// (breathing frame on a building card, ghost gliding to the lane under most pressure) shows the
// gesture. It never pauses, never blocks a tap, never plays for the player; it ends for good when a
// building lands or after SHOW_MAX_SEC.
import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BOARD_COLS } from '@nw/engine/config';
import { BuildingType, CardType, GamePhase, Side, type GameState } from '../../game';
import type { ILayout, Rect } from '../../layout/ILayout';
import { t } from '../../i18n';
import { drawStrip, clearStrip } from '../TutorialDirector/panels';
import { drawSlotRing, fillGhostLayer, poseGhost, GHOST_LOOP_SEC } from '../TutorialDirector/ghostDemo';

export type BuildHintOutcome = 'shown' | 'built' | 'expired';

/** Supplied by the nav layer for levels that should carry the hint. */
export interface BuildHintConfig {
  /** Engine tick after which a player with no building yet is shown the hint. */
  atTick: number;
  /** Lifecycle telemetry: 'shown' once, then exactly one of 'built' / 'expired'. */
  onEvent?(outcome: BuildHintOutcome, tick: number): void;
}

export interface BuildHintHost {
  readonly container: PIXI.Container;
  readonly layout: ILayout;
  readonly localBuildRow: number;
  state(): GameState;
  /** Tick of the local player's first building, null while none (FirstBuildWatch). */
  firstBuildTick(): number | null;
  /** The pause / surrender dialog is up: the hint hides and its clock stops. */
  isPaused(): boolean;
  /** A hand card is pressed, dragged or tap-selected — the ghost steps aside. */
  isHoldingCard(): boolean;
  handSlotCenter(index: number): { x: number; y: number };
  buildCardGhost(index: number): PIXI.Container | null;
}

/** How long the hint stays up when ignored. */
const SHOW_MAX_SEC = 20;

export class BuildHint {
  private readonly root = new PIXI.Container();
  private readonly ring = new PIXI.Graphics();
  private readonly ghost = new PIXI.Container();
  private readonly strip = new PIXI.Container();
  private shown = false;
  private done = false;
  private time = 0;
  private ghostT = 0;
  private ghostSlot = -1;
  private targetCol = -1;

  constructor(private readonly host: BuildHintHost, private readonly cfg: BuildHintConfig) {
    this.root.name = 'buildHint';
    this.root.visible = false;
    this.ghost.visible = false;
    this.root.addChild(this.ring, this.strip, this.ghost);
  }

  update(dt: number): void {
    if (this.done) return;
    const state = this.host.state();
    if (this.host.firstBuildTick() !== null) { this.end('built', state); return; }
    if (state.phase === GamePhase.GameOver) { this.end(null, state); return; }
    if (!this.shown) {
      if (state.elapsedTicks < this.cfg.atTick) return;
      const slot = this.pickSlot(state);
      if (slot < 0) return; // no affordable building in hand yet — wait for one
      this.show(state, slot);
    }
    if (this.host.isPaused()) { this.root.visible = false; return; }
    this.root.visible = true;
    this.time += dt;
    if (this.time >= SHOW_MAX_SEC) { this.end('expired', state); return; }

    const slot = this.pickSlot(state);
    if (slot < 0) { this.ring.visible = false; this.ghost.visible = false; return; }
    drawSlotRing(this.ring, this.host.layout, this.host.handSlotCenter(slot), this.time);
    if (this.host.isHoldingCard()) { this.ghost.visible = false; this.ghostT = 0; return; }
    if (slot !== this.ghostSlot) {
      fillGhostLayer(this.ghost, this.host.layout, this.host.buildCardGhost(slot));
      this.ghostSlot = slot;
      this.ghostT = 0;
    }
    // Re-aim only between passes, so the ghost never swerves mid-glide.
    if (this.ghostT === 0 || this.targetCol < 0) this.targetCol = pressureLane(state, this.host.layout.localSide, this.host.localBuildRow);
    this.ghostT += dt;
    if (this.ghostT >= GHOST_LOOP_SEC) this.ghostT = 0;
    poseGhost(this.ghost, this.ghostT, this.host.handSlotCenter(slot), this.host.layout.gridToScreen(this.targetCol, this.host.localBuildRow));
  }

  destroy(): void {
    clearStrip({ strip: this.strip });
    this.root.destroy({ children: true });
  }

  private show(state: GameState, slot: number): void {
    this.shown = true;
    this.targetCol = pressureLane(state, this.host.layout.localSide, this.host.localBuildRow);
    this.host.container.addChild(this.root);
    // The strip takes whichever band (top of the board / above the hand) covers less of the card
    // and the build row it points at — same placement rule as the tutorial's instruction line.
    const L = this.host.layout;
    const c = this.host.handSlotCenter(slot);
    const cell = L.gridToScreen(this.targetCol, this.host.localBuildRow);
    const avoid: Rect[] = [
      { x: c.x - L.cardWidth / 2, y: c.y - L.cardHeight / 2, w: L.cardWidth, h: L.cardHeight },
      { x: L.boardRect.x, y: cell.y - L.cellSize, w: L.boardRect.w, h: L.cellSize * 2 },
    ];
    drawStrip({ layout: L, strip: this.strip }, t('hint.build.title'), t('hint.build.body'), avoid);
    this.cfg.onEvent?.('shown', state.elapsedTicks);
  }

  private end(outcome: Exclude<BuildHintOutcome, 'shown'> | null, state: GameState): void {
    this.done = true;
    if (!this.shown) return; // built before it was ever needed — nothing on screen, nothing to report
    this.root.visible = false;
    if (outcome) this.cfg.onEvent?.(outcome, state.elapsedTicks);
  }

  /** Hand slot of the building card to demo — an arrow tower first — or -1 if none is affordable. */
  private pickSlot(state: GameState): number {
    const me = this.host.layout.localSide === Side.Bottom ? state.bottomPlayer : state.topPlayer;
    let best = -1;
    me.hand.slots.forEach((s, i) => {
      if (!s || s.card.cardType !== CardType.Building || s.card.cost > me.ink) return;
      if (best < 0 || (s.card.buildingType === BuildingType.ArrowTower && me.hand.slots[best]?.card.buildingType !== BuildingType.ArrowTower)) best = i;
    });
    return best;
  }
}

/**
 * The buildable lane whose nearest enemy is closest to our build row; with no enemy on the board, the
 * buildable lane nearest the centre (where ch1's first waves walk).
 */
export function pressureLane(state: GameState, ourSide: Side, buildRow: number): number {
  const board = state.board;
  const lanes = (ATTACK_LANES as readonly number[]).filter((c) => !board.hasBuildingAt(c, buildRow) && !board.isNoBuild(c, buildRow));
  if (lanes.length === 0) return ATTACK_LANES[0];
  const nearest = new Map<number, number>();
  for (const u of board.units.values()) {
    if (u.isDead || u.side === ourSide) continue;
    const d = Math.abs(u.row - buildRow);
    if (d < (nearest.get(u.col) ?? Infinity)) nearest.set(u.col, d);
  }
  const centre = (BOARD_COLS - 1) / 2;
  let best = lanes[0]!;
  let bestKey = Infinity;
  for (const c of lanes) {
    const key = (nearest.get(c) ?? 1e6) * 100 + Math.abs(c - centre);
    if (key < bestKey) { bestKey = key; best = c; }
  }
  return best;
}

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
//
// The idle nudge (ONBOARDING_DESIGN §15.3) rides on the same ghost: on CrazyGames most ch1_lv1 exits
// were players who sat for ~20 s without playing anything. With `idleNudgeSec` set, whenever the strip
// is not up, a player who holds an affordable card and has played nothing for that long gets the ring
// and the ghost (no strip) on it — a building first, else any card — until they pick a card up or play.
import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BOARD_COLS } from '@nw/engine/config';
import { TICK_RATE } from '@nw/engine/math/fixed';
import { BuildingType, CardType, GamePhase, Side, type GameState } from '../../game';
import type { ILayout, Rect } from '../../layout/ILayout';
import { t } from '../../i18n';
import { drawStrip, clearStrip } from '../TutorialDirector/panels';
import { drawSlotRing, fillGhostLayer, poseGhost, GHOST_LOOP_SEC } from '../TutorialDirector/ghostDemo';

export type BuildHintOutcome = 'shown' | 'built' | 'expired';

/** How many idle nudges one battle may show; past that, a player who is not playing has chosen not to. */
const IDLE_NUDGE_MAX = 4;

/** Supplied by the nav layer for levels that should carry the hint. */
export interface BuildHintConfig {
  /** Engine tick after which a player with no building yet is shown the hint. */
  atTick: number;
  /** Lifecycle telemetry: 'shown' once, then exactly one of 'built' / 'expired'. */
  onEvent?(outcome: BuildHintOutcome, tick: number): void;
  /** Seconds of engine time with an affordable card and no play before the idle nudge; unset = none. */
  idleNudgeSec?: number;
  /** The first idle nudge of the battle went up. */
  onIdleNudge?(tick: number): void;
  /** The local player's first card play of the battle. */
  onFirstPlay?(tick: number): void;
}

export interface BuildHintHost {
  readonly container: PIXI.Container;
  readonly layout: ILayout;
  readonly localBuildRow: number;
  state(): GameState;
  /** Tick of the local player's first building, null while none (FirstBuildWatch). */
  firstBuildTick(): number | null;
  /** Ticks of the local player's first and latest card play, null while none (FirstBuildWatch). */
  firstPlayTick(): number | null;
  lastPlayTick(): number | null;
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
  private nudges = 0;
  private nudging = false;
  private firstPlaySeen = false;
  private nudgeTime = 0;

  constructor(private readonly host: BuildHintHost, private readonly cfg: BuildHintConfig) {
    this.root.name = 'buildHint';
    this.root.visible = false;
    this.ghost.visible = false;
    this.root.addChild(this.ring, this.strip, this.ghost);
  }

  update(dt: number): void {
    const state = this.host.state();
    const firstPlay = this.host.firstPlayTick();
    if (firstPlay !== null && !this.firstPlaySeen) { this.firstPlaySeen = true; this.cfg.onFirstPlay?.(firstPlay); }
    if (this.done) { this.idleNudge(dt, state); return; }
    if (this.host.firstBuildTick() !== null) { this.end('built', state); return; }
    if (state.phase === GamePhase.GameOver) { this.end(null, state); return; }
    if (!this.shown) {
      const slot = state.elapsedTicks < this.cfg.atTick ? -1 : this.pickSlot(state);
      if (slot < 0) { this.idleNudge(dt, state); return; } // too early, or no affordable building yet
      this.stopNudge();
      this.show(state, slot);
    }
    if (this.host.isPaused()) { this.root.visible = false; return; }
    this.root.visible = true;
    this.time += dt;
    if (this.time >= SHOW_MAX_SEC) { this.end('expired', state); return; }

    const slot = this.pickSlot(state);
    if (slot < 0) { this.ring.visible = false; this.ghost.visible = false; return; }
    this.animate(dt, state, slot, this.time);
  }

  /** One frame of the ring on hand slot `slot` and the ghost gliding from it to the pressure lane. */
  private animate(dt: number, state: GameState, slot: number, ringTime: number): void {
    this.ring.visible = true;
    drawSlotRing(this.ring, this.host.layout, this.host.handSlotCenter(slot), ringTime);
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

  /**
   * The idle nudge: ring + ghost on an affordable card once the player has played nothing for
   * `idleNudgeSec` (counted from the battle start or their latest play). Hidden while the game is
   * paused, the ghost steps aside while a card is held; it ends at the next play.
   */
  private idleNudge(dt: number, state: GameState): void {
    const idleSec = this.cfg.idleNudgeSec;
    if (idleSec === undefined || state.phase === GamePhase.GameOver) { this.stopNudge(); return; }
    const sinceTick = this.host.lastPlayTick() ?? 0;
    const idle = (state.elapsedTicks - sinceTick) / TICK_RATE >= idleSec;
    if (!this.nudging) {
      if (!idle || this.nudges >= IDLE_NUDGE_MAX || this.host.isPaused()) return;
      const slot = this.pickSlot(state, true);
      if (slot < 0) return;
      this.nudging = true;
      this.nudges++;
      if (this.nudges === 1) this.cfg.onIdleNudge?.(state.elapsedTicks);
      this.ghostSlot = -1;
      this.ghostT = 0;
      this.nudgeTime = 0;
      if (!this.root.parent) this.host.container.addChild(this.root);
      this.strip.visible = false;
    }
    if (!idle) { this.stopNudge(); return; }
    const slot = this.pickSlot(state, true);
    if (slot < 0 || this.host.isPaused()) { this.root.visible = false; return; }
    this.root.visible = true;
    this.nudgeTime += dt;
    this.animate(dt, state, slot, this.nudgeTime);
  }

  private stopNudge(): void {
    if (!this.nudging) return;
    this.nudging = false;
    this.root.visible = false;
    this.strip.visible = true;
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

  /**
   * Hand slot of the building card to demo — an arrow tower first — or -1 if none is affordable.
   * `anyCard` (the idle nudge): with no affordable building, the first affordable unit card instead;
   * spells are left out, since their target is not a build-row cell the ghost could point at.
   */
  private pickSlot(state: GameState, anyCard = false): number {
    const me = this.host.layout.localSide === Side.Bottom ? state.bottomPlayer : state.topPlayer;
    let best = -1;
    me.hand.slots.forEach((s, i) => {
      if (!s || s.card.cardType !== CardType.Building || s.card.cost > me.ink) return;
      if (best < 0 || (s.card.buildingType === BuildingType.ArrowTower && me.hand.slots[best]?.card.buildingType !== BuildingType.ArrowTower)) best = i;
    });
    if (best < 0 && anyCard) best = me.hand.slots.findIndex((s) => !!s && s.card.cardType === CardType.Unit && s.card.cost <= me.ink);
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

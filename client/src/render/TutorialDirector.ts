import * as PIXI from 'pixi.js-legacy';
import type { GameState } from '../game';
import { toFp } from '@nw/engine/math/fixed';
import { ILayout, Rect } from '../layout/ILayout';
import { t } from '../i18n';
import type { Phase, TutorialConfig } from './TutorialDirector/types';
import { buildLayers, drawStrip, clearStrip, drawGradCard, type PanelHost } from './TutorialDirector/panels';
import { BEATS, BEAT_STEP_KEY, beatText, type BeatSpec } from './TutorialDirector/beats';
import {
  IDLE_GHOST_SEC, BASE_LABEL_HOLD_SEC, BASE_LABEL_FADE_SEC, FEEDBACK_SEC, STRIP_FADE_SEC, FINALE_MAX_SEC, FINALE_PAUSE_SEC, GRAD_CARD_DELAY_SEC, GRAD_POP_SEC, SHAKE_SEC, SHAKE_AMP, LANE_SNAP_COLS, METEOR_SNAP_CELLS,
} from './TutorialDirector/beats';
import { enemyUnits, bestMeteorAnchor, beatTargetPoint, meteorAnchorCenter } from './TutorialDirector/geometry';
import { dispatchHit } from '../ui/hits';
import { drawSlotRing, fillGhostLayer, poseGhost, GHOST_LOOP_SEC } from './TutorialDirector/ghostDemo';

export type { TutorialConfig, TutorialBeatDone } from './TutorialDirector/types';

/**
 * TutorialDirector — presentation-layer orchestrator for the tutorial level `ch0_tutorial`
 * (ONBOARDING_DESIGN §11, the 2026-10 "first minute" rework).
 *
 * **Pure presentation layer**: reads state for diffing, controls the engine clock (freeze/unfreeze)
 * and draws the guidance UI. Never mutates battle state — the one exception is the never-fail base
 * floor clamp (§3.5). Engine determinism, replay and referee are unaffected: the only thing it does
 * to a play is aim-assist the target of the guided card before the normal `play_card` goes out.
 *
 * Flow (no "Next" buttons anywhere, §11.2): the battle is live from tick 0 (`YOU` / `ENEMY` on the
 * bases); each of the three beats runs the engine to its `setupTick`, freezes on one instruction line
 * until the guided card lands, then runs on while the next beat's enemies arrive — no dead waits
 * (§11.2 rules 5–6; ticks tuned headless, see beats.ts). The meteor ends it: WIN banner → graduation
 * card, whose one button leaves.
 *
 * Idle escalation (§11.4) — never plays for the player: breathing card frame + lit target from the
 * first frame; after IDLE_GHOST_SEC[beat] without touching a card a ghost card glides from the hand
 * to the target on a loop; a wrong drop (wrong card or wrong place) plays the ghost immediately.
 *
 * Never-fail: no threats while frozen, every beat's enemies are weak (`enemyScale.hp`), and base HP
 * is clamped from below as a host fallback.
 */

// ── Host hooks: provided by GameRenderer — view geometry, highlights, engine clock, endgame. ───
export interface TutorialHost {
  readonly container: PIXI.Container;
  readonly layout: ILayout;
  readonly config: TutorialConfig;
  /** Highlight one unit lane (blue, unit-deploy beat). */
  highlightUnitLane(col: number): void;
  /** Highlight one building slot (blue, building-deploy beat). */
  highlightBuildingLane(col: number): void;
  /** Clear all board lane highlights. */
  clearLaneHighlights(): void;
  /** Design-space center of a hand slot for the local player (used to frame the guided card). */
  handSlotCenter(index: number): { x: number; y: number };
  /** A drag-ghost look-alike of the card in hand slot `index` (the ghost-hand demo), or null. */
  buildCardGhost(index: number): PIXI.Container | null;
  /** Scripted victory: WIN banner + stinger. Does NOT end the scene — see finish(). */
  forceVictory(): void;
  /** Leave the tutorial as a win (fires the scene's onGameEnd). */
  finish(): void;
  /** Skip tutorial: return to lobby (host is responsible for writing tutorial_done). */
  onSkip(): void;
}

// Base never falls: clamp HP to this floor when it drops below (§3.5 fallback).
const NEVER_FAIL_BASE_FLOOR = 1;

// Blue = player highlight (panels.ts keeps its own copy for the strip border).
const C_BLUE = 0x4a7fc1;

export class TutorialDirector {
  private readonly host: TutorialHost;
  private readonly layout: ILayout;
  private readonly root: PIXI.Container;

  private phase: Phase = 'intro';
  /** Next beat to prompt (intro/beat phases) — BEATS.length once all three have been played. */
  private beatIndex = 0;
  /** A beat's prompt is up and the engine is frozen on it. */
  private prompting = false;
  /** Set by allowCardPlay when the guided card was accepted; consumed on the next onTick. */
  private pendingRelease = false;
  /** Whether the engine is frozen (read by GameRendererCore.update before ticking the engine). */
  engineFrozen = false;

  // Real-time clocks (seconds).
  private time = 0;
  private promptAt = 0;
  private idleSec = 0;
  private stripHideAt = Infinity;
  private finaleAt = 0;
  private victoryAt = Infinity;
  private gradAt = Infinity;
  private footnoteShown = false;
  private shakeLeft = 0;
  private readonly shakeOrigin = { x: 0, y: 0 };

  // Per-beat analytics.
  private ghostShown = false;
  private wrongDrops = 0;

  // Ghost-hand demo.
  private ghostOn = false;
  private ghostT = 0;
  private ghostCard: PIXI.Container | null = null;
  private ghostSlot = -1;
  /** A hand card is being dragged / tap-selected right now: hide the demo and stop the idle clock. */
  private holdingCard = false;
  /** The board highlights were cleared by a drag / tap-select ending — re-light the target next frame. */
  private highlightDirty = false;

  /** Current meteor anchor (2×2 top-left cell covering the most enemies), recomputed each frame of Beat 3. */
  private meteorAnchor: { col: number; row: number } | null = null;
  /** Hand slot of the current guided card, -1 when not in hand. */
  private slotIndex = -1;

  // UI layers (built by panels.ts).
  private slotRing!: PIXI.Graphics;
  private clusterRing!: PIXI.Graphics;
  private baseLabels!: PIXI.Container;
  private ghost!: PIXI.Container;
  private strip!: PIXI.Container;
  private gradCard!: PIXI.Container;
  private skipBtn!: PIXI.Container;
  private skipBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private ctaRect: Rect | null = null;

  constructor(host: TutorialHost) {
    this.host = host;
    this.layout = host.layout;
    this.root = new PIXI.Container();
    host.container.addChild(this.root);
    buildLayers(this.panelHost());
    this.shakeOrigin.x = host.container.x;
    this.shakeOrigin.y = host.container.y;
  }

  /** Bundles what panels.ts's build/draw functions need instead of them closing over `this`. */
  private panelHost(): PanelHost {
    const d = this;
    return {
      root: this.root, layout: this.layout,
      get slotRing() { return d.slotRing; }, set slotRing(v) { d.slotRing = v; },
      get clusterRing() { return d.clusterRing; }, set clusterRing(v) { d.clusterRing = v; },
      get baseLabels() { return d.baseLabels; }, set baseLabels(v) { d.baseLabels = v; },
      get ghost() { return d.ghost; }, set ghost(v) { d.ghost = v; },
      get strip() { return d.strip; }, set strip(v) { d.strip = v; },
      get gradCard() { return d.gradCard; }, set gradCard(v) { d.gradCard = v; },
      get skipBtn() { return d.skipBtn; }, set skipBtn(v) { d.skipBtn = v; },
      get skipBtnRect() { return d.skipBtnRect; }, set skipBtnRect(v) { d.skipBtnRect = v; },
      get ctaRect() { return d.ctaRect; }, set ctaRect(v) { d.ctaRect = v; },
    };
  }

  /** True once the scripted win is in — GameRenderer stops settling engine win/loss before this. */
  get isFinished(): boolean { return this.phase === 'graduate' || this.phase === 'done'; }

  // ── Input (GameRenderer asks the director first, avoiding PIXI interactive) ─────────────────────

  /** Returns true when this tap is consumed by the director; GameRenderer will not process it further. */
  handleDown(x: number, y: number): boolean {
    if (this.phase === 'done') return true;
    if (this.phase === 'graduate') {
      // Only the button leaves; the rest of the screen is inert so a stray tap can't skip the moment.
      if (this.ctaRect && this.gradCard.scale.x >= 0.999) {
        dispatchHit([{ rect: this.ctaRect, fn: () => this.leave() }], x, y);
      }
      return true;
    }
    // The skip button goes through the shared table like every other button (its tap cue lives there).
    if (dispatchHit([{ rect: this.skipBtnRect, sound: 'sfx.ui.back', fn: () => this.host.onSkip() }], x, y)) return true;
    return false; // board/hand interactions pass through
  }

  /** GameRenderer: a hand card was pressed (drag start / tap-select) or let go. */
  setHoldingCard(holding: boolean): void {
    this.holdingCard = holding;
    if (holding) { this.idleSec = 0; this.setGhost(false); }
  }

  /** GameRenderer: a drag / tap-select just cleared the board highlights — re-light the target. */
  markHighlightDirty(): void {
    this.highlightDirty = true;
  }

  /**
   * Called by GameRenderer.commitCardPlay. Returns the (possibly aim-assisted) target to play the card
   * at, or null to reject the play. Outside a prompt every play is rejected; inside one only the guided
   * card itself (by id — barracks is a building too, haste a spell too) near its target is accepted
   * (snapped onto the target); anything else counts as a wrong drop and plays the ghost demo straight
   * away (§11.4).
   */
  allowCardPlay(cardId: string, col: number, row: number): { col: number; row: number } | null {
    if (!this.prompting || this.pendingRelease) return null;
    const target = this.snapCardPlay(cardId, col, row);
    if (!target) {
      this.wrongDrops++;
      this.holdingCard = false;
      this.setGhost(true);
      return null;
    }
    this.pendingRelease = true;
    return target;
  }

  /**
   * Where a drop of `cardId` at (col, row) would land, or null if it would be rejected — the aim
   * assist of allowCardPlay without its side effects (no wrong-drop count, no ghost demo), so the
   * drag's landing preview can ask on every pointer move.
   */
  snapCardPlay(cardId: string, col: number, row: number): { col: number; row: number } | null {
    if (!this.prompting || this.pendingRelease) return null;
    const beat = BEATS[this.beatIndex]!;
    if (cardId !== beat.cardId) return null;
    if (beat.kind === 'spell') {
      const a = this.meteorAnchor;
      return a && Math.abs(col - a.col) <= METEOR_SNAP_CELLS && Math.abs(row - a.row) <= METEOR_SNAP_CELLS ? a : null;
    }
    return Math.abs(col - beat.col) <= LANE_SNAP_COLS ? { col: beat.col, row } : null;
  }

  // ── Per-frame (end of GameRenderer.update): clock control, never-fail clamp, state machine, anims ──
  onTick(state: GameState, dt: number): void {
    this.time += dt;

    // Never-fail: clamp base HP from below (§3.5 presentation-layer fallback).
    if (state.bottomPlayer.baseHp_fp < toFp(NEVER_FAIL_BASE_FLOOR)) {
      state.bottomPlayer.baseHp_fp = toFp(NEVER_FAIL_BASE_FLOOR);
    }

    this.animateBaseLabels();
    this.animateStrip(dt);
    this.animateShake(dt);

    switch (this.phase) {
      case 'intro':
      case 'beat':
        this.tickBeats(state, dt);
        break;
      case 'finale':
        if (this.victoryAt === Infinity) {
          const cleared = enemyUnits(state).length === 0;
          if (cleared || this.time - this.finaleAt >= FINALE_MAX_SEC) this.victoryAt = this.time + FINALE_PAUSE_SEC;
        } else if (this.time >= this.victoryAt) {
          this.victory();
        }
        break;
      case 'graduate':
        if (this.time >= this.gradAt) this.animateGradCard();
        break;
      case 'done':
        break;
    }
  }

  destroy(): void {
    this.host.container.position.set(this.shakeOrigin.x, this.shakeOrigin.y);
    this.root.destroy({ children: true });
  }

  // ── Beats ───────────────────────────────────────────────────────────────────────────────────────

  private tickBeats(state: GameState, dt: number): void {
    if (this.pendingRelease) { this.release(); return; }
    const beat = BEATS[this.beatIndex];
    if (!beat) return;
    if (!this.prompting) {
      if (state.elapsedTicks >= beat.setupTick) this.prompt(state);
      return;
    }
    // Prompt up: track the guided card, idle escalation, ghost demo.
    this.slotIndex = state.bottomPlayer.hand.slots.findIndex((s) => s?.card.id === beat.cardId);
    if (beat.kind === 'spell') this.meteorAnchor = bestMeteorAnchor(state);
    this.animateRings(beat);
    if (!this.holdingCard) {
      if (this.highlightDirty) { this.highlightTarget(beat); this.highlightDirty = false; }
      this.idleSec += dt;
      if (!this.ghostOn && this.idleSec >= IDLE_GHOST_SEC[this.beatIndex]!) this.setGhost(true);
    }
    if (this.ghostOn) this.animateGhost(dt, beat);
  }

  private prompt(state: GameState): void {
    const beat = BEATS[this.beatIndex]!;
    this.phase = 'beat';
    this.prompting = true;
    this.engineFrozen = true;
    this.promptAt = this.time;
    this.idleSec = 0;
    this.ghostShown = false;
    this.wrongDrops = 0;
    this.slotIndex = state.bottomPlayer.hand.slots.findIndex((s) => s?.card.id === beat.cardId);

    this.highlightTarget(beat);
    this.meteorAnchor = beat.kind === 'spell' ? bestMeteorAnchor(state) : null;
    this.animateRings(beat);

    const text = beatText(beat.kind);
    this.showStrip(text.title, text.body, Infinity);
    this.host.config.onStep?.(BEAT_STEP_KEY[beat.kind]);
  }

  private highlightTarget(beat: BeatSpec): void {
    if (beat.kind === 'unit') this.host.highlightUnitLane(beat.col);
    else if (beat.kind === 'building') this.host.highlightBuildingLane(beat.col);
    else this.host.clearLaneHighlights();
  }

  private release(): void {
    const beat = BEATS[this.beatIndex]!;
    this.pendingRelease = false;
    this.prompting = false;
    this.engineFrozen = false;
    this.setGhost(false);
    this.host.clearLaneHighlights();
    this.slotRing.visible = false;
    this.clusterRing.visible = false;
    this.host.config.onBeatDone?.({
      beat: beat.kind,
      idle_ms: Math.round((this.time - this.promptAt) * 1000),
      ghost_shown: this.ghostShown,
      wrong_drops: this.wrongDrops,
    });

    const done = beatText(beat.kind).done;
    if (done) this.showStrip(null, done, this.time + FEEDBACK_SEC);
    else this.stripHideAt = this.time; // fade the instruction out

    this.beatIndex++;
    if (beat.kind === 'spell') {
      this.shakeLeft = SHAKE_SEC;
      this.phase = 'finale';
      this.finaleAt = this.time;
    }
  }

  // ── Endgame ─────────────────────────────────────────────────────────────────────────────────────

  private victory(): void {
    this.phase = 'graduate';
    this.engineFrozen = true;
    this.stripHideAt = this.time;
    this.skipBtn.visible = false;
    this.host.forceVictory();
    const cfg = this.host.config;
    drawGradCard(this.panelHost(), t('tutorial.grad.body'), cfg.teaser, cfg.ctaLabel, cfg.footnote);
    this.gradCard.scale.set(0);
    this.gradAt = this.time + GRAD_CARD_DELAY_SEC;
    cfg.onStep?.('graduate');
  }

  private leave(): void {
    if (this.phase !== 'graduate') return;
    this.phase = 'done';
    this.host.finish();
  }

  // ── Animation ───────────────────────────────────────────────────────────────────────────────────

  private showStrip(title: string | null, body: string | null, hideAt: number): void {
    drawStrip(this.panelHost(), title, body, this.avoidRects());
    this.stripHideAt = hideAt;
  }

  private animateStrip(dt: number): void {
    if (!this.strip.visible || this.time < this.stripHideAt) return;
    this.strip.alpha = Math.max(0, this.strip.alpha - dt / STRIP_FADE_SEC);
    if (this.strip.alpha <= 0) { clearStrip(this.panelHost()); this.strip.visible = false; }
  }

  private animateBaseLabels(): void {
    if (!this.baseLabels.visible) return;
    const a = 1 - (this.time - BASE_LABEL_HOLD_SEC) / BASE_LABEL_FADE_SEC;
    if (a >= 1) return;
    if (a <= 0) { this.baseLabels.visible = false; return; }
    this.baseLabels.alpha = a;
  }

  private animateShake(dt: number): void {
    if (this.shakeLeft <= 0) return;
    this.shakeLeft = Math.max(0, this.shakeLeft - dt);
    const amp = SHAKE_AMP * (this.shakeLeft / SHAKE_SEC);
    this.host.container.position.set(
      this.shakeOrigin.x + (Math.random() * 2 - 1) * amp,
      this.shakeOrigin.y + (Math.random() * 2 - 1) * amp,
    );
  }

  private animateGradCard(): void {
    if (!this.footnoteShown) { this.footnoteShown = true; this.host.config.onFootnoteShown?.(); }
    const k = Math.min(1, (this.time - this.gradAt) / GRAD_POP_SEC);
    // easeOutBack — a small overshoot reads as a stamp landing.
    const c = 1.70158;
    const s = 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
    this.gradCard.scale.set(k >= 1 ? 1 : s);
  }

  /** Breathing frame around the guided card + the meteor target ring. */
  private animateRings(beat: BeatSpec): void {
    if (this.slotIndex >= 0) {
      drawSlotRing(this.slotRing, this.layout, this.host.handSlotCenter(this.slotIndex), this.time);
    } else {
      this.slotRing.visible = false;
    }
    if (beat.kind === 'spell' && this.meteorAnchor) {
      const a = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(this.time * 5));
      const p = this.anchorCenter(this.meteorAnchor);
      const r = this.layout.cellSize * (1.25 + 0.15 * Math.sin(this.time * 5));
      this.clusterRing.clear();
      this.clusterRing.lineStyle(4, C_BLUE, a);
      this.clusterRing.drawCircle(p.x, p.y, r);
      this.clusterRing.visible = true;
    } else {
      this.clusterRing.visible = false;
    }
  }

  private setGhost(on: boolean): void {
    if (on && (!this.prompting || this.holdingCard)) return;
    if (on) {
      this.ghostOn = true;
      this.ghostShown = true;
      this.ghostT = 0;
      return;
    }
    this.ghostOn = false;
    this.ghost.visible = false;
  }

  /** Ghost card glides from the guided card's hand slot to its target, holds, loops (§11.4). */
  private animateGhost(dt: number, beat: BeatSpec): void {
    if (this.slotIndex < 0) { this.ghost.visible = false; return; }
    if (this.ghostSlot !== this.slotIndex || !this.ghostCard) {
      this.ghostCard = this.host.buildCardGhost(this.slotIndex);
      this.ghostSlot = this.slotIndex;
      fillGhostLayer(this.ghost, this.layout, this.ghostCard);
    }
    this.ghostT = (this.ghostT + dt) % GHOST_LOOP_SEC;
    poseGhost(this.ghost, this.ghostT, this.host.handSlotCenter(this.slotIndex), this.targetPoint(beat));
  }

  // ── Geometry ────────────────────────────────────────────────────────────────────────────────────

  private targetPoint(beat: BeatSpec): { x: number; y: number } {
    return beatTargetPoint(this.layout, beat, this.meteorAnchor);
  }

  private anchorCenter(a: { col: number; row: number }): { x: number; y: number } {
    return meteorAnchorCenter(this.layout, a);
  }

  /** What the instruction strip must not cover (§11.5): the target, the guided card, the Skip button. */
  private avoidRects(): Rect[] {
    const out: Rect[] = [this.skipBtnRect];
    const beat = BEATS[this.beatIndex];
    if (!beat) return out;
    const cs = this.layout.cellSize;
    const p = this.targetPoint(beat);
    const reach = beat.kind === 'spell' ? cs * 1.5 : cs;
    out.push({ x: p.x - reach, y: p.y - reach, w: reach * 2, h: reach * 2 });
    if (this.slotIndex >= 0) {
      const c = this.host.handSlotCenter(this.slotIndex);
      const w = this.layout.cardWidth;
      const h = this.layout.cardHeight;
      out.push({ x: c.x - w / 2, y: c.y - h / 2, w, h });
    }
    return out;
  }
}

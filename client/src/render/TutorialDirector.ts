import * as PIXI from 'pixi.js-legacy';
import { GamePhase, type GameState } from '../game';
import { toFp } from '@nw/engine/math/fixed';
import { ILayout, Rect } from '../layout/ILayout';
import { t } from '../i18n';
import type { Phase, TutorialConfig } from './TutorialDirector/types';
import { buildLayers, drawStrip, clearStrip, type PanelHost } from './TutorialDirector/panels';
import { BEATS, BEAT_STEP_KEY, beatText, type BeatSpec } from './TutorialDirector/beats';
import {
  IDLE_GHOST_SEC, BASE_LABEL_HOLD_SEC, BASE_LABEL_FADE_SEC, FEEDBACK_SEC, STRIP_FADE_SEC, FINALE_PAUSE_SEC, FREE_SETTLE_TICKS, FREE_IDLE_PROMPT_SEC, FREE_IDLE_GHOST_SEC, NEW_CARD_CALLOUT_SEC, TUTORIAL_NEW_CARD, SHAKE_SEC, SHAKE_AMP, LANE_SNAP_COLS,
} from './TutorialDirector/beats';
import { bestMeteorAnchor, beatTargetPoint, meteorAnchorCenter, stripAvoidRects } from './TutorialDirector/geometry';
import { dispatchHit } from '../ui/hits';
import { drawSlotRing, drawTargetRing, fillGhostLayer, poseGhost, GHOST_LOOP_SEC } from './TutorialDirector/ghostDemo';
import { pickIdleHint } from './TutorialDirector/idleHint';
import { Graduation } from './TutorialDirector/graduation';

export type { TutorialConfig, TutorialBeatDone, TutorialIdlePrompt } from './TutorialDirector/types';

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
 * (§11.2 rules 5–6; ticks tuned headless, see beats.ts). After the meteor the fight carries on
 * (§17.1, 'free'): every card plays, the level's later waves arrive, and the card its `cardUnlocks`
 * hands out gets a callout once it reaches the hand. A player who stops playing there is frozen on a
 * "play a card" prompt (§17.7) until they play again, so nobody idles into a win. The engine's own
 * `survive` win ends it: WIN stamp, then out — through the graduation card only when that card
 * carries the analytics notice.
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
  private victoryAt = Infinity;
  /** The free phase's new-card callout: shown once, its card framed until newCardUntil. */
  private newCardShown = false;
  private newCardUntil = -Infinity;
  /** Free phase: seconds since the last card play (or prompt), for the idle prompt. */
  private freeIdleSec = 0;
  /** Free phase: the idle prompt's target while it is up — the fight is frozen on it. */
  private idleHint: BeatSpec | null = null;
  private idlePrompts = 0; private idlePromptAt = 0; // telemetry: prompts shown so far, when the current one went up
  private readonly graduation: Graduation;
  private shakeLeft = 0;
  private readonly shakeOrigin = { x: 0, y: 0 };

  // Per-beat analytics.
  private ghostShown = false;
  private wrongCards = 0;
  private wrongSpots = 0;

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

  /** UI layers — built and redrawn by panels.ts, animated here. */
  private readonly ui: PanelHost;

  constructor(host: TutorialHost) {
    this.host = host;
    this.layout = host.layout;
    this.root = new PIXI.Container();
    host.container.addChild(this.root);
    // buildLayers fills in every layer before anything reads them.
    this.ui = { root: this.root, layout: this.layout, skipBtnRect: { x: 0, y: 0, w: 0, h: 0 }, ctaRect: null } as PanelHost;
    buildLayers(this.ui);
    this.graduation = new Graduation(() => this.ui, host.config);
    this.shakeOrigin.x = host.container.x;
    this.shakeOrigin.y = host.container.y;
  }

  /** True once the scripted win is in — GameRenderer stops settling engine win/loss before this. */
  get isFinished(): boolean { return this.phase === 'graduate' || this.phase === 'done'; }

  // ── Input (GameRenderer asks the director first, avoiding PIXI interactive) ─────────────────────

  /** Returns true when this tap is consumed by the director; GameRenderer will not process it further. */
  handleDown(x: number, y: number): boolean {
    if (this.phase === 'done') return true;
    if (this.phase === 'graduate') {
      if (this.graduation.tap(x, y)) this.leave();
      return true;
    }
    // The skip button goes through the shared table like every other button (its tap cue lives there).
    if (dispatchHit([{ rect: this.ui.skipBtnRect, sound: 'sfx.ui.back', fn: () => this.host.onSkip() }], x, y)) return true;
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
   * Called by GameRenderer.commitCardPlay: the (possibly aim-assisted) target to play the card at, or null
   * to reject. Outside a prompt every play is rejected; inside one only the guided card itself (by id —
   * barracks is a building too, haste a spell too) is accepted and snapped onto its target (unit beat
   * within LANE_SNAP_COLS of its lane, building/spell beats from anywhere, §17.9); anything else is a wrong
   * drop and plays the ghost demo straight away (§11.4). In the free phase every play goes and lifts the idle prompt.
   */
  allowCardPlay(cardId: string, col: number, row: number): { col: number; row: number } | null {
    if (this.phase === 'free') {
      this.freeIdleSec = 0;
      if (this.idleHint) this.pendingRelease = true;
      return { col, row };
    }
    if (!this.prompting || this.pendingRelease) return null;
    const target = this.snapCardPlay(cardId, col, row);
    if (!target) {
      if (cardId === BEATS[this.beatIndex]!.cardId) this.wrongSpots++; else this.wrongCards++;
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
    if (this.phase === 'free') return { col, row };
    if (!this.prompting || this.pendingRelease) return null;
    const beat = BEATS[this.beatIndex]!;
    if (cardId !== beat.cardId) return null;
    if (beat.kind === 'spell') return this.meteorAnchor;
    if (beat.kind === 'building') return { col: beat.col, row };
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
      case 'free':
        this.tickFree(state, dt);
        break;
      case 'graduate':
        if (this.graduation.tick(this.time)) this.leave();
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
    this.tickPrompt(state, dt, beat, IDLE_GHOST_SEC[this.beatIndex]!);
  }

  /** A prompt is up (a beat's or the free phase's idle one): track its card, idle escalation, ghost demo. */
  private tickPrompt(state: GameState, dt: number, beat: BeatSpec, ghostSec: number): void {
    this.slotIndex = state.bottomPlayer.hand.slots.findIndex((s) => s?.card.id === beat.cardId);
    if (beat.kind === 'spell') this.meteorAnchor = bestMeteorAnchor(state);
    this.animateRings(beat);
    if (!this.holdingCard) {
      if (this.highlightDirty) { this.highlightTarget(beat); this.highlightDirty = false; }
      this.idleSec += dt;
      if (!this.ghostOn && this.idleSec >= ghostSec) this.setGhost(true);
    }
    if (this.ghostOn) this.animateGhost(dt, beat);
  }

  private prompt(state: GameState): void {
    const beat = BEATS[this.beatIndex]!;
    this.phase = 'beat';
    this.promptAt = this.time;
    this.wrongCards = this.wrongSpots = 0;
    this.raisePrompt(state, beat);
    const text = beatText(beat.kind);
    this.showStrip(text.title, text.body, Infinity);
    this.host.config.onStep?.(BEAT_STEP_KEY[beat.kind]);
  }

  /** Freeze the fight on `beat`: frame its card, light its target. The caller shows the strip. */
  private raisePrompt(state: GameState, beat: BeatSpec): void {
    this.prompting = true;
    this.engineFrozen = true;
    this.idleSec = 0;
    this.ghostShown = false;
    this.slotIndex = state.bottomPlayer.hand.slots.findIndex((s) => s?.card.id === beat.cardId);
    this.highlightTarget(beat);
    this.meteorAnchor = beat.kind === 'spell' ? bestMeteorAnchor(state) : null;
    this.animateRings(beat);
  }

  /** Unfreeze after a prompt: drop the ghost, the lit target and the frames. */
  private lowerPrompt(): void {
    this.pendingRelease = false;
    this.prompting = false;
    this.engineFrozen = false;
    this.setGhost(false);
    this.host.clearLaneHighlights();
    this.ui.slotRing.visible = false;
    this.ui.clusterRing.visible = false;
  }

  private highlightTarget(beat: BeatSpec): void {
    if (beat.kind === 'unit') this.host.highlightUnitLane(beat.col);
    else if (beat.kind === 'building') this.host.highlightBuildingLane(beat.col);
    else this.host.clearLaneHighlights();
  }

  private release(): void {
    const beat = BEATS[this.beatIndex]!;
    this.lowerPrompt();
    this.host.config.onBeatDone?.({
      beat: beat.kind,
      idle_ms: Math.round((this.time - this.promptAt) * 1000),
      ghost_shown: this.ghostShown,
      wrong_drops: this.wrongCards + this.wrongSpots,
      wrong_card: this.wrongCards,
      wrong_spot: this.wrongSpots,
    });

    const done = beatText(beat.kind).done;
    if (done) this.showStrip(null, done, this.time + FEEDBACK_SEC);
    else this.stripHideAt = this.time; // fade the instruction out

    this.beatIndex++;
    if (beat.kind === 'spell') {
      this.shakeLeft = SHAKE_SEC;
      this.phase = 'free';
      this.freeIdleSec = 0;
      this.showStrip(null, t('tutorial.free.body'), this.time + FEEDBACK_SEC * 2);
      // `graduate` now marks the end of the guided part (§17.1); the free fight follows.
      this.host.config.onStep?.('graduate');
    }
  }

  /**
   * After the meteor the fight is the player's. Frames the mid-fight unlock once it reaches the hand,
   * and calls the win when the engine settles — on any settlement: the base floor clamp runs after the
   * engine's tick, so a big leak could in principle end the run as an engine loss, which the tutorial
   * never is. `lastSpawnTick + FREE_SETTLE_TICKS` is the fallback should a straggler never die — it
   * counts engine ticks, which stand still while the idle prompt has the fight frozen, so only a
   * player who keeps playing can reach it.
   */
  private tickFree(state: GameState, dt: number): void {
    if (this.idleHint) {
      if (this.pendingRelease) this.endIdlePrompt();
      else this.tickPrompt(state, dt, this.idleHint, FREE_IDLE_GHOST_SEC);
      return;
    }
    if (this.victoryAt === Infinity && !this.holdingCard) {
      this.freeIdleSec += dt;
      if (this.freeIdleSec >= FREE_IDLE_PROMPT_SEC && this.time >= this.newCardUntil) {
        const hint = pickIdleHint(state);
        if (hint) { this.startIdlePrompt(state, hint); return; }
      }
    }
    const slots = state.bottomPlayer.hand.slots;
    if (!this.newCardShown) {
      if (slots.some((s) => s?.card.id === TUTORIAL_NEW_CARD)) {
        this.newCardShown = true;
        this.newCardUntil = this.time + NEW_CARD_CALLOUT_SEC;
        this.showStrip(t('tutorial.newCard.title', { name: t('card.archer.name') }), t('tutorial.newCard.body'), this.newCardUntil);
      }
    }
    if (this.time < this.newCardUntil) {
      this.slotIndex = slots.findIndex((s) => s?.card.id === TUTORIAL_NEW_CARD);
      if (this.slotIndex >= 0) drawSlotRing(this.ui.slotRing, this.layout, this.host.handSlotCenter(this.slotIndex), this.time);
      else this.ui.slotRing.visible = false;
    } else if (this.ui.slotRing.visible) {
      this.ui.slotRing.visible = false;
    }

    if (this.victoryAt === Infinity) {
      const last = this.host.config.lastSpawnTick;
      const settled = state.phase === GamePhase.GameOver
        || (last !== undefined && state.elapsedTicks >= last + FREE_SETTLE_TICKS);
      if (settled) { this.victoryAt = this.time + FINALE_PAUSE_SEC; this.host.config.onStep?.('free_won'); }
    } else if (this.time >= this.victoryAt) {
      this.victory();
    }
  }

  /** §17.7: freeze on a "play a card" prompt aimed at the enemy nearest the base; stays until a play. */
  private startIdlePrompt(state: GameState, hint: BeatSpec): void {
    this.idleHint = hint;
    this.idlePromptAt = this.time;
    this.host.config.onIdlePrompt?.({ outcome: 'shown', n: ++this.idlePrompts, tick: state.elapsedTicks });
    this.raisePrompt(state, hint);
    this.showStrip(t('tutorial.idle.title'), t('tutorial.idle.body'), Infinity);
  }

  private endIdlePrompt(): void {
    this.idleHint = null;
    this.host.config.onIdlePrompt?.({ outcome: 'resumed', n: this.idlePrompts, wait_ms: Math.round((this.time - this.idlePromptAt) * 1000) });
    this.freeIdleSec = 0;
    this.lowerPrompt();
    this.stripHideAt = this.time; // fade the prompt out
  }

  // ── Endgame ─────────────────────────────────────────────────────────────────────────────────────

  private victory(): void {
    this.phase = 'graduate';
    this.engineFrozen = true;
    this.stripHideAt = this.time;
    this.ui.skipBtn.visible = false;
    this.ui.slotRing.visible = false;
    this.host.forceVictory();
    this.graduation.start(this.time);
  }

  private leave(): void {
    if (this.phase !== 'graduate') return;
    this.phase = 'done';
    this.host.finish();
  }

  // ── Animation ───────────────────────────────────────────────────────────────────────────────────

  private showStrip(title: string | null, body: string | null, hideAt: number): void {
    drawStrip(this.ui, title, body, this.avoidRects());
    this.stripHideAt = hideAt;
  }

  private animateStrip(dt: number): void {
    if (!this.ui.strip.visible || this.time < this.stripHideAt) return;
    this.ui.strip.alpha = Math.max(0, this.ui.strip.alpha - dt / STRIP_FADE_SEC);
    if (this.ui.strip.alpha <= 0) { clearStrip(this.ui); this.ui.strip.visible = false; }
  }

  private animateBaseLabels(): void {
    if (!this.ui.baseLabels.visible) return;
    const a = 1 - (this.time - BASE_LABEL_HOLD_SEC) / BASE_LABEL_FADE_SEC;
    if (a >= 1) return;
    if (a <= 0) { this.ui.baseLabels.visible = false; return; }
    this.ui.baseLabels.alpha = a;
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

  /** Breathing frame around the guided card + the meteor target ring. */
  private animateRings(beat: BeatSpec): void {
    if (this.slotIndex >= 0) {
      drawSlotRing(this.ui.slotRing, this.layout, this.host.handSlotCenter(this.slotIndex), this.time);
    } else {
      this.ui.slotRing.visible = false;
    }
    if (beat.kind === 'spell' && this.meteorAnchor) {
      drawTargetRing(this.ui.clusterRing, this.layout, meteorAnchorCenter(this.layout, this.meteorAnchor), this.time);
    } else {
      this.ui.clusterRing.visible = false;
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
    this.ui.ghost.visible = false;
  }

  /** Ghost card glides from the guided card's hand slot to its target, holds, loops (§11.4). */
  private animateGhost(dt: number, beat: BeatSpec): void {
    if (this.slotIndex < 0) { this.ui.ghost.visible = false; return; }
    if (this.ghostSlot !== this.slotIndex || !this.ghostCard) {
      this.ghostCard = this.host.buildCardGhost(this.slotIndex);
      this.ghostSlot = this.slotIndex;
      fillGhostLayer(this.ui.ghost, this.layout, this.ghostCard);
    }
    this.ghostT = (this.ghostT + dt) % GHOST_LOOP_SEC;
    poseGhost(this.ui.ghost, this.ghostT, this.host.handSlotCenter(this.slotIndex), this.targetPoint(beat));
  }

  // ── Geometry ────────────────────────────────────────────────────────────────────────────────────

  private targetPoint(beat: BeatSpec): { x: number; y: number } {
    return beatTargetPoint(this.layout, beat, this.meteorAnchor);
  }

  private avoidRects(): Rect[] {
    const beat = this.idleHint ?? BEATS[this.beatIndex];
    if (!beat) return [this.ui.skipBtnRect];
    const card = this.slotIndex >= 0 ? this.host.handSlotCenter(this.slotIndex) : null;
    return stripAvoidRects(this.layout, this.ui.skipBtnRect, beat.kind, this.targetPoint(beat), card);
  }
}

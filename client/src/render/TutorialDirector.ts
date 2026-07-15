import * as PIXI from 'pixi.js-legacy';
import { CardType, SpellType, GameState } from '../game';
import { ILayout, Rect } from '../layout/ILayout';
import { t, type TranslationKey } from '../i18n';
import { drawHudButton, hudButtonText } from './hudButton';

/**
 * TutorialDirector — presentation-layer orchestrator for the tutorial level `ch0_tutorial` (ONBOARDING_DESIGN §3.4).
 *
 * Active only during the tutorial level. **Pure presentation layer**: reads sync state for diffing,
 * controls the engine clock (freeze/unfreeze), and controls the guidance UI.
 * Never mutates battle state (the only exception is the never-fail base floor clamp, §3.5).
 * Engine determinism, replay, and referee are unaffected.
 *
 * Three-phase flow:
 *  - Phase A — Orientation (O1–O7): engine fully frozen; tap "Next" to advance through explanations.
 *  - Phase B — Three beats: deploy unit → deploy building → cast spell. Each beat highlights the
 *    target card and target lane, freezes until the player plays the matching card type;
 *    after release the engine advances, the scripted reaction wave (level JSON's atTick) fires,
 *    and on reaching the beat's gate tick the engine freezes again for the next beat.
 *  - Phase C — Free play + graduation: unfreeze, switch draw back to random, persistent
 *    "Complete Tutorial" button → scripted victory.
 *
 * Never-fail guarantee: each reaction wave hits the same lane the player just defended;
 * zero threats while frozen; base HP is also clamped from below (host fallback).
 */

// ── Host hooks: provided by GameRenderer; the director uses these to read view geometry, delegate highlights, and control the engine — zero internal coupling. ───
export interface TutorialHost {
  readonly container: PIXI.Container;
  readonly layout: ILayout;
  /** Highlight one unit lane (blue, unit-deploy beat). */
  highlightUnitLane(col: number): void;
  /** Highlight one building slot (blue, building-deploy beat). */
  highlightBuildingLane(col: number): void;
  /** Clear all board lane highlights. */
  clearLaneHighlights(): void;
  /** Design-space center of a hand slot for the local player (used to frame the guided card). */
  handSlotCenter(index: number): { x: number; y: number };
  /** Enter phase C: switch draw policy back to random (replaces TutorialDrawPolicy). */
  switchToFreePlayDraw(): void;
  /** Graduation: trigger scripted victory for the local player. */
  forceVictory(): void;
  /** Skip tutorial: return to lobby (host is responsible for writing tutorial_done). */
  onSkip(): void;
  /**
   * Step-level analytics hook (A9-9): fired whenever the director advances to a new tutorial step, so
   * the ops step-funnel can localise *where inside the tutorial* players quit (as opposed to the
   * coarse tutorial_start/complete pair). `stepKey` matches analyticsvc's TUTORIAL_ORDERED_KEYS.
   */
  onStepChange?(stepKey: string): void;
}

type Phase = 'orientation' | 'beat' | 'freeplay' | 'done';

interface BeatSpec {
  cardId: string;
  cardType: CardType;
  col: number;
  /** After release, freeze once the engine reaches this tick (reaction wave has finished) to enter the next beat / free play. */
  gateTick: number;
  kind: 'unit' | 'building' | 'spell';
  /**
   * clear mode (spell beat): on entering this beat, unfreeze and run to this tick so the
   * setup enemy group spawns, then freeze and show the prompt
   * (enemies appear first, player clears afterward, §3.2 Beat 3). Omitted in place mode
   * (unit/building beats): place first, then reaction.
   */
  setupTick?: number;
}

// Three-beat config: lane columns match the level JSON reaction wave columns (4/7/2);
// gate/setup ticks align with atTick values (20/140/300) per §3.3.
//   Beat1 unit:     freeze@0   → deploy unit   → release → reaction@20  → gate120
//   Beat2 building: freeze@120 → deploy tower  → release → reaction@140 → gate280
//   Beat3 spell:    enter beat, run to setup320 (setup group@300~316 spawned) → freeze → cast spell → release+clear → gate360
const BEATS: BeatSpec[] = [
  { cardId: 'infantry_1', cardType: CardType.Unit,     col: 4, gateTick: 120, kind: 'unit' },
  { cardId: 'tower_1',    cardType: CardType.Building,  col: 7, gateTick: 280, kind: 'building' },
  { cardId: 'meteor_1',   cardType: CardType.Spell,     col: 2, gateTick: 360, kind: 'spell', setupTick: 320 },
];

// Beat kind → analytics step key (must match analyticsvc's TUTORIAL_ORDERED_KEYS).
const BEAT_STEP_KEY: Record<BeatSpec['kind'], string> = {
  unit: 'beat_unit',
  building: 'beat_building',
  spell: 'beat_spell',
};

const ORIENTATION_STEPS = 7; // O1–O7

// Base never falls: clamp HP to this floor when it drops below (§3.5 fallback).
const NEVER_FAIL_BASE_FLOOR = 1;

// Handwritten notebook palette (local copy to avoid cross-module coupling). Blue = player highlight.
const C_PAPER  = 0xf6efdd;
const C_DARK   = 0x2b2b2b;
const C_BLUE   = 0x4a7fc1;
const C_MID    = 0x6b6b6b;

export class TutorialDirector {
  private readonly host: TutorialHost;
  private readonly layout: ILayout;
  private readonly root: PIXI.Container;

  private phase: Phase = 'orientation';
  private orientStep = 0;
  private beatIndex = 0;
  /**
   * Whether the engine is frozen. Initially false: let the engine run the first tick
   * to deal the opening hand (emitInitialEvents inside firstStep, GameEngine §step) —
   * otherwise the orientation phase freezes immediately, the hand is empty, and Beat 1
   * has no card to play. Once elapsedTicks >= 1, freeze immediately to enter orientation.
   * The earliest wave is at atTick 20, so the deal window is safe.
   */
  engineFrozen = false;
  /** Whether the opening first tick (deal) has already been fed. */
  private primed = false;
  /** Released; waiting for the current beat's reaction wave to reach gate tick. */
  private beatReleased = false;
  /** Set after allowCardPlay matches the guided card; engine unfreezes on the next onTick. */
  private pendingRelease = false;
  /** clear mode: currently unfrozen while waiting for the setup enemy group to spawn, then freeze and show prompt at setupTick. */
  private awaitingSetup = false;

  private pulse = 0;

  // UI layers
  private dim!: PIXI.Graphics;          // semi-transparent overlay for phases A/C
  private cardPanel!: PIXI.Container;    // instruction card (title + body + button)
  private slotRing!: PIXI.Graphics;      // pulsing ring framing the guided hand card
  private clusterRing!: PIXI.Graphics;   // spell beat: pulsing ring at enemy cluster position
  private nextBtnRect: Rect | null = null;
  private actionBtnRect: Rect | null = null; // "Complete Tutorial"
  private skipBtnRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(host: TutorialHost) {
    this.host = host;
    this.layout = host.layout;
    this.root = new PIXI.Container();
    host.container.addChild(this.root);
    this.buildLayers();
    this.renderOrientation();
    this.emitStep('orientation_1');
  }

  private emitStep(key: string): void {
    this.host.onStepChange?.(key);
  }

  get isFinished(): boolean { return this.phase === 'done'; }

  // ── Input gating (GameRenderer.handleDown asks the director first, avoiding PIXI interactive) ─────────────
  /** Returns true when this tap is consumed by the director; GameRenderer will not process it further. */
  handleDown(x: number, y: number): boolean {
    if (this.hit(this.skipBtnRect, x, y)) { this.host.onSkip(); return true; }
    if (this.phase === 'orientation') {
      if (this.nextBtnRect && this.hit(this.nextBtnRect, x, y)) { this.advanceOrientation(); }
      return true; // orientation phase swallows all input (no board interaction needed)
    }
    if (this.phase === 'freeplay') {
      if (this.actionBtnRect && this.hit(this.actionBtnRect, x, y)) { this.graduate(); return true; }
      return false; // free play: pass through board/hand interactions
    }
    if (this.phase === 'done') return true;
    // Phase B: only consume button taps; pass everything else so the player can drag cards
    return false;
  }

  /**
   * Called by GameRenderer.commitCardPlay: only permit playing a card of the current beat's type.
   * Returns false → renderer skips engine.playCard (prevents accidental off-beat plays).
   */
  allowCardPlay(cardType: CardType, _spellType: SpellType | undefined): boolean {
    if (this.phase === 'freeplay') return true;
    if (this.phase !== 'beat') return false;
    if (this.awaitingSetup || this.beatReleased) return false; // setup in progress / already released → reject
    const beat = BEATS[this.beatIndex]!;
    if (cardType === beat.cardType) { this.pendingRelease = true; return true; }
    return false;
  }

  // ── Per-frame (called at the end of GameRenderer.update): read state, control clock, never-fail clamp, advance state machine. ──────────
  onTick(state: GameState, dt: number): void {
    // Feed one tick to deal the opening hand, then immediately freeze and enter orientation (see engineFrozen comment).
    if (!this.primed) {
      if (state.elapsedTicks >= 1) { this.primed = true; this.engineFrozen = true; }
      return;
    }

    // Never-fail: clamp base HP from below (§3.5 presentation-layer fallback).
    if (state.bottomPlayer.baseHp < NEVER_FAIL_BASE_FLOOR) {
      state.bottomPlayer.baseHp = NEVER_FAIL_BASE_FLOOR;
    }

    this.pulse += dt;
    this.setBeatSlotIndex(state);
    this.animatePulse();

    if (this.phase === 'beat') {
      const beat = BEATS[this.beatIndex]!;
      if (this.awaitingSetup) {
        // clear mode — setup in progress: enemy group has spawned (reached setupTick) → freeze so the player can now clear.
        if (state.elapsedTicks >= beat.setupTick!) {
          this.awaitingSetup = false;
          this.engineFrozen = true;
        }
      } else if (this.pendingRelease) {
        // Guided card was played → unfreeze; reaction wave / clear sequence fires immediately.
        this.pendingRelease = false;
        this.beatReleased = true;
        this.engineFrozen = false;
        this.host.clearLaneHighlights();
        this.slotRing.visible = false;
        this.clusterRing.visible = false;
        this.showBeatCollapse();
      } else if (this.beatReleased && state.elapsedTicks >= beat.gateTick) {
        // Current beat finished → enter next beat / free play.
        this.beatReleased = false;
        if (this.beatIndex + 1 < BEATS.length) {
          this.enterBeat(this.beatIndex + 1);
        } else {
          this.startFreePlay();
        }
      }
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }

  // ── Phase transitions ────────────────────────────────────────────────────────────────
  private advanceOrientation(): void {
    this.orientStep++;
    if (this.orientStep < ORIENTATION_STEPS) {
      this.renderOrientation();
      this.emitStep(`orientation_${this.orientStep + 1}`);
    } else {
      this.phase = 'beat';
      this.dim.visible = false;
      this.enterBeat(0);
    }
  }

  /** Enter beat i: in clear mode, unfreeze first to let the setup enemy group spawn; in place mode, freeze immediately and show the prompt. */
  private enterBeat(i: number): void {
    this.beatIndex = i;
    this.beatReleased = false;
    this.pendingRelease = false;
    const beat = BEATS[i]!;
    if (beat.setupTick !== undefined) {
      this.awaitingSetup = true;
      this.engineFrozen = false;  // unfreeze so the setup enemy group can spawn
    } else {
      this.awaitingSetup = false;
      this.engineFrozen = true;
    }
    this.renderBeatPrompt();
    this.emitStep(BEAT_STEP_KEY[beat.kind]);
  }

  private startFreePlay(): void {
    this.phase = 'freeplay';
    this.engineFrozen = false;
    this.host.switchToFreePlayDraw();
    this.host.clearLaneHighlights();
    this.slotRing.visible = false;
    this.clusterRing.visible = false;
    this.renderFreePlay();
    this.emitStep('freeplay');
  }

  private graduate(): void {
    this.phase = 'done';
    this.clearPanel();
    this.dim.visible = false;
    this.slotRing.visible = false;
    this.clusterRing.visible = false;
    this.host.clearLaneHighlights();
    this.host.forceVictory();
  }

  // ── Rendering ────────────────────────────────────────────────────────────────────
  private renderOrientation(): void {
    const n = this.orientStep + 1; // O1..O7
    this.dim.visible = true;
    const ls = this.layout.orientation === 'landscape';
    // O1/O2/O4/O5 have orientation-specific copy; use the landscape variant in landscape mode (title has a variant only for O5).
    const LANDSCAPE_STEPS = new Set([1, 2, 4, 5]);
    const titleKey = (ls && n === 5) ? `tutorial.o${n}.title.landscape` : `tutorial.o${n}.title`;
    const bodyKey  = (ls && LANDSCAPE_STEPS.has(n)) ? `tutorial.o${n}.body.landscape` : `tutorial.o${n}.body`;
    this.drawPanel(
      tk(titleKey),
      tk(bodyKey),
      t('tutorial.next' as TranslationKey),
      'next',
    );
  }

  private renderBeatPrompt(): void {
    const beat = BEATS[this.beatIndex]!;
    this.dim.visible = false;
    const i = this.beatIndex + 1; // 1..3
    const ls = this.layout.orientation === 'landscape';
    const bodyKey = (ls && i === 1) ? `tutorial.beat${i}.body.landscape` : `tutorial.beat${i}.body`;
    this.drawPanel(tk(`tutorial.beat${i}.title`), tk(bodyKey), null, 'beat');

    // Highlight the target lane.
    if (beat.kind === 'unit') this.host.highlightUnitLane(beat.col);
    else if (beat.kind === 'building') this.host.highlightBuildingLane(beat.col);
    else this.host.clearLaneHighlights();

    // Frame the guided card in the hand (find its current slot by id; skip the ring if not found — text fallback covers it).
    this.slotRing.visible = false;
    this.clusterRing.visible = false;
    if (beat.kind === 'spell') {
      // Spell beat: draw a pulse ring at the setup enemy cluster landing point (target lane, upper enemy side — high row = top).
      const rows = this.layout.boardRect.h / this.layout.cellSize;
      const p = this.layout.gridToScreen(beat.col, Math.round(rows * 0.72));
      this.clusterRing.position.set(p.x, p.y);
      this.clusterRing.visible = true;
    }
  }

  /** "Collapse" feedback after the guided card is played: swap the body text and keep the panel briefly. */
  private showBeatCollapse(): void {
    const i = this.beatIndex + 1;
    const ls = this.layout.orientation === 'landscape';
    const doneKey = (ls && i === 1) ? `tutorial.beat${i}.done.landscape` : `tutorial.beat${i}.done`;
    this.drawPanel(tk(`tutorial.beat${i}.title`), tk(doneKey), null, 'beat');
  }

  private renderFreePlay(): void {
    this.dim.visible = false;
    this.drawPanel(
      t('tutorial.free.title' as TranslationKey),
      t('tutorial.free.body' as TranslationKey),
      t('tutorial.complete' as TranslationKey),
      'action',
    );
  }

  // ── UI construction ─────────────────────────────────────────────────────────────────
  private buildLayers(): void {
    const { designWidth: W, designHeight: H } = this.layout;

    this.dim = new PIXI.Graphics();
    this.dim.beginFill(0x000000, 0.55).drawRect(0, 0, W, H).endFill();
    this.dim.visible = false;
    this.root.addChild(this.dim);

    this.slotRing = new PIXI.Graphics();
    this.slotRing.visible = false;
    this.root.addChild(this.slotRing);

    this.clusterRing = new PIXI.Graphics();
    this.clusterRing.visible = false;
    this.root.addChild(this.clusterRing);

    this.cardPanel = new PIXI.Container();
    this.root.addChild(this.cardPanel);

    // Persistent skip button (top-right).
    this.drawSkipButton();
  }

  private drawSkipButton(): void {
    const { designWidth: W } = this.layout;
    const bw = Math.round(W * 0.18);
    const bh = Math.round(bw * 0.42);
    const bx = W - bw - Math.round(W * 0.03);
    const by = Math.round(bh * 0.6);
    this.skipBtnRect = { x: bx, y: by, w: bw, h: bh };
    const g = new PIXI.Graphics();
    drawHudButton(g, bw, bh, 'primary', { radius: bh * 0.3, fillAlpha: 0.78 });
    g.x = bx; g.y = by;
    this.root.addChild(g);
    const lbl = new PIXI.Text(t('tutorial.skip' as TranslationKey), {
      fontFamily: 'monospace', fontSize: Math.round(bh * 0.42), fill: hudButtonText('primary'),
    });
    lbl.anchor.set(0.5);
    lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    this.root.addChild(lbl);
  }

  /** Instruction card: centered at the bottom (phases B/C do not obscure the upper board), containing title + body + optional button. */
  private drawPanel(title: string, body: string, btnLabel: string | null, btnKind: 'next' | 'action' | 'beat'): void {
    this.clearPanel();
    const { designWidth: W, designHeight: H } = this.layout;
    const pw = Math.round(W * 0.86);
    const px = (W - pw) / 2;
    const hasBtn = !!btnLabel;
    const ph = Math.round(H * (hasBtn ? 0.22 : 0.15));
    // Phase B: card panel sits just above the hand area (below the board); orientation/free-play: centered toward the bottom.
    const py = this.phase === 'beat'
      ? Math.round(this.layout.handRect.y - ph - H * 0.02)
      : Math.round(H * 0.6);

    const bg = new PIXI.Graphics();
    bg.beginFill(C_PAPER, 0.97);
    bg.lineStyle(2.4, C_BLUE, 1);
    bg.drawRoundedRect(px, py, pw, ph, 12).endFill();
    this.cardPanel.addChild(bg);

    const titleLbl = new PIXI.Text(title, {
      fontFamily: 'monospace', fontSize: Math.round(ph * 0.18), fontWeight: 'bold', fill: C_DARK,
      wordWrap: true, wordWrapWidth: pw - 32,
    });
    titleLbl.x = px + 16; titleLbl.y = py + 14;
    this.cardPanel.addChild(titleLbl);

    const bodyLbl = new PIXI.Text(body, {
      fontFamily: 'monospace', fontSize: Math.round(ph * 0.13), fill: C_MID,
      wordWrap: true, wordWrapWidth: pw - 32,
    });
    bodyLbl.x = px + 16; bodyLbl.y = py + 14 + Math.round(ph * 0.26);
    this.cardPanel.addChild(bodyLbl);

    this.nextBtnRect = null;
    this.actionBtnRect = null;
    if (hasBtn) {
      const bw = Math.round(pw * 0.32);
      const bh = Math.round(ph * 0.28);
      const bx = px + pw - bw - 16;
      const by = py + ph - bh - 14;
      const btn = new PIXI.Graphics();
      drawHudButton(btn, bw, bh, 'accent', { radius: bh * 0.3 });
      btn.x = bx; btn.y = by;
      this.cardPanel.addChild(btn);
      const bl = new PIXI.Text(btnLabel!, {
        fontFamily: 'monospace', fontSize: Math.round(bh * 0.46), fontWeight: 'bold', fill: hudButtonText('accent'),
      });
      bl.anchor.set(0.5);
      bl.x = bx + bw / 2; bl.y = by + bh / 2;
      this.cardPanel.addChild(bl);
      const rect = { x: bx, y: by, w: bw, h: bh };
      if (btnKind === 'next') this.nextBtnRect = rect;
      else if (btnKind === 'action') this.actionBtnRect = rect;
    }
  }

  private clearPanel(): void {
    this.cardPanel.removeChildren().forEach((c) => c.destroy());
    this.nextBtnRect = null;
    this.actionBtnRect = null;
  }

  /** Pulse animation: breathing rings for the guided card slot and the spell enemy cluster. */
  private animatePulse(): void {
    if (this.phase !== 'beat') return;
    const beat = BEATS[this.beatIndex]!;
    const a = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(this.pulse * 5));

    // Guided card ring (locate current slot by card id).
    if (beat.kind !== 'spell' && !this.beatReleased) {
      const idx = this.lastSlotIndex;
      if (idx >= 0) {
        const c = this.host.handSlotCenter(idx);
        const w = this.layout.cardWidth + 10;
        const h = this.layout.cardHeight + 10;
        this.slotRing.clear();
        this.slotRing.lineStyle(4, C_BLUE, a);
        this.slotRing.drawRoundedRect(c.x - w / 2, c.y - h / 2, w, h, 8);
        this.slotRing.visible = true;
      } else {
        this.slotRing.visible = false;
      }
    }

    if (this.clusterRing.visible) {
      const r = this.layout.cellSize * (1.1 + 0.15 * Math.sin(this.pulse * 5));
      this.clusterRing.clear();
      this.clusterRing.lineStyle(4, C_BLUE, a);
      this.clusterRing.drawCircle(0, 0, r);
    }
  }

  /** Fed by GameRenderer before onTick with the slot index of the current guided card (diffed by id). -1 means not in hand. */
  private lastSlotIndex = -1;
  setBeatSlotIndex(state: GameState): void {
    if (this.phase !== 'beat') { this.lastSlotIndex = -1; return; }
    const beat = BEATS[this.beatIndex]!;
    this.lastSlotIndex = state.bottomPlayer.hand.slots.findIndex((s) => s?.card.id === beat.cardId);
  }

  private hit(r: Rect, x: number, y: number): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
}

/** Small helper to narrow to TranslationKey (tutorial keys are fully populated per §3.4; missing keys fall back to the key name at runtime). */
function tk(key: string): string {
  return t(key as TranslationKey);
}

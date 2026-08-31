// Event domain: dispatches per-tick GameEvents to their visual reactions (hit flashes, projectile
// sprites, escort sprites, spell VFX, the base-damage vignette flash, game-over settlement) plus the
// small sprite-pool helpers those reactions use. Independent class constructed with `core` (see
// ../GameRenderer.ts's assembly) — reaches InputPanel's cancelDrag/cancelTapSelect/drag/tapSelect
// through `this.core.input` (one-directional: input.ts never reaches back into this file).
//
// 2026-08-11: converted from the former `EventMixin(Base)` mixin chain to composition — see
// claudedocs/client-modules.md's split-form priority note.
import * as PIXI from 'pixi.js-legacy';
import { GameEvent, GameState, MatchSummary, PlayerStats, SpellType } from '../../game';
import { fromFp } from '../../game';
import { factionInk } from '../theme';
import { stateRecorder } from '../../game/replay/StateRecorder';
import { playSfx } from '../../audio/audioBus';
import type { AudioCue } from '../../audio/types';
import type { GameRendererCore } from './core';

/**
 * Spell → VFX id for the one-shot, spatially-anchored spells. Driven by the
 * single `spell_cast` event (center + owner). Haste is intentionally absent: it
 * is a per-unit `loop` buff (speed lines following each affected unit) with no
 * cast-end signal on `spell_cast`, so it is wired with the trait/buff effects
 * (aura_heal/shield/slow/summon) once a buff lifecycle event exists. The mapped
 * ids must exist in `client/src/effects/` (see vfx-editor DESIGN §5).
 *
 * Rockslide is intentionally absent: its single center VFX read as a localized poof,
 * so it is routed to BoardView.playRockslideEffect (a telegraph + full-lane cascade).
 */
const SPELL_VFX: Partial<Record<SpellType, string>> = {
  [SpellType.Meteor]:         'meteor',
  [SpellType.BridgeCollapse]: 'bridge_collapse',
};

/**
 * Ink regenerated per `sfx.ink.tick` drip.
 *
 * **Measured, not guessed.** `resource_changed` fires on every whole point of ink, and ink regen is
 * `INK_REGEN_BASE` = 2/s rising to 4/s late game — a drip per event came out at 2.6 Hz in a real
 * match (31 in 12 s, Chrome, campaign ch1_lv2), which is a machine gun, not the 背景节拍
 * `cueCatalogue` describes. 10 is one average card's worth of ink (the deck's costs run 4–12), so
 * one drip ≈ "another card is affordable": ~5 s apart early, ~2.5 s once regen accelerates.
 */
const INK_TICK_STEP = 10;

export class EventsPanel {
  /** Assigned by GameRendererCore.buildSceneGraph() — see core.ts. */
  escortLayer!: PIXI.Container;
  /** Escort sprite containers keyed by escortId (campaign escort levels only). */
  escortSprites: Map<string, PIXI.Container> = new Map();
  /** Assigned by GameRendererCore.buildSceneGraph() — see core.ts. */
  projectileLayer!: PIXI.Container;
  /** In-flight projectile sprites (arrows) keyed by projectileId. */
  projectileSprites: Map<number, PIXI.Container> = new Map();
  /** Idle projectile containers ready for reuse. */
  projectilePool: PIXI.Container[] = [];
  /** In-flight escort fade/blink ticks registered on PIXI.Ticker.shared — drained in GameRendererCore.destroy(). */
  escortEffectTicks: Set<() => void> = new Set();

  /** Assigned by GameRendererCore.buildSceneGraph() — see core.ts. */
  vignetteGfx!: PIXI.Graphics;
  vignetteAlpha = 0;

  private pendingStats: [PlayerStats, PlayerStats] | null = null;
  /** Match-level summary from the game_stats event, consumed on game_over/game_draw for star scoring. */
  private pendingSummary: MatchSummary | null = null;

  /**
   * Cues collected during the current frame's event drain → how many events merged into each
   * (AUDIO_DESIGN §4's same-frame merge). A `Map`, not a `Set`: ten units landing a hit on the same
   * frame is *one* louder `sfx.unit.hit`, not ten stacked copies phasing against each other — the
   * count goes to `playSfx`, which raises the gain instead of re-triggering the voice.
   * Drained by {@link flushAudio}, called once per frame by GameRendererCore.update().
   */
  private readonly frameCues: Map<AudioCue, number> = new Map();

  /**
   * Last `resource_changed.ink` seen for the local player; `null` until the first one arrives.
   * `sfx.ink.tick` is a **rising** edge only — the engine emits `resource_changed` for spends and
   * for the opening deal as well, and neither of those is a 墨滴回涨 node (AUDIO_DESIGN §2.1).
   */
  private lastLocalInk: number | null = null;

  /** Ink regenerated since the last drip; see {@link INK_TICK_STEP}. */
  private inkSinceTick = 0;

  constructor(private readonly core: GameRendererCore) {}

  // ── Event handling ─────────────────────────────────────────────────────────

  handleEvent(event: GameEvent, _state: GameState): void {
    this.collectCue(event);
    switch (event.type) {
      case 'unit_attack_hit': {
        this.core.unitView.playHitEffect(event.targetId);
        this.core.unitView.showHpBar(event.targetId);
        // VFX at the target unit's `hit` attachment point (torso) — falls back
        // to the grid-cell centre for circle-placeholder / no-attachment units.
        const hitPos = this.core.unitView.getHitPoint(event.targetId);
        if (hitPos) {
          this.core.vfxSystem.play('hit', hitPos.x, hitPos.y, 0xffffff);
        }
        break;
      }
      case 'projectile_fired': {
        // A tower firing recoils + twangs its bowstring. `attackerId` is a building id here and a
        // unit id when an archer shoots (separate id counters, overlapping numerically), so the
        // origin cell — always the building's own cell for a building shot — is what disambiguates.
        this.core.buildingView.playFireEffect(event.attackerId, event.from.col, fromFp(event.from.y_fp));
        const pos = this.core.boardView.gridToScreen(event.from.col, fromFp(event.from.y_fp));
        const sprite = this.acquireProjectile(event.kind);
        sprite.x = pos.x;
        sprite.y = pos.y;
        this.projectileSprites.set(event.projectileId, sprite);
        this.projectileLayer.addChild(sprite);
        break;
      }
      case 'projectile_moved': {
        const sprite = this.projectileSprites.get(event.projectileId);
        if (!sprite) break;
        const pos = this.core.boardView.gridToScreen(fromFp(event.col_fp), fromFp(event.y_fp));
        // Point the arrow along its travel direction.
        const dx = pos.x - sprite.x;
        const dy = pos.y - sprite.y;
        if (dx !== 0 || dy !== 0) sprite.rotation = Math.atan2(dy, dx);
        sprite.x = pos.x;
        sprite.y = pos.y;
        break;
      }
      case 'projectile_hit':
      case 'projectile_expired': {
        const sprite = this.projectileSprites.get(event.projectileId);
        if (!sprite) break;
        this.projectileSprites.delete(event.projectileId);
        this.releaseProjectile(sprite);
        break;
      }
      case 'unit_died': {
        this.core.unitView.playDeathEffect(event.unitId);
        // Vec2_fp carries the authoritative death position
        const p = this.core.boardView.gridToScreen(event.pos.col, fromFp(event.pos.y_fp));
        this.core.vfxSystem.play('death_unit', p.x, p.y, 0x222222);
        break;
      }
      case 'building_destroyed': {
        this.core.buildingView.playDestroyEffect(event.buildingId);
        const p = this.core.boardView.gridToScreen(event.col, event.row);
        this.core.vfxSystem.play('death_building', p.x, p.y, 0x222222);
        break;
      }
      case 'spell_cast': {
        // 直线伤害 (Rockslide): custom telegraph + cascading sweep down the whole lane
        // (see BoardView.playRockslideEffect) — not driven by SPELL_VFX.
        if (event.spellType === SpellType.Rockslide) {
          this.core.boardView.playRockslideEffect(event.center.col);
          break;
        }
        const vfxId = SPELL_VFX[event.spellType];
        if (vfxId) {
          // Spell ink follows the caster's faction (us = blue / enemy = red,
          // art-direction §3.2); the data's defaultColor is only an editor placeholder.
          const color = event.owner === this.core.localOwner ? factionInk.friend : factionInk.enemy;
          const p = this.core.boardView.gridToScreen(event.center.col, fromFp(event.center.y_fp));
          this.core.vfxSystem.play(vfxId, p.x, p.y, color);
        }
        break;
      }
      case 'building_hp_changed':
        break;
      case 'base_hp_changed':
        this.core.boardView.playBaseCrackEffect(event.owner, event.hp_fp, event.maxHp_fp);
        if (event.owner === this.core.localOwner) {
          this.vignetteAlpha = 1.0;
          this.drawVignette();
        }
        break;
      case 'base_upgraded':
        // One-shot celebratory flash; the persistent tier texture is reconciled
        // separately by BoardView.setBaseUpgradeLevel each frame.
        this.core.boardView.playBaseUpgradeEffect(event.owner);
        break;
      case 'card_played':
        if (event.owner === this.core.localOwner) { this.core.input.cancelDrag(); this.core.input.cancelTapSelect(); }
        break;
      case 'card_expired':
        if (event.owner === this.core.localOwner) {
          this.core.handView.notifyCardExpired(event.handIndex);
          // The refreshed card is a different card now — drop any in-progress
          // selection/drag on this slot instead of letting the next tap commit it.
          if (this.core.input.tapSelect?.handIndex === event.handIndex) this.core.input.cancelTapSelect();
          if (this.core.input.drag?.handIndex === event.handIndex) this.core.input.cancelDrag();
        }
        break;
      case 'game_stats':
        this.pendingStats = event.stats;
        this.pendingSummary = event.summary;
        break;
      case 'game_over': {
        // Never-lose guard (§3.5): before tutorial graduation, no engine win/loss is settled — director owns the endgame.
        if (this.core.tutorial && !this.core.tutorial.isFinished) break;
        if (this.core.gameEnded) break;
        this.core.gameEnded = true;
        // Stinger lives *inside* the one-shot gate, not in collectCue(): after game over the engine's
        // step() returns early without clearing the queue, so a paused/stalled driver can hand this
        // same event back on every frame (see engine/sim/step.ts's comment). `gameEnded` is the only
        // thing that makes it fire once — a naïve trigger would machine-gun the stinger at 60 fps.
        this.cue(event.winner === this.core.localOwner ? 'sfx.result.victory' : 'sfx.result.defeat');
        stateRecorder.setWinner(event.winner ?? -1);
        this.core.input.cancelDrag(); this.core.input.cancelTapSelect();
        this.core.netStatus.clear();
        this.core.hudView.showGameOver(event.winner, this.core.localOwner);
        const s = this.pendingStats;
        const summary = this.pendingSummary ?? this.core.engine.state.snapshotSummary();
        if (s) this.core.scheduleGameEnd(() => { this.core.onGameEnd?.(event.winner, s, summary); }, 2000);
        break;
      }
      case 'game_draw': {
        if (this.core.tutorial && !this.core.tutorial.isFinished) break;
        if (this.core.gameEnded) break;
        this.core.gameEnded = true;
        // Stinger inside the one-shot gate, for the same 60 fps reason spelled out in `game_over`
        // above. `sfx.result.draw` exists precisely because neither of the other two may stand in
        // for it: a draw is its own outcome, and victory/defeat would each report the wrong one
        // (AUDIO_DESIGN.md §7 step 6 — the gap left open by steps 3 and 4).
        this.cue('sfx.result.draw');
        stateRecorder.setWinner(-1);
        this.core.input.cancelDrag(); this.core.input.cancelTapSelect();
        this.core.netStatus.clear();
        this.core.hudView.showGameOver(null, this.core.localOwner);
        const s = this.pendingStats;
        const summary = this.pendingSummary ?? this.core.engine.state.snapshotSummary();
        if (s) this.core.scheduleGameEnd(() => { this.core.onGameEnd?.(null, s, summary); }, 2000);
        break;
      }
      case 'escort_spawned': {
        const pos = this.core.boardView.gridToScreen(fromFp(event.col_fp), fromFp(event.row_fp));
        const sprite = this.buildEscortSprite(pos.x, pos.y, event.hp_fp, event.maxHp_fp);
        this.escortSprites.set(event.escortId, sprite);
        this.escortLayer.addChild(sprite);
        break;
      }
      case 'escort_moved': {
        const sprite = this.escortSprites.get(event.escortId);
        if (!sprite) break;
        const pos = this.core.boardView.gridToScreen(fromFp(event.col_fp), fromFp(event.row_fp));
        sprite.x = pos.x;
        sprite.y = pos.y;
        break;
      }
      case 'escort_hp_changed': {
        const sprite = this.escortSprites.get(event.escortId);
        if (sprite) this.setEscortHpBar(sprite, event.hp_fp, event.maxHp_fp);
        break;
      }
      case 'escort_died': {
        const sprite = this.escortSprites.get(event.escortId);
        if (!sprite) break;
        this.escortSprites.delete(event.escortId);
        let elapsed = 0;
        const tick = (): void => {
          elapsed += PIXI.Ticker.shared.deltaMS / 1000;
          sprite.alpha = Math.max(0, 1 - elapsed / 0.5);
          if (elapsed >= 0.5) {
            this.removeEscortEffectTick(tick);
            sprite.parent?.removeChild(sprite);
            sprite.destroy();
          }
        };
        this.addEscortEffectTick(tick);
        break;
      }
      case 'escort_arrived': {
        const sprite = this.escortSprites.get(event.escortId);
        if (!sprite) break;
        this.escortSprites.delete(event.escortId);
        let frames = 12;
        const tick = (): void => {
          sprite.alpha = frames % 3 === 0 ? 0.2 : 1;
          if (--frames <= 0) {
            this.removeEscortEffectTick(tick);
            sprite.parent?.removeChild(sprite);
            sprite.destroy();
          }
        };
        this.addEscortEffectTick(tick);
        break;
      }
    }
  }

  // ── Audio (AUDIO_DESIGN §6 "触发埋点") ─────────────────────────────────────

  /**
   * Map one engine event onto its cue, if it has one. Called for **every** event, ahead of the
   * visual switch — keeping the whole battle trigger table readable in one place instead of a
   * `playSfx` sprinkled through twenty visual branches (AUDIO_DESIGN §6: this file is the single
   * funnel, and the engine stays untouched — audio is presentation, never simulation).
   *
   * Nothing plays here; cues only accumulate into {@link frameCues} and go out in {@link flushAudio}.
   *
   * ⚠️ **The `gameEnded` early-return is load-bearing.** After game over the engine's `step()`
   * returns early *without* clearing `state.events` (engine/sim/step.ts explains why), so the final
   * frame's whole event batch — not just `game_over` — can be re-drained on every subsequent frame.
   * Without this line the last tick's deaths and base hits would loop at 60 fps forever. The two
   * result stingers are deliberately *not* collected here: they sit inside the `game_over` /
   * `game_draw` branches, past the one-shot gate that sets this very flag.
   */
  private collectCue(event: GameEvent): void {
    if (this.core.gameEnded) return;
    switch (event.type) {
      case 'card_played':
        // Both sides: hearing the opponent's pen hit the page is information, and it is the one
        // audible tell that an off-screen play just happened.
        this.cue('sfx.card.play');
        break;
      // `unit_attack_start` fires on the *transition* into Attacking, not once per swing, so melee
      // gets one "铅笔短戳" as it engages and then rides on `sfx.unit.hit` per landed blow.
      // A true per-swing melee event would have to be added to @nw/engine, which §6's architecture
      // red line forbids doing for audio's sake.
      // The ranged half is `projectile_fired`: every arrow loosed, by a unit or by an arrow tower.
      case 'unit_attack_start':
      case 'projectile_fired':
        this.cue('sfx.unit.attack');
        break;
      // Fires once per damaged target, so splash/piercing hits arrive as N events on one frame —
      // exactly what the merge count is for. Covers units, buildings and escorts (the base has its own).
      case 'unit_attack_hit':
        this.cue('sfx.unit.hit');
        break;
      // Both bases: taking a hit and landing one are equally load-bearing signals, and the crack VFX
      // already plays for both. Only the local player also gets the red vignette (see the visual branch).
      case 'base_hp_changed':
        this.cue('sfx.base.hit');
        break;
      case 'spell_cast':
        this.cue('sfx.spell.cast');
        break;
      // "纸团揉碎" covers everything that dies: there is no separate building/escort cue in the
      // vocabulary, and a tower collapsing in silence would read as a dropped frame.
      case 'unit_died':
      case 'building_destroyed':
      case 'escort_died':
        this.cue('sfx.unit.death');
        break;
      case 'resource_changed': {
        if (event.owner !== this.core.localOwner) break;
        const prev = this.lastLocalInk;
        this.lastLocalInk = event.ink;
        // Seed silently on the first sighting (the opening deal emits one per side); spends move the
        // baseline but never drip — only refill is a 墨滴回涨 node.
        if (prev === null || event.ink <= prev) break;
        this.inkSinceTick += event.ink - prev;
        if (this.inkSinceTick < INK_TICK_STEP) break;
        this.inkSinceTick = 0;
        this.cue('sfx.ink.tick');
        break;
      }
    }
  }

  /** Merge one occurrence of `cue` into this frame's batch. */
  private cue(cue: AudioCue): void {
    this.frameCues.set(cue, (this.frameCues.get(cue) ?? 0) + 1);
  }

  /**
   * Play everything collected this frame and reset the batch. Called once per frame by
   * GameRendererCore.update(), right after the `state.events` drain — the merge in {@link frameCues}
   * is only meaningful across a whole frame, so it cannot live inside `handleEvent`.
   */
  flushAudio(): void {
    if (this.frameCues.size === 0) return;
    for (const [cue, count] of this.frameCues) playSfx(cue, count);
    this.frameCues.clear();
  }

  /**
   * Scripted (non-engine) settlement stinger — tutorial graduation, which never emits a real
   * `game_over` (see GameRendererCore.forceTutorialVictory). Kept here rather than calling `playSfx`
   * from core.ts so every audio decision in the battle scene stays in this one file. Callers own the
   * one-shot guarantee; `forceTutorialVictory` has its own `gameEnded` gate.
   */
  playResultStinger(winner: number): void {
    this.cue(winner === this.core.localOwner ? 'sfx.result.victory' : 'sfx.result.defeat');
    this.flushAudio();
  }

  /** Register an escort fade/blink tick on the shared ticker, tracked for destroy()-time cleanup. */
  private addEscortEffectTick(tick: () => void): void {
    this.escortEffectTicks.add(tick);
    PIXI.Ticker.shared.add(tick);
  }

  /** Unregister an escort fade/blink tick (called on natural completion, and from destroy()). */
  private removeEscortEffectTick(tick: () => void): void {
    PIXI.Ticker.shared.remove(tick);
    this.escortEffectTicks.delete(tick);
  }

  /**
   * Return a projectile container from the pool (or create one). The arrow is
   * drawn along +x; callers rotate it to the travel direction each move event.
   * `kind` is reserved for future looks (e.g. magic bolt); only 'arrow' today.
   */
  private acquireProjectile(_kind: string): PIXI.Container {
    const c = this.projectilePool.pop();
    if (c) {
      c.rotation = 0;
      c.alpha    = 1;
      return c;
    }
    const container = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.lineStyle(2, 0x2b2b2b, 1);
    g.moveTo(-7, 0);
    g.lineTo(5, 0);
    g.moveTo(5, 0);
    g.lineTo(1, -3);
    g.moveTo(5, 0);
    g.lineTo(1, 3);
    container.addChild(g);
    return container;
  }

  private releaseProjectile(sprite: PIXI.Container): void {
    sprite.removeFromParent();
    sprite.rotation = 0;
    sprite.alpha    = 1;
    this.projectilePool.push(sprite);
  }

  private buildEscortSprite(x: number, y: number, hp: number, maxHp: number): PIXI.Container {
    const c = new PIXI.Container();

    const gfx = new PIXI.Graphics();
    gfx.lineStyle(1.5, 0x226622);
    gfx.beginFill(0x44bb66, 0.85);
    gfx.drawPolygon([-9, 0, 0, -11, 9, 0, 0, 11]);
    gfx.endFill();
    gfx.name = 'body';

    const hpBg = new PIXI.Graphics();
    hpBg.beginFill(0x888888, 0.6);
    hpBg.drawRect(-10, -22, 20, 3);
    hpBg.endFill();
    hpBg.name = 'hpBg';

    const hpFill = new PIXI.Graphics();
    hpFill.name = 'hpFill';

    c.addChild(gfx, hpBg, hpFill);
    c.x = x;
    c.y = y;
    this.setEscortHpBar(c, hp, maxHp);
    return c;
  }

  private setEscortHpBar(sprite: PIXI.Container, hp: number, maxHp: number): void {
    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics | null;
    if (!hpFill) return;
    hpFill.clear();
    const ratio = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
    hpFill.beginFill(ratio > 0.4 ? 0x44cc66 : 0xff8833);
    hpFill.drawRect(-10, -22, 20 * ratio, 3);
    hpFill.endFill();
  }

  // ── Screen-edge vignette flash (base damage feedback) ─────────────────────

  drawVignette(): void {
    const g = this.vignetteGfx;
    g.clear();
    if (this.vignetteAlpha <= 0) return;

    const W = this.core.layout.designWidth;
    const H = this.core.layout.designHeight;
    const color = 0xcc0000;

    // Simulate radial vignette with 4 layered border strips.
    // Each layer is thinner and more opaque, stacking toward the screen edge.
    const N = 12;
    const maxW     = 140;
    const maxAlpha = 0.09;

    g.alpha = this.vignetteAlpha;
    for (let i = 0; i < N; i++) {
      // t=0 → innermost (narrow, faint); t=1 → outermost (wide, opaque)
      const t     = (N - 1 - i) / (N - 1);
      const w     = Math.round(maxW * (t * 0.7 + 0.3)); // range: 0.3–1.0 × maxW
      const alpha = maxAlpha * (t * 0.6 + 0.1);         // range: 0.1–0.7 × maxAlpha
      g.beginFill(color, alpha);
      g.drawRect(0,     0,     W, w);
      g.drawRect(0,     H - w, W, w);
      g.drawRect(0,     0,     w, H);
      g.drawRect(W - w, 0,     w, H);
      g.endFill();
    }
  }
}

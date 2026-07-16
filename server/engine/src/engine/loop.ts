// Core tick/step loop — the orchestrator that drives every other domain each frame. Applied
// last in the chain (see ../GameEngine.ts) so it can call into Commands/Campaign/WinCondition/
// Helpers, all of which are already mixed into `Base` by that point.
import {
  BOTTOM_BUILDING_ROW,
  CARD_REFRESH_INITIAL_OFFSET_MAX,
  CARD_REFRESH_TICKS,
  HAND_SIZE,
  TOP_BUILDING_ROW,
} from '../config';
import { toFp, TICK_RATE } from '../math/fixed';
import { cardRefreshDuration } from '../Card';
import type { Constructor, GameEngineBaseCtor } from './base';
import type { HelpersHandlers } from './helpers';
import type { CampaignHandlers } from './campaign';
import type { CommandsHandlers } from './commands';
import type { WinConditionHandlers } from './winCondition';
import {
  GameEvent,
  GamePhase,
  OwnerId,
  PlayerCommand,
  Side,
  sideToOwner,
} from '../types';

/**
 * Max wall-clock the accumulator may bank, in *catch-up* ticks. Bounds how
 * much real time one tick() call may convert to sim steps, so a long pause
 * (backgrounded tab, GC hitch, or a resolved lockstep stall) can't bank an
 * unbounded burst. At catch-up speed N this still permits N× this many sim
 * steps in a single tick() — that is the intended fast-forward.
 */
const MAX_CATCHUP_TICKS = 5;

/**
 * Backlog (in sim ticks, *beyond* the jitter buffer) above which we catch up at
 * 3×. Without this floor the ladder below only starts draining at
 * 1 s of backlog, so any hitch that banks less than a second (a brief tab
 * background, a GC pause, a bunched-up batch delivery) leaves playback stuck
 * that far behind the server *for the rest of the match* — the metronome runs
 * at the same rate we do, so a sub-second lead neither grows nor shrinks at 1×.
 *
 * `confirmedLead` already subtracts `bufferFrames` (the 100 ms jitter cushion,
 * which is the hard minimum lag — playback can never be closer than that to the
 * server), so any positive lead is real backlog *past* that cushion. 3 ≈ one
 * 100 ms batch: it drains accumulated backlog back to essentially just the
 * cushion (~0.1 s total lag) while staying above normal single-batch delivery
 * (a batch lands 3 frames at once, so lead peaks at 3 and falls back to 0 at 1×)
 * — so steady 1× playback never trips the catch-up, but a bunched double-batch
 * (lead 6) is drained promptly. Do NOT lower below one batch: catching up on
 * every normal batch would fight the metronome and reintroduce micro-stutter.
 */
const CATCHUP_MIN_LEAD = 3;

type LoopDeps = HelpersHandlers & CampaignHandlers & CommandsHandlers & WinConditionHandlers;

/** See helpers.ts HelpersHandlers doc comment for why this is exported. */
export interface LoopHandlers {
  tick(dt: number): void;
  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[];
}

export function LoopMixin<TBase extends GameEngineBaseCtor & Constructor<LoopDeps>>(
  Base: TBase,
): TBase & Constructor<LoopHandlers> {
  return class extends Base {
    /**
     * Catch-up speed multiplier (sim ticks per wall-clock tick) based on how far
     * the confirmed watermark has outrun our playback head. A client that paused
     * (minimized tab → rAF halts) or stalled keeps receiving frame_batches, so on
     * resume the backlog can be huge; draining it at 1× would never sync. Speed up
     * aggressively with the backlog so we converge fast, then settle back to 1×.
     * Latency here is not cosmetic: while playback lags, a placed card isn't shown
     * (or resolved) in real time, which can lose the match — so we favour catching
     * up hard over a smooth speed ramp.
     *
     *   backlog > 3 s → 10×   |   > 1 s → 5×   |   > ~0.1 s → 3×   |   else 1×
     *
     * The 3× floor (see {@link CATCHUP_MIN_LEAD}) is what keeps sub-second backlog
     * from becoming a permanent offset: without it the metronome runs at our rate
     * so a sub-second lead never shrinks. It drains back to essentially just the
     * 100 ms jitter buffer so a placed card shows up ~0.1 s later, not ~1.1 s.
     *
     * Only re-times step() calls — never changes which frames run or their order,
     * so lockstep determinism is unaffected.
     */
    private catchUpSpeed(): number {
      const lead = this.input.confirmedLead?.(this.currentTick) ?? 0;
      if (lead > 3 * TICK_RATE) return 10;
      if (lead > 1 * TICK_RATE) return 5;
      if (lead > CATCHUP_MIN_LEAD) return 3;
      return 1;
    }

    tick(dt: number): void {
      const tickDt = 1 / TICK_RATE;
      this.accumulatedTime += dt;

      // When playback has fallen behind the confirmed watermark, spend each banked
      // millisecond on more than one sim step so we catch up to the server.
      const speed = this.catchUpSpeed();
      const stepDt = tickDt / speed;

      // Cap banked time — prevents post-pause bursts and the spiral-of-death. The
      // bound is on real time (MAX_CATCHUP_TICKS at 1×); at speed N this still
      // allows N× as many sim steps to drain, which is the catch-up we want.
      const maxAccum = tickDt * MAX_CATCHUP_TICKS;
      if (this.accumulatedTime > maxAccum) this.accumulatedTime = maxAccum;

      // Collect every sim step's events into a per-frame union. The renderer
      // consumes state.events once per render frame, but step() clears + rebuilds
      // the queue each step — so without this a catch-up frame (≥2 steps) would
      // drop all but the last step's events (losing terminal projectile_hit/
      // expired → leaked arrow sprites), and a 0-step frame (render runs faster
      // than TICK_RATE) would re-consume the previous step's events (duplicate
      // projectile_fired → orphaned sprites). We assemble the union here and write
      // it back at the end so state.events means "events produced this frame".
      const frameEvents: GameEvent[] = [];
      while (this.accumulatedTime >= stepDt) {
        // Pull the confirmed command set for this frame from the input pipeline.
        // LocalInputSource never stalls; a net source returns null when the frame
        // is not yet confirmed, in which case we stop advancing (S1-7 buffering).
        const cmds = this.input.take(this.currentTick);
        if (cmds === null) {
          // Lockstep stall: the next frame isn't confirmed yet. Drop banked time
          // back to a single step so that when the frame lands we resume at the
          // natural cadence rather than replaying the whole buffered batch in one
          // render frame — that burst-then-idle is exactly the choppy,
          // 10 Hz-looking stutter. Re-times step() calls only; never changes which
          // frames run or their order, so determinism is unaffected.
          if (this.accumulatedTime > stepDt) this.accumulatedTime = stepDt;
          break;
        }
        this.accumulatedTime -= stepDt;
        const stepEvents = this.step(this.currentTick++, cmds);
        if (stepEvents.length) frameEvents.push(...stepEvents);
      }
      // Always overwrite — on a 0-step frame this clears stale events so the
      // renderer doesn't re-process them.
      this.state.setEvents(frameEvents);
    }

    // ─── IGameEngine ─────────────────────────────────────────────────────────

    /**
     * step() execution order:
     *   1. Emit initial events (first call only)
     *   2. AI commands + filtered external commands
     *   3. Process all commands (play_card / upgrade_base)
     *   4. Resources (coin regen)
     *   5. Building production (barracks spawn)
     *   6. Combat (attack, damage, deaths)
     *   7. Movement (advance positions)
     *   8. Spells (duration countdown, expiry)
     *   9. Hand refresh timers
     *  10. Building survival stats
     *  11. Win condition check
     */
    step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[] {
      // After game over, step returns early without clearing the event queue: if we cleared it,
      // game_over would remain in state.events and be re-consumed by the render layer every frame
      // (the root cause of duplicate settlement / double-fire analytics bugs). We do NOT clear here —
      // in a catch-up scenario with multiple steps/frames, clearing within the same tick would cause
      // the render layer to miss game_over. The GameRenderer's gameEnded one-shot gate handles it instead.
      if (this.state.phase === GamePhase.GameOver) return [];

      if (this.state.phase === GamePhase.Idle) {
        this.state.phase = GamePhase.Playing;
      }

      this.state.clearEvents();
      this.state.elapsedTicks++;

      if (this.firstStep) {
        this.firstStep = false;
        this.emitInitialEvents();
      }

      // ── Commands ──────────────────────────────────────────────────────────
      // `commands` is the player's confirmed set for this tick, pulled from the
      // InputSource (M13). AI (practice) and WaveDirector (PvE) are the engine's
      // *other* in-tick input sources, generated deterministically from state.
      const externalCmds = commands.filter((c) => c.tick === tick);
      if (this.waveDirector) {
        // PvE-shaped (campaign / siege): process player commands, then spawn the
        // scripted enemy waves directly (bypassing the enemy hand/coin economy).
        for (const cmd of externalCmds) {
          this.processCommand(cmd);
        }
        for (const spawn of this.waveDirector.tick(tick)) {
          this.spawnEnemyUnit(spawn.unitType, spawn.col, spawn.isBoss, spawn.crossWaypoints);
        }
      } else if (this.mode === 'netplay') {
        // Online lockstep PvP (S1-7): both sides are humans. `commands` is the
        // server-confirmed set for this frame (already containing BOTH sides'
        // commands, decoded from frame_batch). No local AI runs — the confirmed
        // stream is the *only* input, which is exactly what keeps two clients on
        // the same seed + same stream byte-identical.
        for (const cmd of externalCmds) {
          this.processCommand(cmd);
        }
      } else {
        // PvP: identical ordering to the original — decideTick is evaluated
        // before player commands are processed, then both are processed in turn.
        const aiCmds = this.ai.decideTick(tick, this.state);
        const allCmds = [...externalCmds, ...aiCmds];
        for (const cmd of allCmds) {
          this.processCommand(cmd);
        }
      }

      // ── Systems ───────────────────────────────────────────────────────────
      this.resource.tick(this.state);
      this.production.tick(this.state);
      this.trait.tick(this.state);
      this.combat.tick(this.state);
      this.escort.tick(this.state);
      this.hazard.tick(this.state);
      this.movement.tick(this.state);
      this.spell.tick(this.state);

      // Expire BridgeCollapse column blocks.
      for (const [col, expiresAt] of this.state.tempBlockedCols) {
        if (this.state.elapsedTicks >= expiresAt) {
          this.state.tempBlockedCols.delete(col);
        }
      }

      // ── Hand refresh timers ───────────────────────────────────────────────
      this.tickHandRefresh(Side.Bottom, 0);
      this.tickHandRefresh(Side.Top, 1);

      // ── Building survival stats ───────────────────────────────────────────
      this.accumulateBuildingSurvival();

      this.checkWinCondition();

      return this.state.events;
    }

    // ─── Initial state events ─────────────────────────────────────────────────

    /**
     * Draw 6 cards per player with staggered timers, emit card_drawn + resource_changed.
     * Called once before the first tick's logic runs.
     */
    private emitInitialEvents(): void {
      for (const side of [Side.Bottom, Side.Top] as const) {
        const player = this.state.getPlayer(side);
        const owner  = sideToOwner(side);

        let slotIdx = 0;

        // Force-inject level-specific spell cards into the first hand slots.
        if (side === Side.Bottom && this.initialSpellCards.length > 0) {
          for (const card of this.initialSpellCards) {
            if (slotIdx >= HAND_SIZE) break;
            const stagger  = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
            const duration = cardRefreshDuration(stagger);
            player.hand.drawIntoSlot(slotIdx, card, duration);
            this.state.pushEvent({
              type:                'card_drawn',
              owner,
              cardType:            card.cardType,
              handIndex:           slotIdx,
              refreshDurationTicks: duration,
            });
            slotIdx++;
          }
        }

        // Fill remaining slots from the normal draw policy.
        for (let i = slotIdx; i < HAND_SIZE; i++) {
          const stagger  = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
          const duration = cardRefreshDuration(stagger);
          const card     = player.drawPolicy.draw();
          player.hand.drawIntoSlot(i, card, duration);
          this.state.pushEvent({
            type:                'card_drawn',
            owner,
            cardType:            card.cardType,
            handIndex:           i,
            refreshDurationTicks: duration,
          });
        }
        this.state.pushEvent({ type: 'resource_changed', owner, ink: player.ink });
      }

      // Emit spawn events for all escort units placed at level start.
      for (const escort of this.state.escorts) {
        this.state.pushEvent({
          type:    'escort_spawned',
          escortId: escort.id,
          col_fp:   escort.col_fp,
          row_fp:   escort.row_fp,
          hp:       escort.hp,
          maxHp:    escort.maxHp,
        });
      }

      // SLG defense config (U10): emit spawn events for pre-placed garrison units.
      for (const unit of this.garrisonUnits) {
        this.state.pushEvent({
          type:      'unit_spawned',
          unitId:    unit.id,
          owner:     1,
          unitType:  unit.unitType,
          col:       unit.col,
          y_fp:      unit.y_fp,
          radius_fp: unit.radius_fp,
        });
        this.state.pushEvent({
          type:     'unit_move_start',
          unitId:   unit.id,
          from:     { col: unit.col, y_fp: unit.y_fp },
          to:       { col: unit.col, y_fp: toFp(BOTTOM_BUILDING_ROW) },
          speed_fp: unit.speed_fp,
        });
      }

      // SLG siege battle (G3, §16): emit spawn + move events for the attacker's
      // pre-deployed army (owner 0 / Bottom). Mirror of the garrison block — these
      // advance toward the defender base (TOP_BUILDING_ROW) on the first tick.
      for (const unit of this.attackerArmyUnits) {
        this.state.pushEvent({
          type:      'unit_spawned',
          unitId:    unit.id,
          owner:     0,
          unitType:  unit.unitType,
          col:       unit.col,
          y_fp:      unit.y_fp,
          radius_fp: unit.radius_fp,
        });
        this.state.pushEvent({
          type:     'unit_move_start',
          unitId:   unit.id,
          from:     { col: unit.col, y_fp: unit.y_fp },
          to:       { col: unit.col, y_fp: toFp(TOP_BUILDING_ROW) },
          speed_fp: unit.speed_fp,
        });
      }

      // SLG defense config (U10): emit placed events for pre-placed defender buildings.
      for (const building of this.defenderBuildingList) {
        this.state.pushEvent({
          type:         'building_placed',
          buildingId:   building.id,
          owner:        1,
          buildingType: building.buildingType,
          col:          building.col,
          row:          building.row,
        });
      }
    }

    // ─── Hand refresh timer tick ──────────────────────────────────────────────

    private tickHandRefresh(side: Side, owner: OwnerId): void {
      const player  = this.state.getPlayer(side);
      const expired = player.hand.tickTimers();

      for (const slotIndex of expired) {
        this.state.pushEvent({ type: 'card_expired', owner, handIndex: slotIndex });
        this.drawIntoSlot(player, owner, slotIndex, CARD_REFRESH_TICKS);
      }
    }
  };
}

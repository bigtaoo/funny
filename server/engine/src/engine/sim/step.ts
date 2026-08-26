// Core tick/step orchestrator — free-function form of the old LoopMixin.step() (see
// claudedocs/server.md "engine/GameEngine"). Pure function of (ctx, tick, commands): no
// wall-clock, no InputSource, no catch-up speed — that lives in driver/realtimeDriver.ts,
// which calls this once per sim step it decides to run.
import {
  BOTTOM_BUILDING_ROW,
  CARD_REFRESH_INITIAL_OFFSET_MAX,
  HAND_SIZE,
  TOP_BUILDING_ROW,
} from '../../config';
import { toFp } from '../../math/fixed';
import { cardRefreshDuration } from '../../Card';
import {
  GameEvent,
  GamePhase,
  PlayerCommand,
  Side,
  sideToOwner,
} from '../../types';
import type { EngineCtx } from '../ctx';
import { spawnEnemyUnit } from './campaign';
import { processCommand } from './commands';
import { tickHandRefresh } from './hand';
import { accumulateBuildingSurvival } from './stats';
import { checkWinCondition } from './winCondition';

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
export function stepEngine(ctx: EngineCtx, tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[] {
  const { state, systems, mode, waveDirector } = ctx;

  // After game over, step returns early without clearing the event queue: if we cleared it,
  // game_over would remain in state.events and be re-consumed by the render layer every frame
  // (the root cause of duplicate settlement / double-fire analytics bugs). We do NOT clear here —
  // in a catch-up scenario with multiple steps/frames, clearing within the same tick would cause
  // the render layer to miss game_over. The GameRenderer's gameEnded one-shot gate handles it instead.
  if (state.phase === GamePhase.GameOver) return [];

  if (state.phase === GamePhase.Idle) {
    state.phase = GamePhase.Playing;
  }

  state.clearEvents();
  state.elapsedTicks++;

  if (state.firstStep) {
    state.firstStep = false;
    emitInitialEvents(ctx);
  }

  // ── Commands ──────────────────────────────────────────────────────────
  // `commands` is the player's confirmed set for this tick, pulled from the
  // InputSource (M13). AI (practice) and WaveDirector (PvE) are the engine's
  // *other* in-tick input sources, generated deterministically from state.
  const externalCmds = commands.filter((c) => c.tick === tick);
  if (waveDirector) {
    // PvE-shaped (campaign / siege): process player commands, then spawn the
    // scripted enemy waves directly (bypassing the enemy hand/coin economy).
    for (const cmd of externalCmds) {
      processCommand(ctx, cmd);
    }
    for (const spawn of waveDirector.tick(tick)) {
      spawnEnemyUnit(ctx, spawn.unitType, spawn.col, spawn.isBoss, spawn.crossWaypoints);
    }
  } else if (mode === 'netplay') {
    // Online lockstep PvP (S1-7): both sides are humans. `commands` is the server-
    // confirmed set for this frame (already containing BOTH sides' commands, decoded
    // from frame_batch). No local AI runs — the confirmed stream is the *only* input,
    // which is exactly what keeps two clients on the same seed + same stream
    // byte-identical.
    for (const cmd of externalCmds) {
      processCommand(ctx, cmd);
    }
  } else {
    // PvP: identical ordering to the original — decideTick is evaluated before player
    // commands are processed, then both are processed in turn.
    const aiCmds = systems.ai.decideTick(tick, state);
    const allCmds = [...externalCmds, ...aiCmds];
    for (const cmd of allCmds) {
      processCommand(ctx, cmd);
    }
  }

  // ── Systems ───────────────────────────────────────────────────────────
  systems.resource.tick(state);
  systems.production.tick(state);
  systems.trait.tick(state);
  systems.combat.tick(state);
  systems.escort.tick(state);
  systems.hazard.tick(state);
  systems.movement.tick(state);
  systems.spell.tick(state);

  // Expire BridgeCollapse column blocks.
  for (const [col, expiresAt] of state.tempBlockedCols) {
    if (state.elapsedTicks >= expiresAt) {
      state.tempBlockedCols.delete(col);
    }
  }

  // ── Hand refresh timers ───────────────────────────────────────────────
  tickHandRefresh(state, Side.Bottom, 0);
  tickHandRefresh(state, Side.Top, 1);

  // ── Building survival stats ───────────────────────────────────────────
  accumulateBuildingSurvival(state);

  checkWinCondition(ctx);

  return state.events;
}

// ─── Initial state events ─────────────────────────────────────────────────

/**
 * Draw 6 cards per player with staggered timers, emit card_drawn + resource_changed.
 * Called once before the first tick's logic runs.
 */
function emitInitialEvents(ctx: EngineCtx): void {
  const { state, initialSpellCards, garrisonUnits, attackerArmyUnits, defenderBuildingList } = ctx;

  for (const side of [Side.Bottom, Side.Top] as const) {
    const player = state.getPlayer(side);
    const owner  = sideToOwner(side);

    let slotIdx = 0;

    // Force-inject level-specific spell cards into the first hand slots.
    if (side === Side.Bottom && initialSpellCards.length > 0) {
      for (const card of initialSpellCards) {
        if (slotIdx >= HAND_SIZE) break;
        const stagger  = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
        const duration = cardRefreshDuration(stagger);
        player.hand.drawIntoSlot(slotIdx, card, duration);
        state.pushEvent({
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
      state.pushEvent({
        type:                'card_drawn',
        owner,
        cardType:            card.cardType,
        handIndex:           i,
        refreshDurationTicks: duration,
      });
    }
    state.pushEvent({ type: 'resource_changed', owner, ink: player.ink });
  }

  // Emit spawn events for all escort units placed at level start.
  for (const escort of state.escorts) {
    state.pushEvent({
      type:    'escort_spawned',
      escortId: escort.id,
      col_fp:   escort.col_fp,
      row_fp:   escort.row_fp,
      hp_fp:    escort.hp_fp,
      maxHp_fp: escort.maxHp_fp,
    });
  }

  // SLG defense config (U10): emit spawn events for pre-placed garrison units.
  for (const unit of garrisonUnits) {
    state.pushEvent({
      type:      'unit_spawned',
      unitId:    unit.id,
      owner:     1,
      unitType:  unit.unitType,
      col:       unit.col,
      y_fp:      unit.y_fp,
      radius_fp: unit.radius_fp,
    });
    state.pushEvent({
      type:     'unit_move_start',
      unitId:   unit.id,
      from:     { col: unit.col, y_fp: unit.y_fp },
      to:       { col: unit.col, y_fp: toFp(BOTTOM_BUILDING_ROW) },
      speed_fp: unit.speed_fp,
    });
  }

  // SLG siege battle (G3, §16): emit spawn + move events for the attacker's pre-deployed
  // army (owner 0 / Bottom). Mirror of the garrison block — these advance toward the
  // defender base (TOP_BUILDING_ROW) on the first tick.
  for (const unit of attackerArmyUnits) {
    state.pushEvent({
      type:      'unit_spawned',
      unitId:    unit.id,
      owner:     0,
      unitType:  unit.unitType,
      col:       unit.col,
      y_fp:      unit.y_fp,
      radius_fp: unit.radius_fp,
    });
    state.pushEvent({
      type:     'unit_move_start',
      unitId:   unit.id,
      from:     { col: unit.col, y_fp: unit.y_fp },
      to:       { col: unit.col, y_fp: toFp(TOP_BUILDING_ROW) },
      speed_fp: unit.speed_fp,
    });
  }

  // SLG defense config (U10): emit placed events for pre-placed defender buildings.
  for (const building of defenderBuildingList) {
    state.pushEvent({
      type:         'building_placed',
      buildingId:   building.id,
      owner:        1,
      buildingType: building.buildingType,
      col:          building.col,
      row:          building.row,
    });
  }
}


// Win/loss/draw evaluation, called once per tick from sim/step.ts — free-function form
// of the old WinConditionMixin (see claudedocs/server.md "engine/GameEngine"). The
// `survive` campaign objective calls hasLivingEnemyUnits(); `destroy_base` (SLG siege)
// calls hasLivingAttackerUnits().
import { COUNTDOWN_THRESHOLD_TICKS, FORCE_DRAW_THRESHOLD_TICKS } from '../../config';
import { GamePhase, Side } from '../../types';
import type { EngineCtx } from '../ctx';
import { hasLivingAttackerUnits, hasLivingEnemyUnits } from './campaign';

export function checkWinCondition(ctx: EngineCtx): void {
  const { state, waveDirector, level } = ctx;
  if (state.phase === GamePhase.GameOver) return;

  if (state.bottomPlayer.isDead) {
    state.phase  = GamePhase.GameOver;
    state.winner = Side.Top;
    state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
    state.pushEvent({ type: 'game_over', winner: 1 });
    return;
  }

  // ── Campaign / siege objectives ──────────────────────────────────────────
  if (waveDirector) {
    const objective = level!.objective;

    // `escort` impossible-to-complete loss: not enough living escorts remain.
    if (objective.kind === 'escort') {
      const total   = state.escorts.length;
      const arrived = state.escorts.filter(e => e.status === 'arrived').length;
      const dead    = state.escorts.filter(e => e.status === 'dead').length;
      const needed  = objective.required === 'all' ? total
                    : objective.required === 'any' ? 1
                    : objective.required as number;
      if (arrived >= needed) {
        state.phase  = GamePhase.GameOver;
        state.winner = Side.Bottom;
        state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
        state.pushEvent({ type: 'game_over', winner: 0 });
        return;
      }
      if (total - dead < needed - arrived) {
        state.phase  = GamePhase.GameOver;
        state.winner = Side.Top;
        state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
        state.pushEvent({ type: 'game_over', winner: 1 });
        return;
      }
    }

    // `leak_limit`: lose if too many enemies have reached the player's base.
    if (objective.kind === 'leak_limit' && state.enemyLeaks > objective.maxLeaks) {
      state.phase  = GamePhase.GameOver;
      state.winner = Side.Top;
      state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
      state.pushEvent({ type: 'game_over', winner: 1 });
      return;
    }

    // Wiping the enemy base always wins (siege: attacker captures the tile).
    if (state.topPlayer.isDead) {
      state.phase  = GamePhase.GameOver;
      state.winner = Side.Bottom;
      state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
      state.pushEvent({ type: 'game_over', winner: 0 });
      return;
    }

    // `destroy_base` early exit (SLG siege with a scripted `attackerArmy`): that army is a fixed,
    // one-shot force placed at setup with no hand/ink economy behind it, so once it's fully wiped the
    // attacker can never destroy the base — end immediately as a defender win instead of burning ticks
    // to battleTimeoutTicks/durationTicks. Gated on `attackerArmy` being defined: ordinary destroy_base
    // levels (PvE campaign, player-driven siege) have the Bottom player deploying units from hand over
    // time, so a momentary zero-units-on-board tick is normal, not a wipeout — hasLivingAttackerUnits()
    // must not be treated as authoritative there. Mirrors `survive`'s hasLivingEnemyUnits() early exit below.
    if (objective.kind === 'destroy_base' && level!.attackerArmy && level!.attackerArmy.length > 0 &&
        !hasLivingAttackerUnits(ctx)) {
      state.phase  = GamePhase.GameOver;
      state.winner = Side.Top;
      state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
      state.pushEvent({ type: 'game_over', winner: 1 });
      return;
    }

    // SLG siege battle (G3, §16.1): hard time limit. Reaching battleTimeoutTicks with
    // both bases still standing → the defender (Top / owner 1) wins — "timeout / mutual
    // destruction → attacker loses (defense-favored)". Both base-down cases are handled
    // above, so on arrival here both bases are alive by construction.
    if (level!.battleTimeoutTicks !== undefined &&
        state.elapsedTicks >= level!.battleTimeoutTicks) {
      state.phase  = GamePhase.GameOver;
      state.winner = Side.Top;
      state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
      state.pushEvent({ type: 'game_over', winner: 1 });
      return;
    }

    // Evaluate the win condition.
    let survived = false;
    if (objective.kind === 'timed_defense') {
      survived = state.elapsedTicks >= objective.durationTicks;
    } else if (objective.kind === 'survive') {
      survived = waveDirector.exhausted && !hasLivingEnemyUnits(ctx);
    } else if (objective.kind === 'boss') {
      // Win when all spawned boss units are dead (at least one must exist).
      if (state.bossUnitIds.size > 0) {
        const anyAlive = Array.from(state.bossUnitIds).some((id) => {
          const u = state.board.units.get(id);
          return u !== undefined && !u.isDead;
        });
        survived = !anyAlive;
      }
    }
    // `destroy_base` with durationTicks: lose if time expired before base is destroyed.
    if (objective.kind === 'destroy_base' && objective.durationTicks !== undefined &&
        state.elapsedTicks >= objective.durationTicks) {
      state.phase  = GamePhase.GameOver;
      state.winner = Side.Top;
      state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
      state.pushEvent({ type: 'game_over', winner: 1 });
      return;
    }

    // `leak_limit`: only the leak check above triggers a loss.

    if (survived) {
      state.phase  = GamePhase.GameOver;
      state.winner = Side.Bottom;
      state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
      state.pushEvent({ type: 'game_over', winner: 0 });
    }
    // Campaign skips the PvP countdown / force-draw timers.
    return;
  }

  if (state.topPlayer.isDead) {
    state.phase  = GamePhase.GameOver;
    state.winner = Side.Bottom;
    state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
    state.pushEvent({ type: 'game_over', winner: 0 });
    return;
  }

  if (state.elapsedTicks >= FORCE_DRAW_THRESHOLD_TICKS) {
    state.phase = GamePhase.GameOver;
    state.pushEvent({ type: 'game_stats', stats: state.snapshotStats(), summary: state.snapshotSummary() });
    state.pushEvent({ type: 'game_draw' });
    return;
  }

  if (
    !state.countdownStarted &&
    state.elapsedTicks >= COUNTDOWN_THRESHOLD_TICKS
  ) {
    state.countdownStarted = true;
    state.pushEvent({ type: 'game_countdown_start' });
  }
}

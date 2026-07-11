// Win/loss/draw evaluation, called once per tick from LoopMixin's step(). Applied after
// CommandsMixin (see ../GameEngine.ts); the `survive` campaign objective calls
// CampaignMixin's hasLivingEnemyUnits().
import type { Constructor, GameEngineBaseCtor } from './base';
import type { CampaignHandlers } from './campaign';
import { COUNTDOWN_THRESHOLD_TICKS, FORCE_DRAW_THRESHOLD_TICKS } from '../config';
import { GamePhase, Side } from '../types';

/** See helpers.ts HelpersHandlers doc comment for why this is exported. */
export interface WinConditionHandlers {
  checkWinCondition(): void;
}

export function WinConditionMixin<TBase extends GameEngineBaseCtor & Constructor<CampaignHandlers>>(
  Base: TBase,
): TBase & Constructor<WinConditionHandlers> {
  return class extends Base {
    checkWinCondition(): void {
      if (this.state.phase === GamePhase.GameOver) return;

      if (this.state.bottomPlayer.isDead) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Top;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
        this.state.pushEvent({ type: 'game_over', winner: 1 });
        return;
      }

      // ── Campaign / siege objectives ──────────────────────────────────────────
      if (this.waveDirector) {
        const objective = this.level!.objective;

        // `escort` impossible-to-complete loss: not enough living escorts remain.
        if (objective.kind === 'escort') {
          const total   = this.state.escorts.length;
          const arrived = this.state.escorts.filter(e => e.status === 'arrived').length;
          const dead    = this.state.escorts.filter(e => e.status === 'dead').length;
          const needed  = objective.required === 'all' ? total
                        : objective.required === 'any' ? 1
                        : objective.required as number;
          if (arrived >= needed) {
            this.state.phase  = GamePhase.GameOver;
            this.state.winner = Side.Bottom;
            this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
            this.state.pushEvent({ type: 'game_over', winner: 0 });
            return;
          }
          if (total - dead < needed - arrived) {
            this.state.phase  = GamePhase.GameOver;
            this.state.winner = Side.Top;
            this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
            this.state.pushEvent({ type: 'game_over', winner: 1 });
            return;
          }
        }

        // `leak_limit`: lose if too many enemies have reached the player's base.
        if (objective.kind === 'leak_limit' && this.state.enemyLeaks > objective.maxLeaks) {
          this.state.phase  = GamePhase.GameOver;
          this.state.winner = Side.Top;
          this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
          this.state.pushEvent({ type: 'game_over', winner: 1 });
          return;
        }

        // Wiping the enemy base always wins (siege: attacker captures the tile).
        if (this.state.topPlayer.isDead) {
          this.state.phase  = GamePhase.GameOver;
          this.state.winner = Side.Bottom;
          this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
          this.state.pushEvent({ type: 'game_over', winner: 0 });
          return;
        }

        // SLG siege battle (G3, §16.1): hard time limit. Reaching battleTimeoutTicks
        // with both bases still standing → the defender (Top / owner 1) wins —
        // "timeout / mutual destruction → attacker loses (defense-favored)". Both base-down cases are handled
        // above, so on arrival here both bases are alive by construction.
        if (this.level!.battleTimeoutTicks !== undefined &&
            this.state.elapsedTicks >= this.level!.battleTimeoutTicks) {
          this.state.phase  = GamePhase.GameOver;
          this.state.winner = Side.Top;
          this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
          this.state.pushEvent({ type: 'game_over', winner: 1 });
          return;
        }

        // Evaluate the win condition.
        let survived = false;
        if (objective.kind === 'timed_defense') {
          survived = this.state.elapsedTicks >= objective.durationTicks;
        } else if (objective.kind === 'survive') {
          survived = this.waveDirector.exhausted && !this.hasLivingEnemyUnits();
        } else if (objective.kind === 'boss') {
          // Win when all spawned boss units are dead (at least one must exist).
          if (this.state.bossUnitIds.size > 0) {
            const anyAlive = Array.from(this.state.bossUnitIds).some((id) => {
              const u = this.state.board.units.get(id);
              return u !== undefined && !u.isDead;
            });
            survived = !anyAlive;
          }
        }
        // `destroy_base` with durationTicks: lose if time expired before base is destroyed.
        if (objective.kind === 'destroy_base' && objective.durationTicks !== undefined &&
            this.state.elapsedTicks >= objective.durationTicks) {
          this.state.phase  = GamePhase.GameOver;
          this.state.winner = Side.Top;
          this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
          this.state.pushEvent({ type: 'game_over', winner: 1 });
          return;
        }

        // `leak_limit`: only the leak check above triggers a loss.

        if (survived) {
          this.state.phase  = GamePhase.GameOver;
          this.state.winner = Side.Bottom;
          this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
          this.state.pushEvent({ type: 'game_over', winner: 0 });
        }
        // Campaign skips the PvP countdown / force-draw timers.
        return;
      }

      if (this.state.topPlayer.isDead) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Bottom;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
        this.state.pushEvent({ type: 'game_over', winner: 0 });
        return;
      }

      if (this.state.elapsedTicks >= FORCE_DRAW_THRESHOLD_TICKS) {
        this.state.phase = GamePhase.GameOver;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats(), summary: this.state.snapshotSummary() });
        this.state.pushEvent({ type: 'game_draw' });
        return;
      }

      if (
        !this.state.countdownStarted &&
        this.state.elapsedTicks >= COUNTDOWN_THRESHOLD_TICKS
      ) {
        this.state.countdownStarted = true;
        this.state.pushEvent({ type: 'game_countdown_start' });
      }
    }
  };
}

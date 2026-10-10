// battleSnapshot.ts — the local player's battle at an arbitrary moment, for the analytics events that
// fire when a player leaves mid-battle (churn_signal / level_abandon, ANALYTICS_DESIGN §5.6d).
//
// A finished battle reports its numbers through match_badges; one abandoned halfway reported none,
// which left 13 of the first 30 CrazyGames ch1_lv1 attempts (2026-10-09) unreadable — nobody could
// tell a player who was losing from one who was winning and got bored. The fields mirror
// matchBadgeTelemetry's names so the two can be read side by side.
import { fromFp } from '@nw/engine/math/fixed';
import type { GameState, OwnerId } from '../../game';

export interface BattleSnapshot {
  tick: number;
  base_hp: number;
  base_hp_max: number;
  /** Own buildings standing right now. */
  buildings: number;
  ink: number;
  kills: number;
  gold_spent: number;
  units_sent: number;
  build_ticks: number;
  dmg_taken: number;
  /** Tick of the local player's first building, null while they have placed none. */
  first_build_tick: number | null;
}

/** Watches the event stream for the local player's first building — the one number the stats don't keep. */
export class FirstBuildWatch {
  tick: number | null = null;

  /** Call once per frame, after the engine has ticked (its events are the frame's events). */
  observe(state: GameState, owner: OwnerId): void {
    if (this.tick !== null) return;
    for (const e of state.events) {
      if (e.type === 'building_placed' && e.owner === owner) { this.tick = state.elapsedTicks; return; }
    }
  }
}

export function battleSnapshot(state: GameState, owner: OwnerId, firstBuildTick: number | null): BattleSnapshot {
  const me = owner === 0 ? state.bottomPlayer : state.topPlayer;
  const side = me.side;
  let buildings = 0;
  for (const b of state.board.buildings.values()) if (!b.isDead && b.side === side) buildings++;
  const s = state.stats[owner];
  return {
    tick: state.elapsedTicks,
    base_hp: Math.round(fromFp(me.baseHp_fp)),
    base_hp_max: Math.round(fromFp(me.maxBaseHp_fp)),
    buildings,
    ink: me.ink,
    kills: s.unitsKilled,
    gold_spent: s.goldSpent,
    units_sent: s.unitsSent,
    build_ticks: s.buildingSurvivalTicks,
    dmg_taken: s.damageTakenByBase,
    first_build_tick: firstBuildTick,
  };
}

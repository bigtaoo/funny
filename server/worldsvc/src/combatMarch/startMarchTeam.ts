// worldsvc march domain: startMarch's team resolution — "which army is actually marching, and may it".
//
// Split out of command.ts (2026-09-05, same 独立函数模块 form and same reason as its sibling
// startMarchValidation.ts, which came out of the same function in 2026-08-10): startMarch is one long
// method, and this block is a self-contained phase of it — everything between "the caller named a team" and
// "we know the army, the troop count, the origin, and that the team is allowed to move". It touches only
// `core`, the caller's already-loaded `pw`, and its own arguments, so it lifts out verbatim as a free
// function. No behaviour change: the same checks in the same order, throwing the same SlgError.
import {
  SlgError,
  satchelCarryCapFor,
  regenTeamStamina,
  SLG_TEAM_STAMINA_MAX,
  SLG_TEAM_STAMINA_COST,
  type MarchKind,
} from '@nw/shared';
import type { WorldCore } from '../core';
import type { ArmyEntry, PlayerWorldDoc } from '../db';
import { resolveLeaderUnitType } from '../leaderUnit';

/** What startMarch needs back from team resolution. All of it is `undefined`/false for a flat-pool march. */
export interface ResolvedMarchTeam {
  /** Army snapshot persisted onto the MarchDoc; undefined = flat-pool march (units synthesized at combat time). */
  army?: ArmyEntry[];
  /** Committed troop count. Echoed back unchanged for a flat-pool march. */
  troops: number;
  /** Frozen march-token art (MarchDoc.leaderUnitType). */
  leaderUnitType?: string;
  /** ADR-051 P3c: this order re-commands an idle field team from where it stands. */
  idleRedispatch: boolean;
  /** Origin, overridden to the team's stationed cell on an idle re-dispatch. */
  fromX: number;
  fromY: number;
  /** Team whose stamina to charge once the dispatch commits, and its regenerated balance before the charge. */
  staminaTeamId: string | null;
  staminaBefore: number;
}

/**
 * Resolve the army a march will carry, and gate whether the named team may be commanded at all.
 *
 * Siege with a team (G3-2c; occupy also since 2026-07-15 SLG_DESIGN §4.2): draw the army from the saved
 * attack formation template; committed troops = sum of troops assigned to each unit. The team can be edited
 * after departure without affecting the in-transit march (the army snapshot is persisted with MarchDoc).
 * Neither attack nor occupy nor move, or no team → flat troops, echoed straight back.
 */
export async function resolveMarchTeam(
  core: WorldCore,
  worldId: string,
  accountId: string,
  pw: PlayerWorldDoc,
  kind: MarchKind,
  troops: number,
  fromX: number,
  fromY: number,
  teamId: string | undefined,
): Promise<ResolvedMarchTeam> {
  const { cols, now } = core.deps;
  // 'move' (2026-07-23) is always team-based — "选中的部队" is a team, and a moved team parks on the tile as a
  // whole (unlike reinforce's faceless garrison), so there is no flat-pool move path.
  if (kind === 'move' && !teamId) throw new SlgError('BAD_REQUEST', 'Move requires a team');
  if (!((kind === 'attack' || kind === 'occupy' || kind === 'move') && teamId)) {
    return { troops, idleRedispatch: false, fromX, fromY, staminaTeamId: null, staminaBefore: 0 };
  }

  const team = (pw.teams ?? []).find((t) => t.id === teamId);
  if (!team || team.army.length === 0) throw new SlgError('BAD_REQUEST', 'Team does not exist or is empty');
  // Idle-team gate (2026-07-15): a team already committed to an active (non-recalled) march must not accept
  // a new order — same "out" predicate as the defender-skip check in combatSiege/arrival.ts (ADR-026 §2).
  // Marches are deleted from the collection once processed (combatMarch.ts claim-and-delete), so "marching"
  // covers transit; a won occupy/siege then hands the team off to an OccupationDoc for the hold countdown
  // (combatSiege/occupation.ts). Since 2026-07-23 a settled team can also STAY stationed on a tile (a
  // StationedDoc) — check all three so the team stays "out" end-to-end until the player recalls it.
  //
  // The attacker's save (2026-09-05, worldsvc-concurrency phase 2) rides along in the same batch. It is a
  // cross-service HTTP hop to metaserver and it used to sit alone, further down, between the busy checks and
  // the path computation — a full round trip of dead time on the common path. It is only USED on the
  // non-redispatch branch below, so an idle re-dispatch now fetches a save it discards; that is one
  // best-effort call on the minority path in exchange for removing a serialized RTT from the majority one,
  // and `getSaveFields` is already `.catch(() => null)`-guarded so a wasted call cannot fail the dispatch.
  const [busyMarch, busyHold, busyStationed, attackerSave] = await Promise.all([
    cols.marches.findOne({ worldId, ownerId: accountId, teamId, status: { $ne: 'recalled' } }),
    cols.occupations.findOne({ worldId, ownerId: accountId, teamId }),
    cols.stationed.findOne({ worldId, ownerId: accountId, teamId }),
    core.meta.getSaveFields(accountId, ['cardInv', 'equipmentInv']).catch(() => null),
  ]);
  // ADR-051 (P3c): a 停留 idle field team is NOT busy — it can be re-commanded straight from where it stands,
  // for any of attack/occupy/move (2026-08-08: attack added — user wanted parity with occupy, a
  // forward-stationed team should be usable to launch a fresh siege without a round trip home first).
  // A 驻扎 garrison stays locked (must recall first), as do marching/holding teams.
  const idleRedispatch = !!busyStationed && busyStationed.mode !== 'garrison' && (kind === 'occupy' || kind === 'move' || kind === 'attack');
  if (busyMarch || busyHold || (busyStationed && !idleRedispatch)) {
    throw new SlgError('TEAM_BUSY', 'Team is already marching, occupying, or stationed; recall it first');
  }
  // Stamina gate (2026-09-04, SLG_DESIGN §4.6): one order costs SLG_TEAM_STAMINA_COST from this team's
  // own budget, which refills on a wall clock. Checked here (before anything is written) and charged
  // once the dispatch has fully committed, at the bottom of startMarch.
  //
  // A read-then-write with no optimistic guard is safe here *because of the gate directly above*: the
  // {worldId,ownerId,teamId} partial-unique index on `marches` (plus the occupations/stationed checks)
  // admits at most one live order per team, and `startMarch` is the only spender — so there is no second
  // writer to race with on this field, unlike the shared troop pool startMarch debits later. If a second
  // spender is ever added, this needs the same `$gte`-style atomic filter the pool debit uses.
  const staminaBefore = regenTeamStamina(
    pw.teamState?.[teamId]?.stamina ?? SLG_TEAM_STAMINA_MAX,
    pw.teamState?.[teamId]?.staminaAt ?? 0,
    now(),
  );
  if (staminaBefore < SLG_TEAM_STAMINA_COST) {
    throw new SlgError(
      'TEAM_EXHAUSTED',
      `Team stamina ${staminaBefore} is below the ${SLG_TEAM_STAMINA_COST} an order costs`,
    );
  }

  if (idleRedispatch) {
    // Depart from where the team STANDS (ignore any client-supplied origin — an idle field team is not at the
    // base) and carry its STATIONED snapshot forward: army + troops reflect field-encounter losses (P2b/P3b),
    // not the roster template. Mirrors recallStationed, which likewise forwards claimed.army/claimed.troops.
    // Troops already left the pool at the original dispatch and satchel was validated then (can only shrink),
    // so no pool deduction and no satchel re-check.
    return {
      army: busyStationed!.army,
      troops: busyStationed!.troops,
      leaderUnitType: busyStationed!.leaderUnitType,
      idleRedispatch: true,
      fromX: busyStationed!.x,
      fromY: busyStationed!.y,
      staminaTeamId: teamId,
      staminaBefore,
    };
  }

  const army = team.army;
  const committed = team.army.reduce((s, e) => s + Math.max(1, Math.floor(e.initialHp ?? 0)), 0);
  const leaderUnitType = resolveLeaderUnitType(team, attackerSave?.cardInv ?? {}, attackerSave?.equipmentInv ?? {});
  // D-CITY-9: satchel gates how many troops a SINGLE team may carry per march/siege — independent of the
  // total troopCap pool (troopCapFor/drillYard). Card-army teams carry real strength in cardState.currentTroops
  // (the flat count above degenerates to card count for them, per the CC-3 note in startMarch), so sum that.
  const teamHasCardArmy = team.army.some((e) => !!e.cardInstanceId);
  const carried = teamHasCardArmy
    ? team.army.reduce((s, e) => s + (e.cardInstanceId ? (pw.cardState?.[e.cardInstanceId]?.currentTroops ?? 0) : 0), 0)
    : committed;
  const satchelCap = satchelCarryCapFor(pw.buildings);
  if (carried > satchelCap) {
    throw new SlgError('SATCHEL_CAP_EXCEEDED', `Team carries ${carried} troops, exceeds satchel cap of ${satchelCap}`);
  }
  return { army, troops: committed, leaderUnitType, idleRedispatch: false, fromX, fromY, staminaTeamId: teamId, staminaBefore };
}

// teamTroops — shared helpers for reasoning about an SLG attack team's carried strength.
//
// Since the 2026-07-17 card migration (see slg-occupy-team-only-troops memory / SLG_DESIGN §4.2),
// an attack team's committed strength lives ENTIRELY in each card's cardState.currentTroops ledger.
// The server (worldsvc city.ts setTeams/getTeams) never persists an army entry that doesn't resolve
// to an owned cardInstanceId — no raw unit-type entries reach the client, so every entry here always
// has a cardInstanceId.
//
// Several scenes (CityScene, WorldMapNet) previously each summed troops independently and drifted
// apart; they now all route through carriedTroops() here.

import { regenTeamStamina, SLG_TEAM_STAMINA_MAX, SLG_TEAM_STAMINA_COST } from '@nw/shared';
import type { TeamTemplate, CardSLGState } from '../../net/WorldApiClient';
import type { CardInstance, EquipmentInstance } from './SaveData';
import { troopCap, cardPower } from './cardDefs';
import { t } from '../../i18n';

type Army = TeamTemplate['army'];

/** Team slot cap (UI constant; the server's SIEGE_TEAM_CAP is authoritative). */
export const TEAM_CAP = 5;

/** Fixed slot id/name (v1 does not support custom naming). */
export function teamSlotId(i: number): string {
  return `t${i + 1}`;
}
export function teamSlotName(i: number): string {
  return t('world.team.slot').replace('{n}', String(i + 1));
}

/**
 * Display name for a team. `TeamTemplate.name` is persisted as '' for every team saved through the
 * formation editor (v1 has no custom-naming UI — see DefenseEditorScene/data.ts persistTeam), so callers
 * must fall back to the live-localized slot name derived from the team's `t{n}` id instead of showing a
 * blank. A non-empty `name` only survives on teams saved before that fallback landed.
 */
export function teamDisplayName(team: Pick<TeamTemplate, 'id' | 'name'>): string {
  if (team.name) return team.name;
  const m = /^t(\d+)$/.exec(team.id);
  return m ? teamSlotName(Number(m[1]) - 1) : team.id;
}

/** Troops the team actually carries into battle — sum of each card's cardState.currentTroops ledger. */
export function carriedTroops(
  army: Army | undefined,
  cardState: Record<string, CardSLGState> | undefined,
): number {
  if (!army) return 0;
  const cs = cardState ?? {};
  let total = 0;
  for (const entry of army) {
    if (entry.cardInstanceId) total += cs[entry.cardInstanceId]?.currentTroops ?? 0;
  }
  return total;
}

/**
 * Ceiling for {@link carriedTroops} — the sum of each placed card's troopCap. Pairs with carriedTroops
 * so the team lists can show `carried/cap` instead of a bare number that means nothing on its own
 * (2026-07-25); the formation editor's own readout goes through here too.
 * Cards missing from `cardInv` (stale reference) contribute 0, exactly as they do to carriedTroops.
 */
export function teamTroopCap(
  army: Army | undefined,
  cardInv: Record<string, CardInstance> | undefined,
): number {
  if (!army) return 0;
  const inv = cardInv ?? {};
  let total = 0;
  for (const entry of army) {
    const card = entry.cardInstanceId ? inv[entry.cardInstanceId] : undefined;
    if (card) total += troopCap(card);
  }
  return total;
}

/**
 * The card whose portrait represents this team (2026-07-25). Explicit pick first — the player marks a
 * leader in the formation editor and it survives any re-arranging of the grid — otherwise the strongest
 * card in the army, so a team that has never been given a leader still gets a stable, meaningful icon
 * without the player doing anything. Ties break on cardInstanceId so the icon doesn't flicker between
 * two equal cards across renders.
 */
export function teamLeaderCard(
  team: Pick<TeamTemplate, 'army' | 'leaderCardId'> | undefined,
  cardInv: Record<string, CardInstance> | undefined,
  equipmentInv: Record<string, EquipmentInstance> = {},
): CardInstance | undefined {
  if (!team) return undefined;
  const inv = cardInv ?? {};
  const explicit = team.leaderCardId ? inv[team.leaderCardId] : undefined;
  // Only honour the explicit pick while that card is actually in this team's army (the server enforces
  // the same rule on save, but a client-side team edit can be one step ahead of the round trip).
  if (explicit && team.army.some((e) => e.cardInstanceId === team.leaderCardId)) return explicit;

  let best: CardInstance | undefined;
  let bestPower = -1;
  for (const entry of team.army) {
    const card = entry.cardInstanceId ? inv[entry.cardInstanceId] : undefined;
    if (!card) continue;
    const power = cardPower(card, equipmentInv);
    if (power > bestPower || (power === bestPower && best && card.id < best.id)) {
      best = card;
      bestPower = power;
    }
  }
  return best;
}

/** One team's live stamina/injury slice as the server persists it (PlayerWorldView.teamState[id]). */
export type TeamRuntimeState = { injuredUntil?: number | null; stamina?: number; staminaAt?: number };

/**
 * Live stamina of a team (SLG_DESIGN §4.6), recomputed from the server's checkpoint pair with the SAME
 * shared function worldsvc charges against — the view carries `{stamina, staminaAt}`, not a live figure,
 * so the bar keeps ticking between responses instead of freezing until the next refetch. Same
 * raw-timestamp-plus-local-clock contract the injury countdowns already use.
 *
 * Both fields absent (a team that has never marched, or an account predating the system) reads as FULL,
 * matching the server's own default — never as 0, which would lock a player out of the world map.
 */
export function teamStamina(state: TeamRuntimeState | undefined, now: number): number {
  return regenTeamStamina(state?.stamina ?? SLG_TEAM_STAMINA_MAX, state?.staminaAt ?? 0, now);
}

/** Whether this team has enough stamina left to be given one more order. Mirrors startMarch's gate. */
export function teamCanAct(state: TeamRuntimeState | undefined, now: number): boolean {
  return teamStamina(state, now) >= SLG_TEAM_STAMINA_COST;
}

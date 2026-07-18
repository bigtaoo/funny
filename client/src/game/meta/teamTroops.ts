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

import type { TeamTemplate, CardSLGState } from '../../net/WorldApiClient';
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

// teamTroops — shared helpers for reasoning about an SLG attack team's carried strength.
//
// Post the 2026-07-17 card migration (see slg-occupy-team-only-troops memory / SLG_DESIGN §4.2),
// an attack team's committed strength lives ENTIRELY in each card's cardState.currentTroops ledger.
// Legacy teams built before the migration store raw unit entries ({unitType, initialHp}, no
// cardInstanceId); the card editor drops those on open and the server's card-army exemption never
// applies to them, so they can never actually march (they fail the flat-pool gate in
// combatMarch.ts). We therefore treat a legacy entry as carrying ZERO troops everywhere in the UI:
// a legacy team reads "0 committed", is filtered out of the occupy/attack picker, and is flagged
// for rebuild — instead of misleadingly showing its old initialHp sum as if usable.
//
// Several scenes (CityScene, WorldMapNet) previously each summed initialHp for legacy
// entries and drifted apart; they now all route through carriedTroops() here.

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

/**
 * A team is "legacy" when it has units but at least one carries no cardInstanceId — i.e. it was
 * authored with the pre-migration unit-type editor and can no longer be dispatched. Empty teams
 * are not legacy (they are just unbuilt slots).
 */
export function isLegacyTeam(army: Army | undefined): boolean {
  if (!army || army.length === 0) return false;
  return army.some((e) => !e.cardInstanceId);
}

/**
 * Troops the team actually carries into battle. Card entries draw from their cardState.currentTroops
 * ledger; legacy (non-card) entries contribute 0 — they are non-functional after the card migration.
 */
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

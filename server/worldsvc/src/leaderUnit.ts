// Leader unit-type resolution for march-token art (2026-07-26).
// Mirrors client/src/game/meta/teamTroops.ts::teamLeaderCard() so the "which card represents this team"
// rule stays identical on both sides: explicit team.leaderCardId if still present in army, else the
// strongest card by cardPower (ties broken by lowest card id, for determinism).
import { CARD_DEFS, cardPower, type CardInstance, type EquipmentInstance } from '@nw/shared';
import type { TeamTemplate } from './db';

export function resolveLeaderUnitType(
  team: Pick<TeamTemplate, 'army' | 'leaderCardId'>,
  cardInv: Record<string, CardInstance>,
  equipmentInv: Record<string, EquipmentInstance>,
): string | undefined {
  const explicit = team.leaderCardId ? cardInv[team.leaderCardId] : undefined;
  const explicitValid = explicit && team.army.some((e) => e.cardInstanceId === team.leaderCardId);
  let leader: CardInstance | undefined = explicitValid ? explicit : undefined;
  if (!leader) {
    let bestPower = -1;
    for (const entry of team.army) {
      const card = entry.cardInstanceId ? cardInv[entry.cardInstanceId] : undefined;
      if (!card) continue;
      const power = cardPower(card, equipmentInv);
      if (power > bestPower || (power === bestPower && leader && card.id < leader.id)) {
        leader = card;
        bestPower = power;
      }
    }
  }
  if (!leader) return undefined;
  return CARD_DEFS[leader.defId]?.unitType;
}

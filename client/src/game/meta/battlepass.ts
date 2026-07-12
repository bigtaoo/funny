// Client-side pure logic for the battle pass claimable-reward check (SE-9).
// Mirrors BattlePassScene's own per-cell `cellState` derivation (free/paid track, current level,
// claimed sets, pass ownership) but reduced to the single boolean the Shop/Gacha/BattlePass
// peer-tab red dots need — see LOBBY_IA_REDESIGN P1.5 §9.
import type { SaveData } from './SaveData';
import { BATTLEPASS_DEFS, xpToLevel } from '../balance/battlepassDefs';

/** Any battle pass level (free or paid-if-owned) is claimable at the current level → peer-tab red dot. */
export function hasBattlePassClaimable(bp: SaveData['battlePass'] | undefined): boolean {
  if (!bp) return false;
  const currentLevel = xpToLevel(bp.xp);
  const claimedFree = new Set(bp.claimedFree);
  const claimedPaid = new Set(bp.claimedPaid);
  return BATTLEPASS_DEFS.some((def) => {
    if (def.level > currentLevel) return false;
    if (def.free && !claimedFree.has(def.level)) return true;
    if (def.paid && bp.hasPass && !claimedPaid.has(def.level)) return true;
    return false;
  });
}

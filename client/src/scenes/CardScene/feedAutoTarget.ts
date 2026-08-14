// CardScene/feed.ts's auto-retarget/auto-continue ranking, extracted as form① (claudedocs/
// client-modules.md "单文件 500 行收敛") — pure function of its explicit arguments (no CardSceneCore
// dependency), same "no host needed" shape as ./feedList.ts's drawFuseCandidateRow.
import { CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, fusionMaterialCandidates } from '../../game/meta/cardDefs';
import type { CardInstance } from '../../game/meta/SaveData';

/**
 * Best owned card to fuse right now: unlocked, below max level, with >= FUSION_MATERIAL_COUNT
 * eligible same-faction same-level materials already on hand. The target itself MAY be deployed
 * (only materials must be free — `candidateOf` gates the material count, not the target).
 * Ranked lexicographically, most-significant first (2026-08-10, reordered from the 2026-08-02
 * version): (1) currently deployed to an SLG team, so auto-continue strengthens the active roster
 * FIRST, even across character lines — a deployed card of a different character now outranks a
 * bench copy of the character the player was already fusing (previously "same character" sat
 * above "deployed", so a deep bench of one line could hog the whole shared-faction material pool
 * before a deployed card of any other line ever got a turn — see MEMORY.md); (2) same `defId` as
 * `preferDefId` (the card the player was already fusing), so once the deployed tier is tied,
 * auto-retarget/auto-continue still keep working the same character line when another copy is
 * still fusable; (3) same faction as that card, so falling back never jumps to an unrelated
 * faction just because it happens to rank higher on some other axis (e.g. mid-fusing a Tao-faction
 * card should never auto-switch to an Anna-faction one); (4) highest level.
 */
export function findAutoTarget(
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
  requireLevel?: number,
  preferDefId?: string,
): CardInstance | null {
  const preferFaction = preferDefId ? CARD_DEFS[preferDefId]?.faction : undefined;
  const rankOf = (c: CardInstance): [number, number, number, number] => [
    candidateOf(c.id) ? 0 : 1,
    preferDefId && c.defId === preferDefId ? 1 : 0,
    preferFaction && CARD_DEFS[c.defId]?.faction === preferFaction ? 1 : 0,
    c.level,
  ];
  const isBetter = (a: readonly number[], b: readonly number[]): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let best: CardInstance | null = null;
  let bestRank: [number, number, number, number] | null = null;
  for (const c of Object.values(inv)) {
    if (c.locked || c.level >= MAX_CARD_LEVEL || !CARD_DEFS[c.defId]) continue;
    if (requireLevel !== undefined && c.level !== requireLevel) continue;
    const cnt = fusionMaterialCandidates(c, inv).filter((m) => candidateOf(m.id)).length;
    if (cnt < FUSION_MATERIAL_COUNT) continue;
    const rank = rankOf(c);
    if (!best || isBetter(rank, bestRank!)) { best = c; bestRank = rank; }
  }
  return best;
}

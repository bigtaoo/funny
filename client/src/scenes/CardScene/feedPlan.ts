// Fusion planning — the pure half of the fuse panel's "never swap the player's target" contract
// (CHARACTER_CARDS_DESIGN §3.2, redesigned 2026-08-18). Replaces feedAutoTarget.ts, whose
// findAutoTarget silently REPLACED the panel's target whenever the card the player tapped had no
// materials on hand. That swap was a patch over a structural fact — with strict same-level 5-in-1
// fusion on a 5^(L-1) curve, "not enough materials" is the NORMAL state from Lv.3 up, so the patch
// fired constantly and the player kept ending up fusing a character he never picked.
//
// The old ranking is not thrown away: it survives verbatim as listFusableTargets' sort order, but
// demoted from a decision-maker to the display order of a recommendation strip the player taps
// himself. Everything here is a pure function of its arguments (form ① per
// claudedocs/client-modules.md) — no CardSceneCore dependency, directly unit-testable.
import { CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, fusionMaterialCandidates } from '../../game/meta/cardDefs';
import type { CardInstance } from '../../game/meta/SaveData';

/**
 * Cards spent at level L to add ONE card at level L+1 to the material pool: FUSION_MATERIAL_COUNT
 * materials plus the feeder card that absorbs them. This "+1" is why prep is expensive, and why the
 * cost has to be spelled out to the player before he authorizes a round of it.
 */
export const PREP_COST_PER_CARD = FUSION_MATERIAL_COUNT + 1;

/**
 * Max nesting of prep frames (Lv.4 ← prep Lv.3 ← prep Lv.2). Deeper reads as a bottomless pit: each
 * extra level multiplies the card cost by PREP_COST_PER_CARD, so a third would routinely price a
 * single fusion in the thousands of cards — a number the 2026-07-19 fusion redesign deliberately
 * stopped showing players.
 */
export const MAX_PREP_DEPTH = 2;

/** Eligible materials for `card` that are also free to consume right now (not deployed to a team). */
export function readyMaterials(
  card: CardInstance,
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
): CardInstance[] {
  return fusionMaterialCandidates(card, inv).filter((m) => candidateOf(m.id));
}

/** True when `card` can be fused this instant — below max level, unlocked, 5 materials on hand. */
export function isFusableNow(
  card: CardInstance,
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
): boolean {
  if (card.locked || card.level >= MAX_CARD_LEVEL || !CARD_DEFS[card.defId]) return false;
  return readyMaterials(card, inv, candidateOf).length >= FUSION_MATERIAL_COUNT;
}

/**
 * Every card the player could fuse right now, best-first — the recommendation strip's contents.
 *
 * Ranking is lexicographic, most-significant first, and is the 2026-08-10 ordering carried over
 * unchanged from findAutoTarget: (1) currently deployed to an SLG team, so the strip puts the
 * active roster in front of the bench; (2) same `defId` as `preferDefId` (the card the player is
 * looking at), keeping one character's line together; (3) same faction as that card, so the strip
 * does not lead with an unrelated faction; (4) highest level. A deployed card may be a TARGET (only
 * materials must be undeployed), which is exactly why it can top this list.
 */
export function listFusableTargets(
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
  preferDefId?: string,
): CardInstance[] {
  const preferFaction = preferDefId ? CARD_DEFS[preferDefId]?.faction : undefined;
  const rankOf = (c: CardInstance): number[] => [
    candidateOf(c.id) ? 0 : 1, // deployed first (candidateOf is "free to be consumed")
    preferDefId && c.defId === preferDefId ? 1 : 0,
    preferFaction && CARD_DEFS[c.defId]?.faction === preferFaction ? 1 : 0,
    c.level,
  ];
  return Object.values(inv)
    .filter((c) => isFusableNow(c, inv, candidateOf))
    .map((c) => ({ c, rank: rankOf(c) }))
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0; // stable, id-deterministic tiebreak
    })
    .map((e) => e.c);
}

/** What one round of prep for a target would take. See {@link planPrep}. */
export interface PrepPlan {
  /** Materials still missing at the target's own level. */
  shortfall: number;
  /** Level of the cards prep would fuse UP into materials (= target.level - 1). */
  feederLevel: number;
  /** Cards at feederLevel this prep consumes in total (shortfall x PREP_COST_PER_CARD). */
  cost: number;
  /** Eligible, undeployed, unlocked cards at feederLevel the player owns right now. */
  avail: number;
  /** avail >= cost — whether feederLevel ALONE covers the run. */
  affordable: boolean;
  /**
   * When feederLevel alone falls short, what the level below would have to supply to make up the
   * difference — the "I have 4 Lv.3 and 108 Lv.2" case, which is the ordinary mid-game shape once
   * a target passes Lv.3. Null when feederLevel already covers it, or when there is no level below.
   */
  chain: { level: number; need: number; have: number } | null;
  /** affordable, or coverable through `chain` — the real "can this run happen" answer. */
  fundable: boolean;
  /**
   * Whether any card at feederLevel could actually serve as the feeder — i.e. is also gear-free
   * (see pickFeeder). Separate from `affordable` because gear disqualifies a card from being the
   * FEEDER while leaving it perfectly usable as one of that feeder's five MATERIALS, so a player
   * can own more than enough cards and still have nobody to fuse them into. Offering prep on
   * `affordable` alone produced a live button that did nothing when tapped.
   */
  hasFeeder: boolean;
}

/** Unlocked, undeployed cards of one faction at one level — the pool a prep round draws from. */
function countEligible(
  level: number,
  faction: string,
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
): number {
  return Object.values(inv).filter(
    (c) => !c.locked && c.level === level && CARD_DEFS[c.defId]?.faction === faction && candidateOf(c.id),
  ).length;
}

/**
 * Plan the "go make the materials you are missing" path for `target`, or null when there is no such
 * path: the target is already fusable, is at max level, or sits at Lv.1 (nothing below to fuse up).
 * An unfundable plan is still returned rather than suppressed — the gap state turns it into a
 * concrete number ("18 Lv.2 cards needed, you have 8") instead of a dead end with no explanation.
 */
export function planPrep(
  target: CardInstance,
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
): PrepPlan | null {
  const def = CARD_DEFS[target.defId];
  if (!def || target.level >= MAX_CARD_LEVEL) return null;
  const shortfall = FUSION_MATERIAL_COUNT - readyMaterials(target, inv, candidateOf).length;
  if (shortfall <= 0) return null;
  const feederLevel = target.level - 1;
  if (feederLevel < 1) return null;
  const avail = countEligible(feederLevel, def.faction, inv, candidateOf);
  const cost = shortfall * PREP_COST_PER_CARD;
  const affordable = avail >= cost;
  // One level further down, priced as a chain: every card still missing at feederLevel costs another
  // PREP_COST_PER_CARD below it. Only computed when needed, and only one level deep — see
  // MAX_PREP_DEPTH.
  const chainLevel = feederLevel - 1;
  const chain = affordable || chainLevel < 1 ? null : {
    level: chainLevel,
    need: (cost - avail) * PREP_COST_PER_CARD,
    have: countEligible(chainLevel, def.faction, inv, candidateOf),
  };
  // A card carrying gear can be a MATERIAL but never the feeder (pickFeeder skips it), so a player
  // can own more than enough cards at feederLevel and still have nobody to fuse them into. Without
  // this the panel offered a button that hit enterPrep's `if (!feeder) return` and did nothing.
  const hasFeeder = Object.values(inv).some(
    (c) => !c.locked && c.level === feederLevel && CARD_DEFS[c.defId]?.faction === def.faction
      && candidateOf(c.id) && !Object.values(c.gear ?? {}).some((g) => !!g),
  );
  return {
    shortfall, feederLevel, cost, avail, affordable, chain, hasFeeder,
    fundable: affordable || (!!chain && chain.have >= chain.need),
  };
}

/**
 * Pick the card to fuse UP as one unit of prep material — ranked the OPPOSITE way from
 * listFusableTargets, and that inversion is the whole point. A recommendation target is a card the
 * player wants to keep and strengthen; a feeder is a card that gets upgraded and then eaten as
 * material a moment later. Feeding the deployed main-line card into the furnace would be a
 * catastrophe, so deployed / locked / geared cards are excluded outright, and among what is left the
 * defId with the deepest stack of copies at that level goes first — prep burns redundancy rather
 * than the last surviving copy of a character, which the player may still need as an SLG bench body
 * (CC7's stated reason for raising the roster cap to 500).
 */
export function pickFeeder(
  faction: string,
  level: number,
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
  exclude: ReadonlySet<string> = new Set<string>(),
): CardInstance | null {
  const pool = Object.values(inv).filter(
    (c) => !c.locked && c.level === level && CARD_DEFS[c.defId]?.faction === faction
      && candidateOf(c.id) && !exclude.has(c.id),
  );
  const copiesOf = new Map<string, number>();
  for (const c of pool) copiesOf.set(c.defId, (copiesOf.get(c.defId) ?? 0) + 1);
  let best: CardInstance | null = null;
  let bestCopies = -1;
  for (const c of pool) {
    // A feeder must not carry gear: the server does not unequip materials, it just deletes the
    // card, so fusing a geared copy silently dismantles a loadout the player assembled.
    if (Object.values(c.gear ?? {}).some((g) => !!g)) continue;
    if (!isFusableNow(c, inv, candidateOf)) continue;
    const copies = copiesOf.get(c.defId) ?? 0;
    if (copies > bestCopies || (copies === bestCopies && best && c.id < best.id)) {
      best = c; bestCopies = copies;
    }
  }
  return best;
}

/**
 * How many prep rounds at `level` the player can still complete back-to-back — the "x N" on the
 * batch-prep button. Simulated against a scratch copy of the inventory rather than derived from
 * `avail / PREP_COST_PER_CARD`, because a feeder also has to be gear-free and hold its own five
 * materials, so the arithmetic bound is an upper limit, not the real answer.
 */
export function countPrepRounds(
  faction: string,
  level: number,
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
  limit: number,
): number {
  const sim: Record<string, CardInstance> = { ...inv };
  let rounds = 0;
  while (rounds < limit) {
    const feeder = pickFeeder(faction, level, sim, candidateOf);
    if (!feeder) break;
    const mats = readyMaterials(feeder, sim, candidateOf).slice(0, FUSION_MATERIAL_COUNT);
    if (mats.length < FUSION_MATERIAL_COUNT) break;
    for (const m of mats) delete sim[m.id];
    sim[feeder.id] = { ...feeder, level: feeder.level + 1 };
    rounds++;
  }
  return rounds;
}

/**
 * Materials to pre-load into the ring's slots, best-first. Ranked to spend the LEAST regrettable
 * copies: gear-free before geared (fusing a geared card silently dismantles its loadout), then the
 * defId with the deepest stack at this level, so the last copy of a character — potentially an SLG
 * bench body — is the last thing consumed. Fungible by the fusion rules (same faction, same level),
 * so pre-filling costs the player nothing: any slot can still be tapped to put a card back.
 */
export function autoFillMaterials(
  target: CardInstance,
  inv: Record<string, CardInstance>,
  candidateOf: (id: string) => boolean,
  n: number,
): CardInstance[] {
  const pool = readyMaterials(target, inv, candidateOf);
  const copiesOf = new Map<string, number>();
  for (const c of pool) copiesOf.set(c.defId, (copiesOf.get(c.defId) ?? 0) + 1);
  const geared = (c: CardInstance): number => (Object.values(c.gear ?? {}).some((g) => !!g) ? 1 : 0);
  return [...pool]
    .sort((a, b) => geared(a) - geared(b)
      || (copiesOf.get(b.defId) ?? 0) - (copiesOf.get(a.defId) ?? 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, n);
}

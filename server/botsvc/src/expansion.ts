// Where a bot marches next in the SLG world (BOTSVC_DESIGN §3.4): grow outward from land its sect
// already holds, one adjacent tile at a time, the way ADR-039 connectivity ("连地") requires.
//
// Pure: the caller fetches the map view and `/world/me`; this only decides. The server stays the
// authority on every rule mirrored here — the point of mirroring is that a bot stops sending marches
// worldsvc is certain to reject (until 2026-09-26 every one of them was: targets were picked up to 40
// tiles away and all failed TERRITORY_NOT_CONNECTED at departure).
import { OCCUPY_MIN_TROOPS, baseFootprintCells } from '@nw/shared';
import type { WorldTileView } from './worldClient';

/** Highest tile level a bot tries to occupy: an L1-L2 NPC garrison falls to the minimum occupy force. */
export const EXPAND_MAX_LEVEL = 2;
/**
 * Troops that must stay home after a march leaves. Survivors of an occupation stay on the tile as its
 * garrison, so every march permanently spends pool troops; training (training.ts) is what refills them.
 */
export const EXPAND_TROOP_FLOOR = 2000;
/** Smallest pool that can send anything: the floor plus the minimum force every march here uses. */
export const EXPAND_MARCH_MIN_POOL = EXPAND_TROOP_FLOOR + OCCUPY_MIN_TROOPS;
/** Share of the pool sent on an attack, before the OCCUPY_MIN_TROOPS minimum and the floor apply. */
const ATTACK_TROOP_FRACTION = 0.3;
/** Building upgrades are paid mostly in these two. */
const PREFERRED_RESOURCES: ReadonlySet<string> = new Set(['paper', 'graphite']);

export interface ExpansionPlan {
  kind: 'occupy' | 'attack';
  x: number;
  y: number;
  troops: number;
}

const key = (x: number, y: number) => `${x}:${y}`;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Held by the bot, its family, or a sibling family in its sect — what ADR-039 counts as "ours". Allied sects do not count. */
function isFriendly(t: WorldTileView): boolean {
  return !!(t.mine || t.ally || t.sectmate);
}

/**
 * The next march for a bot whose 3x3 base is anchored at `base`, or null when there is nothing worth
 * sending (no adjacent target, or too few troops to send one without dropping below the floor).
 *
 * Occupying an adjacent L1-L2 resource tile always wins over attacking. Among those: first a resource the
 * bot does not produce at all yet (`yieldRate` from `/world/me`) — training costs all five, so one missing
 * input stops it outright — then paper/graphite, then the lower level, then the tile closest to the base,
 * then coordinates so the choice is deterministic.
 * Only with no such tile left does a bot attack an adjacent enemy territory tile — never a base, a
 * stronghold, a crossing or a city.
 */
export function planExpansion(
  tiles: readonly WorldTileView[],
  base: { x: number; y: number },
  troops: number,
  now: number,
  yieldRate: Readonly<Partial<Record<string, number>>> = {},
): ExpansionPlan | null {
  const friendly = new Set<string>(baseFootprintCells(base.x, base.y).map((c) => key(c.x, c.y)));
  for (const t of tiles) if (isFriendly(t)) friendly.add(key(t.x, t.y));
  const bordersFriendly = (t: WorldTileView) => NEIGHBOURS.some(([dx, dy]) => friendly.has(key(t.x + dx, t.y + dy)));
  const dist = (t: WorldTileView) => Math.abs(t.x - base.x) + Math.abs(t.y - base.y);
  const produced = (t: WorldTileView) => (yieldRate[t.resType ?? ''] ?? 0) > 0;

  const occupyTargets = tiles
    .filter((t) =>
      t.type === 'resource'
      && !t.occupied && !isFriendly(t)
      && !((t.contestedUntil ?? 0) > now)
      && t.level <= EXPAND_MAX_LEVEL
      && !friendly.has(key(t.x, t.y))
      && bordersFriendly(t))
    .sort((a, b) =>
      Number(produced(a)) - Number(produced(b))
      || Number(!PREFERRED_RESOURCES.has(a.resType ?? '')) - Number(!PREFERRED_RESOURCES.has(b.resType ?? ''))
      || a.level - b.level
      || dist(a) - dist(b)
      || a.y - b.y
      || a.x - b.x);
  const occupy = occupyTargets[0];
  if (occupy) {
    if (troops < EXPAND_MARCH_MIN_POOL) return null;
    return { kind: 'occupy', x: occupy.x, y: occupy.y, troops: OCCUPY_MIN_TROOPS };
  }

  const attackTargets = tiles
    .filter((t) =>
      t.type === 'territory'
      && t.occupied && !isFriendly(t) && !t.allySect
      && !((t.protectedUntil ?? 0) > now)
      && bordersFriendly(t))
    .sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x);
  const attack = attackTargets[0];
  if (!attack) return null;
  // 30% of the pool, but never under the server minimum and never into the floor.
  const spare = troops - EXPAND_TROOP_FLOOR;
  if (troops < EXPAND_MARCH_MIN_POOL) return null;
  const send = Math.min(spare, Math.max(OCCUPY_MIN_TROOPS, Math.floor(troops * ATTACK_TROOP_FRACTION)));
  return { kind: 'attack', x: attack.x, y: attack.y, troops: send };
}

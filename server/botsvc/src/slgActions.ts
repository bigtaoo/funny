// SLG turn actions (BOTSVC_DESIGN §3.4): the network-calling half of tickSlg, split out of bot.ts
// (2026-09-27, checkFileLength split-priority form ① — independent function modules) once four
// feature commits on the same day pushed bot.ts past the 500-line convention for the first time.
// Pure planning stays in expansion.ts/training.ts; these wrap that planning with the WorldClient
// calls and thread the two bits of per-bot state (buildRotation, marchBusyUntil) through as plain
// values instead of `this` so the functions need no session object at all.
import { BUILD_QUEUE_SLOTS, RESOURCE_TYPES, buildCost, buildGateReason } from '@nw/shared';
import type { BuildingKey, PlayerWorldView, WorldClient } from './worldClient';
import { EXPAND_MARCH_MIN_POOL, planExpansion } from './expansion';
import { planTraining } from './training';

/** P1-buildable keys only (BuildingKey's wall/academy are P2, not yet buildable — see contracts/openapi-world.yml). */
const P1_BUILDING_KEYS: BuildingKey[] = [
  'desk',
  'inkPot',
  'paperTray',
  'graphiteMill',
  'metalForge',
  'stickerShop',
  'cabinet',
  'drillYard',
];

/**
 * Radius of the full map view the expansion planner reads, around the bot's base.
 *
 * Small on purpose: ADR-039 connectivity means every legal target borders land the sect already holds,
 * and a bot that can afford ~6 occupations (EXPAND_TROOP_FLOOR) never grows far past its own 3x3. Until
 * 2026-09-26 this scanned the server's full 40-tile cap for targets that were then all rejected as
 * TERRITORY_NOT_CONNECTED — the full view is per-cell, so a 17x17 window is also the cheap one.
 */
const EXPAND_VIEW_RADIUS = 8;
/** Pause before the next march when the server's answer carried no arrival time. */
const MARCH_BUSY_FALLBACK_MS = 10 * 60_000;

export interface AffordableBuildingResult {
  key: BuildingKey | null;
  buildRotation: number;
}

/**
 * First key in the rotation this bot can pay for right now, or null. Scanning from the rotation
 * cursor (rather than always from `desk`) keeps the round-robin's spread-out feel for a bot rich
 * enough to have a choice, while a bot with exactly one affordable key still finds it every time.
 *
 * Except the first stickerShop, which jumps the rotation: training costs sticker, and a bot gets none
 * from the land it takes — copper only appears on L6+ tiles (SLG_GEN.copperMinLevel), past the L2
 * ceiling of expansion.ts — so until the shop stands, no troop can ever be trained.
 */
export function affordableBuilding(me: PlayerWorldView, buildRotation: number): AffordableBuildingResult {
  const queue = me.buildQueue ?? [];
  if (queue.length >= BUILD_QUEUE_SLOTS) return { key: null, buildRotation }; // 'Build queue is full'
  const buildings = me.buildings ?? { desk: 1 };
  const resources = me.resources ?? {};
  const nextLevel = (key: BuildingKey) => (buildings[key] ?? 0) + queue.filter((e) => e.key === key).length + 1;
  const affordable = (key: BuildingKey) => {
    const toLevel = nextLevel(key);
    if (buildGateReason(buildings, key, toLevel)) return false; // desk gate / max level
    const cost = buildCost(key, toLevel);
    return !RESOURCE_TYPES.some((rt) => (resources[rt] ?? 0) < (cost[rt] ?? 0));
  };
  if (nextLevel('stickerShop') === 1 && affordable('stickerShop')) return { key: 'stickerShop', buildRotation };
  for (let i = 0; i < P1_BUILDING_KEYS.length; i++) {
    const key = P1_BUILDING_KEYS[(buildRotation + i) % P1_BUILDING_KEYS.length]!;
    if (!affordable(key)) continue;
    return { key, buildRotation: buildRotation + i + 1 };
  }
  return { key: null, buildRotation };
}

/**
 * Upgrade one building — but only one this bot can actually pay for.
 *
 * Until 2026-09-17 this fired the next key in a blind round-robin every single tick and let the
 * server reject it, which on live s2-0 meant **629,382 consecutive failures in 29 hours**
 * (`POST /world/build/upgrade` at 6/s, 64% of worldsvc's entire request volume, none of it ever
 * succeeding). A bot's base footprint covers exactly one resource tile, so it produces exactly one
 * of the five resources, while every entry in BUILD_COST_BASE costs paper and/or graphite plus, at
 * the higher keys, sticker/metal — so the overwhelming majority of bots can never afford anything,
 * forever. Nobody saw it because Scheduler.runUpkeep swallowed the rejection whole (fixed there too).
 *
 * This mirrors worldsvc's own validation (CityBuildingsService.upgradeBuilding) from the shared
 * constants rather than guessing, exactly as a real client greys out an unaffordable row instead of
 * posting it. The server stays authoritative: the mirror can only ever make the bot ask for LESS
 * than it is entitled to, because the view's settled `resources` only grow with time.
 */
export async function tryUpgrade(
  world: WorldClient,
  token: string | undefined,
  worldId: string | undefined,
  me: PlayerWorldView,
  buildRotation: number,
): Promise<{ view: PlayerWorldView | undefined; buildRotation: number }> {
  const picked = affordableBuilding(me, buildRotation);
  if (!picked.key) return { view: me, buildRotation: picked.buildRotation };
  if (!token || !worldId) return { view: undefined, buildRotation: picked.buildRotation };
  // The spend has happened either way, so a response we can't read must not let the pre-spend view
  // go on to the training step — that would have the bot spend the same money twice.
  const view = (await world.upgradeBuilding(token, worldId, picked.key)) || undefined;
  return { view, buildRotation: picked.buildRotation };
}

/**
 * Queue one training batch this bot can pay for (training.ts), returning the post-spend view to go
 * on with, or undefined when a spend happened but its result is unknown.
 */
export async function tryTrain(
  world: WorldClient,
  token: string | undefined,
  worldId: string | undefined,
  me: PlayerWorldView,
): Promise<PlayerWorldView | undefined> {
  const qty = planTraining(me, Date.now());
  if (!qty) return me;
  if (!token || !worldId) return undefined;
  return (await world.trainTroops(token, worldId, qty)) || undefined;
}

/**
 * March on the next tile bordering the sect's land (BOTSVC_DESIGN §3.4), returning how many troops
 * left the pool (0 = no march) and the next `marchBusyUntil`. One march in flight at a time: the next
 * is held until the server-reported arrival, after which the tile shows up as mid occupation-hold
 * (`contestedUntil`) and is not picked again.
 */
export async function tryExpand(
  world: WorldClient,
  token: string | undefined,
  worldId: string | undefined,
  me: PlayerWorldView,
  now: number,
  marchBusyUntil: number,
): Promise<{ sent: number; marchBusyUntil: number }> {
  if (now < marchBusyUntil) return { sent: 0, marchBusyUntil };
  const base = world.baseCoords(me);
  // Below this pool nothing can be sent without breaking the floor, so the map read would be wasted.
  if (!base || !me.troops || me.troops < EXPAND_MARCH_MIN_POOL || !token || !worldId) {
    return { sent: 0, marchBusyUntil };
  }
  const { tiles } = await world.getWorldMap(token, worldId, base.x, base.y, EXPAND_VIEW_RADIUS);
  const plan = planExpansion(tiles, base, me.troops, Date.now(), me.yieldRate);
  if (!plan || !token || !worldId) return { sent: 0, marchBusyUntil };
  const started = await world.startMarch(token, worldId, base, plan, plan.kind, plan.troops);
  return { sent: plan.troops, marchBusyUntil: started?.arriveAt ?? Date.now() + MARCH_BUSY_FALLBACK_MS };
}

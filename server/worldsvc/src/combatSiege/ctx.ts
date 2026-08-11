// Narrow interface for the free functions under ./arrival/*.ts (2026-08-11 mixin-chain split,
// claudedocs/server.md's "拆分形态的优先级" 形态②/独立类+组合 — replaces the old `SiegeServiceBase`
// declaration-merging interface from ./base.ts, which every mixin's assembled `this` satisfied by
// construction). ArrivalService (./arrival.ts) is the only constructor: it builds one `SiegeCtx`
// object with each method `.bind()`-ed to whichever sibling class actually owns it (helpers.ts for
// recordSiege/transferLoot/applySectLeaderPenalty/passiveRelocate, occupation.ts for
// writeContestedHold/startOccupationHold) — same "narrow interface over a few bound methods" shape
// as metaserver's ctx-bind convention (pve.ts/liveops.ts/economy.ts/auth.ts), used here because these
// five free functions only ever need a handful of specific methods, not the full SiegeHelpersService/
// OccupationService instances.
import type { ResourceType, SiegeOutcome } from '@nw/shared';
import type { MarchDoc, PlayerWorldDoc, SiegeDoc } from '../db';
import type { SiegeReplayInputs } from '../worldTypes';
import type { HoldTileDesc } from './occupation';

export interface SiegeCtx {
  recordSiege(m: MarchDoc, defenderId: string | undefined, outcome: SiegeOutcome, t: number, replay: SiegeReplayInputs | null): Promise<SiegeDoc>;
  transferLoot(defender: PlayerWorldDoc, attacker: PlayerWorldDoc, t: number): Promise<Record<ResourceType, number>>;
  applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void>;
  passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void>;
  writeContestedHold(m: MarchDoc, pw: PlayerWorldDoc, desc: HoldTileDesc, x: number, y: number, survivors: number, t: number, defenderId?: string): Promise<void>;
  startOccupationHold(m: MarchDoc, pw: PlayerWorldDoc, desc: HoldTileDesc, x: number, y: number, survivors: number, t: number, replay: SiegeReplayInputs | null): Promise<void>;
}

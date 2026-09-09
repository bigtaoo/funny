// Narrow interface over the SiegeService methods the arrival tick's two halves reach for (2026-09-09
// arrival.ts split, claudedocs/server.md's "拆分形态的优先级" 形态① — independent function modules).
//
// Same shape and reasoning as ../combatSiege/ctx.ts: the free functions in arrivalWalk.ts and
// arrivalSettle.ts need five specific methods, not a whole SiegeService, and declaring them here keeps
// each module's dependency on the siege domain visible in its own signature (and mockable in a test)
// instead of implicit in `this`. ArrivalService (./arrival.ts) is the only caller that passes one, and it
// simply hands over its `SiegeService`, which satisfies this structurally.
//
// The two groups are the halves themselves — see WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §7.2/§7.3. The
// union is one interface rather than two because the walking half settles a march that reaches its
// destination mid-walk, so it needs the settling half's three as well, transitively through applyArrival.
import type { MarchDoc, PlayerWorldDoc } from '../db';
import type { CoverEntry, OccEntry } from '../core/push';
import type { FieldEncounterResult, TowerDamageResult } from '../combatSiege/encounter';

export interface ArrivalSiegeCtx {
  /** Walking half (arrivalWalk.ts): the two tile-entry interceptions — ADR-051 P2b occ, P5/P3b cover. */
  resolveFieldEncounter(m: MarchDoc, pw: PlayerWorldDoc, defenderOcc: OccEntry, tid: string, t: number): Promise<FieldEncounterResult>;
  applyTowerDamage(m: MarchDoc, pw: PlayerWorldDoc, tower: CoverEntry, t: number): Promise<TowerDamageResult>;
  /** Settling half (arrivalSettle.ts): the arrival kinds that resolve into combat or ground-taking. */
  applySiege(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void>;
  applySweep(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void>;
  applyOccupy(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void>;
}

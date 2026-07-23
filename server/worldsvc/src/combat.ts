// worldsvc combat domain facade: marches (S8-2) + siege/sweep settlement (S8-3) + defense config (S8-4) + replay (G3-2c).
// Peeled out of the WorldService god-class (2026-07-03), then split by sub-domain (2026-07-03) into:
//   combatShared.ts   refundTroops — the one helper shared across march-arrival and siege-settlement paths
//   combatSiege.ts    SiegeService — siege / sweep settlement + ADR-026 delayed building-HP model
//   combatMarch.ts    MarchService — start / recall / list marches + arrival processing & dispatch
//   combatDefense.ts  DefenseService — defense config + siege replay spectating
// CombatService re-exposes the exact same public API so WorldService (service.ts) composes it unchanged.
// Depends on WorldCore for shared state, vision, spawn, push/schedule infra, settle/yield, and nations. No behavior change.
import type { MarchKind } from '@nw/shared';
import type { MarchView, OccupationView, StationedView } from './worldTypes';
import { WorldCore } from './core';
import { SiegeService } from './combatSiege';
import { MarchService } from './combatMarch';
import { DefenseService } from './combatDefense';

export class CombatService {
  private readonly siege: SiegeService;
  private readonly march: MarchService;
  private readonly defense: DefenseService;

  constructor(core: WorldCore) {
    this.siege = new SiegeService(core);
    this.march = new MarchService(core, this.siege);
    this.defense = new DefenseService(core);
  }

  // ── marches (combatMarch.ts) ─────────────────────────────────
  startMarch(
    worldId: string, accountId: string,
    fromX: number, fromY: number, toX: number, toY: number,
    kind: MarchKind, troops: number, teamId?: string,
  ): Promise<MarchView> {
    return this.march.startMarch(worldId, accountId, fromX, fromY, toX, toY, kind, troops, teamId);
  }
  recallMarch(worldId: string, accountId: string, mid: string): Promise<MarchView> {
    return this.march.recallMarch(worldId, accountId, mid);
  }
  getMarches(worldId: string, accountId: string): Promise<MarchView[]> {
    return this.march.getMarches(worldId, accountId);
  }
  processDueArrivals(nowMs?: number): Promise<number> {
    return this.march.processDueArrivals(nowMs);
  }
  // Field-stationing (2026-07-23): list / recall teams parked on tiles.
  getStationed(worldId: string, accountId: string): Promise<StationedView[]> {
    return this.march.getStationed(worldId, accountId);
  }
  recallStationed(worldId: string, accountId: string, teamId: string): Promise<MarchView | Record<string, never>> {
    return this.march.recallStationed(worldId, accountId, teamId);
  }

  // ── siege / sweep settlement (combatSiege.ts) ────────────────
  processDueSiegeDamage(nowMs?: number): Promise<number> {
    return this.siege.processDueSiegeDamage(nowMs);
  }
  // ADR-037 (§5.4): occupation-hold settlement (combatSiege/occupation.ts).
  processDueOccupations(nowMs?: number): Promise<number> {
    return this.siege.processDueOccupations(nowMs);
  }
  // Player-initiated occupation-hold cancel (2026-07-15, team management "取消指令").
  cancelOccupation(worldId: string, accountId: string, teamId: string): Promise<void> {
    return this.siege.cancelOccupation(worldId, accountId, teamId);
  }
  getOccupations(worldId: string, accountId: string): Promise<OccupationView[]> {
    return this.siege.getOccupations(worldId, accountId);
  }

  // ── defense config + replay (combatDefense.ts) ───────────────
  setDefense(worldId: string, accountId: string, tileKey: string, defenseConfig: Record<string, unknown>): Promise<void> {
    return this.defense.setDefense(worldId, accountId, tileKey, defenseConfig);
  }
  getDefense(worldId: string, accountId: string, tileKey: string): Promise<Record<string, unknown> | null> {
    return this.defense.getDefense(worldId, accountId, tileKey);
  }
  getSiegeReplay(worldId: string, accountId: string, sid: string): ReturnType<DefenseService['getSiegeReplay']> {
    return this.defense.getSiegeReplay(worldId, accountId, sid);
  }
  listSieges(worldId: string, accountId: string, limit?: number): ReturnType<DefenseService['listSieges']> {
    return this.defense.listSieges(worldId, accountId, limit);
  }
}

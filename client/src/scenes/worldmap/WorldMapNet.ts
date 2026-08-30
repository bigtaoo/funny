import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult, NationMsg } from '../../net/proto/transport';
import type { WorldMapContext, DeployKind } from './WorldMapContext';
import * as loaders from './net/loaders';
import * as march from './net/march';
import * as structures from './net/structures';
import * as push from './net/push';
import { errorMsg } from './net/errors';

// 2026-08-13: split into net/{loaders,march,structures,push,errors}.ts as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛") — every method here already took only
// `this.ctx` as its dependency (a single constructor-injected WorldMapContext), so the split is a
// near-mechanical `this.ctx` -> `ctx` port; this class is now a thin delegating shell that also
// owns `pendingTeamIds` (genuinely per-instance guard state, passed explicitly into net/march.ts's
// functions rather than hoisted to module scope, so multiple WorldMapNet instances never share it).
export class WorldMapNet {
  constructor(private readonly ctx: WorldMapContext) {}

  /**
   * Teams with a dispatch in flight (startMarch sent, response not yet applied to ctx.marches).
   * Closes the double-dispatch window: a player could pick a team for tile A, then — before the
   * server response refreshes ctx.marches — open the picker on tile B and pick the same team again,
   * sending it out twice. Held here from the tap until the response lands (or errors) so the picker's
   * idle-team gate treats it as busy in the meantime. Server enforces the same rule authoritatively.
   */
  private pendingTeamIds = new Set<string>();

  // ── Loaders (net/loaders.ts) ────────────────────────────────────────────────

  async loadData(): Promise<void> { return loaders.loadData(this.ctx); }
  async loadMapViewport(): Promise<void> { return loaders.loadMapViewport(this.ctx); }
  async refreshMarches(): Promise<void> { return loaders.refreshMarches(this.ctx); }
  async refreshWorldChat(): Promise<void> { return loaders.refreshWorldChat(this.ctx); }
  async refreshMe(): Promise<void> { return loaders.refreshMe(this.ctx); }
  async refreshTerritories(): Promise<void> { return loaders.refreshTerritories(this.ctx); }
  /** Formation templates behind the team panel (see loaders.refreshTeams). */
  async refreshTeams(): Promise<void> { return loaders.refreshTeams(this.ctx); }
  /** ADR-074 P1: re-fetch wild-city siege state (opened city panel; see loaders.refreshCities). */
  async refreshCities(): Promise<void> { return loaders.refreshCities(this.ctx); }

  // ── Marches / teams (net/march.ts) ──────────────────────────────────────────

  async showTeamPicker(tx: number, ty: number, kind: 'attack' | 'occupy' | 'move' = 'attack', stationMode?: 'idle' | 'garrison'): Promise<void> {
    return march.showTeamPicker(this.ctx, this.pendingTeamIds, tx, ty, kind, stationMode);
  }
  async doMarchTeam(tx: number, ty: number, teamId: string, kind: 'attack' | 'occupy' | 'move' = 'attack', stationMode?: 'idle' | 'garrison'): Promise<void> {
    return march.doMarchTeam(this.ctx, this.pendingTeamIds, tx, ty, teamId, kind, stationMode);
  }
  async doInPlaceOccupy(tx: number, ty: number, teamId: string): Promise<void> {
    return march.doInPlaceOccupy(this.ctx, this.pendingTeamIds, tx, ty, teamId);
  }
  async doMarch(tx: number, ty: number, kind: DeployKind, troops: number): Promise<void> {
    return march.doMarch(this.ctx, tx, ty, kind, troops);
  }
  async doJoin(): Promise<void> { return march.doJoin(this.ctx); }
  async doRecall(marchId: string, worldId: string): Promise<void> { return march.doRecall(this.ctx, marchId, worldId); }
  async doInstantReturn(marchId: string, worldId: string): Promise<void> { return march.doInstantReturn(this.ctx, marchId, worldId); }
  async doRecallStationed(teamId: string): Promise<void> { return march.doRecallStationed(this.ctx, teamId); }

  // ── Tile actions (net/structures.ts) ────────────────────────────────────────

  confirmRelocate(tx: number, ty: number): void { structures.confirmRelocate(this.ctx, tx, ty); }
  async doRelocate(tx: number, ty: number): Promise<void> { return structures.doRelocate(this.ctx, tx, ty); }
  confirmWatchtower(tx: number, ty: number): void { structures.confirmWatchtower(this.ctx, tx, ty); }
  async doWatchtower(tx: number, ty: number): Promise<void> { return structures.doWatchtower(this.ctx, tx, ty); }
  confirmBuildStructure(tx: number, ty: number, kind: 'arrowTower' | 'blocker'): void { structures.confirmBuildStructure(this.ctx, tx, ty, kind); }
  async doBuildStructure(tx: number, ty: number, kind: 'arrowTower' | 'blocker'): Promise<void> { return structures.doBuildStructure(this.ctx, tx, ty, kind); }
  async doDemolishStructure(tx: number, ty: number): Promise<void> { return structures.doDemolishStructure(this.ctx, tx, ty); }
  async doAbandon(tx: number, ty: number): Promise<void> { return structures.doAbandon(this.ctx, tx, ty); }
  async doAbandonFromList(tx: number, ty: number): Promise<void> { return structures.doAbandonFromList(this.ctx, tx, ty); }
  async doBuyShopItem(itemId: string): Promise<void> { return structures.doBuyShopItem(this.ctx, itemId); }
  async doRename(capitalIdx: number, name: string): Promise<void> { return structures.doRename(this.ctx, capitalIdx, name); }

  // ── Live push (net/push.ts) ──────────────────────────────────────────────────

  applyMarchUpdate(m: MarchUpdate): void { push.applyMarchUpdate(this.ctx, m); }
  applyNationMsg(n: NationMsg): void { push.applyNationMsg(this.ctx, n); }
  applyTileUpdate(tu: TileUpdate): void { push.applyTileUpdate(this.ctx, tu); }
  applyUnderAttack(u: UnderAttack): void { push.applyUnderAttack(this.ctx, u); }
  async applySiegeResult(s: SiegeResult): Promise<void> { return push.applySiegeResult(this.ctx, s); }

  errorMsg(e: unknown): string { return errorMsg(e); }

  // ── Lifecycle: split out of the original WorldMapScene ctor+destroy ──

  /**
   * P1-2 (comm-audit-2026-07-27): this used to run a 5s setInterval re-fetching
   * marches/occupations/stationed/worldChannel unconditionally — 100% redundant with the gateway
   * push channel, which already fires on every actual state change:
   *   - march dispatch/recall/arrival  → march_update  → applyMarchUpdate()   → refreshMarches()
   *   - siege settlement               → siege_result  → applySiegeResult()  → refreshMarches() (+ me/map)
   *   - world/nation chat message      → nation_msg    → applyNationMsg()    (P0-5, local update, no refetch)
   * Push delivery latency (worldsvc's 2s scheduler tick) was already *lower* than the poll interval,
   * so the timer was pure background tax, not a reliability backstop. What replaced it as the
   * "nothing periodically refreshes anymore" concern is the per-second HUD tick (P1-1,
   * WorldMapRenderer/lifecycle.ts) — that keeps countdown text moving between events using the
   * already-cached state, so removing this timer doesn't freeze the display, only the extra requests.
   * start()/destroy() are kept as the lifecycle hook pair WorldMapScene already calls; both are now
   * no-ops rather than removing the pairing from every call site.
   */
  start(): void { /* intentionally no-op — see doc comment above */ }

  destroy(): void { /* intentionally no-op — nothing left to tear down (see start()) */ }
}

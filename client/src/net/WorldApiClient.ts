// WorldApiClient — SLG REST client for worldsvc (S8).
// Separate from ApiClient because worldsvc runs on a different base URL
// (getWorldBaseUrl()) and is NOT included in openapi.yml (metaserver contract).
//
// Auth: reads the JWT stored by SaveManager under key nw_token.
// All responses are wrapped in { ok: true, data: T } | { ok: false, code, message }.
//
// DTO types are generated from server/contracts/openapi-world.yml via npm run rest:gen
// → src/net/openapi-world.ts. Do NOT hand-edit these type aliases (now re-exported from
// ./WorldApiClient/types.ts, see that file).
// AuctionView is the exception: auctionsvc is a standalone service with its own contract
// (server/contracts/openapi-auction.yml → src/net/openapi-auction.ts, AUCTION_DESIGN §9).
//
// The client is split by domain — each part lives in ./WorldApiClient/*.ts as an independent
// class constructed with the shared `WorldApiCore` (./WorldApiClient/core.ts, which owns the
// storage-backed token read + the shared req() transport). To add an endpoint: find the matching
// domain service (world / defenseTeams / siege / nationsSeason / shop / family / auction / sect /
// worldChannel / cityOps), add the method there + its matching one-line forward below, or add a
// new domain file — do NOT grow the domain logic into this file. All DTO/view types + WorldApiError
// are re-exported so existing importers (`from '../net/WorldApiClient'`) keep resolving to this
// file, not the directory.
//
// 2026-08-11: converted from a single 700+ line flat class to composition — zero cross-domain
// `this.*` calls except listFamilies→getMyFamily (both kept together in ./WorldApiClient/family.ts),
// see claudedocs/client-modules.md's split-form priority note. `WorldApiClient` itself is now a
// thin forwarding facade (one line per endpoint) rather than one big class — every method on this
// class exists solely because dozens of call sites across the codebase already call
// `worldApi.methodName(...)` directly and must keep resolving.
import type { IStorage } from '../platform/IPlatform';
import { WorldApiCore } from './WorldApiClient/core';
import { WorldService } from './WorldApiClient/world';
import { DefenseTeamsService } from './WorldApiClient/defenseTeams';
import { SiegeService } from './WorldApiClient/siege';
import { NationsSeasonService } from './WorldApiClient/nationsSeason';
import { SlgShopService } from './WorldApiClient/shop';
import { FamilyService } from './WorldApiClient/family';
import { AuctionApiService } from './WorldApiClient/auction';
import { SectService } from './WorldApiClient/sect';
import { WorldChannelService } from './WorldApiClient/worldChannel';
import { CityOpsService } from './WorldApiClient/cityOps';
import type {
  WorldMapView,
  WorldMapSparseView,
  WorldTileView,
  MarchView,
  OccupationView,
  StationedView,
  PlayerWorldView,
  EnterWorldView,
  ShardTransferTargetView,
  MarchKind,
  DefenseConfig,
  TeamTemplate,
  SiegeReplayView,
  SiegeSummaryView,
  NationView,
  SeasonView,
  SlgShopItemView,
  FamilyDetailView,
  FamilyView,
  FamilyJoinRequestView,
  FamilyMessageView,
  PlayerProfileExtra,
  FamilyRole,
  AuctionView,
  SectView,
  SectDetailView,
  SectVoteResult,
  SectMessageView,
  WorldChatMessage,
  BuildingKey,
} from './WorldApiClient/types';

export { WorldApiError } from './WorldApiClient/core';
export type {
  WorldTileView,
  WorldTileSparseView,
  WorldMapView,
  WorldMapSparseView,
  PlayerWorldView,
  MarchView,
  OccupationView,
  StationedView,
  FamilyMemberView,
  FamilyView,
  FamilyDetailView,
  FamilyJoinRequestView,
  FamilyMessageView,
  AuctionView,
  NationView,
  SeasonView,
  SlgShopItemView,
  SiegeReplayView,
  SiegeSummaryView,
  DefenseConfig,
  TeamTemplate,
  ShardTransferTargetView,
  ArmyEntry,
  SectView,
  SectDetailView,
  SectMemberFamilyView,
  SectMessageView,
  SectVoteResult,
  BuildingKey,
  CardSLGState,
  EnterWorldView,
  PlayerProfileExtra,
  WorldChatMessage,
} from './WorldApiClient/types';

/**
 * WorldApiClient — SLG REST client for worldsvc, thin forwarding facade over the per-domain
 * composition (see the file-header comment above). Owns one `WorldApiCore` (transport + token
 * read) and one instance of each domain service, all constructed with that same core.
 */
export class WorldApiClient {
  private readonly core: WorldApiCore;
  private readonly world: WorldService;
  private readonly defenseTeams: DefenseTeamsService;
  private readonly siege: SiegeService;
  private readonly nationsSeason: NationsSeasonService;
  private readonly slgShop: SlgShopService;
  private readonly family: FamilyService;
  private readonly auction: AuctionApiService;
  private readonly sect: SectService;
  private readonly worldChannel: WorldChannelService;
  private readonly cityOps: CityOpsService;

  constructor(storage: IStorage) {
    this.core = new WorldApiCore(storage);
    this.world = new WorldService(this.core);
    this.defenseTeams = new DefenseTeamsService(this.core);
    this.siege = new SiegeService(this.core);
    this.nationsSeason = new NationsSeasonService(this.core);
    this.slgShop = new SlgShopService(this.core);
    this.family = new FamilyService(this.core);
    this.auction = new AuctionApiService(this.core);
    this.sect = new SectService(this.core);
    this.worldChannel = new WorldChannelService(this.core);
    this.cityOps = new CityOpsService(this.core);
  }

  get available(): boolean {
    return this.core.available;
  }

  checkHealth(): Promise<boolean> {
    return this.core.checkHealth();
  }

  // ── World (./WorldApiClient/world.ts) ─────────────────────────────────────
  getMe(worldId: string): Promise<PlayerWorldView> {
    return this.world.getMe(worldId);
  }

  getMap(worldId: string, cx: number, cy: number, r: number): Promise<WorldMapView> {
    return this.world.getMap(worldId, cx, cy, r);
  }

  getMapSparse(
    worldId: string,
    cx: number,
    cy: number,
    r: number,
    lod: 'thin' | 'mid'
  ): Promise<WorldMapSparseView> {
    return this.world.getMapSparse(worldId, cx, cy, r, lod);
  }

  getTile(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.world.getTile(worldId, x, y);
  }

  getMarches(worldId: string): Promise<MarchView[]> {
    return this.world.getMarches(worldId);
  }

  getOccupations(worldId: string): Promise<OccupationView[]> {
    return this.world.getOccupations(worldId);
  }

  getStationed(worldId: string): Promise<StationedView[]> {
    return this.world.getStationed(worldId);
  }

  getTerritories(worldId: string): Promise<WorldTileView[]> {
    return this.world.getTerritories(worldId);
  }

  joinWorld(worldId: string): Promise<PlayerWorldView> {
    return this.world.joinWorld(worldId);
  }

  enterWorld(worldId: string, r: number, zoom: 1 | 2 | 3): Promise<EnterWorldView> {
    return this.world.enterWorld(worldId, r, zoom);
  }

  getTransferTargets(worldId: string): Promise<ShardTransferTargetView[]> {
    return this.world.getTransferTargets(worldId);
  }

  transferShard(fromWorldId: string, toWorldId: string): Promise<PlayerWorldView> {
    return this.world.transferShard(fromWorldId, toWorldId);
  }

  getActiveSeason(timeoutMs?: number): Promise<{ season: number }> {
    return this.world.getActiveSeason(timeoutMs);
  }

  resolveSeason(season: number): Promise<{ worldId: string }> {
    return this.world.resolveSeason(season);
  }

  joinSeason(season: number): Promise<PlayerWorldView> {
    return this.world.joinSeason(season);
  }

  abandonTile(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.world.abandonTile(worldId, x, y);
  }

  relocateBase(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.world.relocateBase(worldId, x, y);
  }

  buildWatchtower(
    worldId: string,
    x: number,
    y: number
  ): Promise<WorldTileView & { me: PlayerWorldView }> {
    return this.world.buildWatchtower(worldId, x, y);
  }

  buildStructure(
    worldId: string,
    x: number,
    y: number,
    kind: 'arrowTower' | 'blocker'
  ): Promise<WorldTileView & { me: PlayerWorldView }> {
    return this.world.buildStructure(worldId, x, y, kind);
  }

  demolishStructure(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.world.demolishStructure(worldId, x, y);
  }

  startMarch(
    worldId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    kind: MarchKind,
    troops: number,
    teamId?: string,
    stationMode?: 'idle' | 'garrison'
  ): Promise<MarchView & { me: PlayerWorldView }> {
    return this.world.startMarch(
      worldId,
      fromX,
      fromY,
      toX,
      toY,
      kind,
      troops,
      teamId,
      stationMode
    );
  }

  recallMarch(marchId: string, worldId: string): Promise<{ ok: true }> {
    return this.world.recallMarch(marchId, worldId);
  }

  instantReturnMarch(marchId: string, worldId: string): Promise<PlayerWorldView> {
    return this.world.instantReturnMarch(marchId, worldId);
  }

  cancelOccupation(teamId: string, worldId: string): Promise<{ ok: true }> {
    return this.world.cancelOccupation(teamId, worldId);
  }

  recallStationed(teamId: string, worldId: string): Promise<MarchView> {
    return this.world.recallStationed(teamId, worldId);
  }

  // ── Troops / city buildings / CC-4 (./WorldApiClient/cityOps.ts) ─────────
  trainTroops(worldId: string, qty: number): Promise<PlayerWorldView> {
    return this.cityOps.trainTroops(worldId, qty);
  }

  speedupTraining(worldId: string, coins: number): Promise<PlayerWorldView> {
    return this.cityOps.speedupTraining(worldId, coins);
  }

  upgradeBuilding(worldId: string, key: BuildingKey): Promise<PlayerWorldView> {
    return this.cityOps.upgradeBuilding(worldId, key);
  }

  speedupBuild(worldId: string, key: BuildingKey, coins: number): Promise<PlayerWorldView> {
    return this.cityOps.speedupBuild(worldId, key, coins);
  }

  distributeTroops(worldId: string, allocations: Record<string, number>): Promise<{ ok: true }> {
    return this.cityOps.distributeTroops(worldId, allocations);
  }

  recoverCard(worldId: string, cardInstanceId: string): Promise<{ ok: true }> {
    return this.cityOps.recoverCard(worldId, cardInstanceId);
  }

  // ── Defense / teams (./WorldApiClient/defenseTeams.ts) ───────────────────
  getDefense(worldId: string, tileKey: string): Promise<DefenseConfig | null> {
    return this.defenseTeams.getDefense(worldId, tileKey);
  }

  setDefense(
    worldId: string,
    tileKey: string,
    defenseConfig: DefenseConfig
  ): Promise<{ ok: true }> {
    return this.defenseTeams.setDefense(worldId, tileKey, defenseConfig);
  }

  getTeams(worldId: string): Promise<TeamTemplate[]> {
    return this.defenseTeams.getTeams(worldId);
  }

  setTeams(worldId: string, teams: TeamTemplate[]): Promise<{ ok: true }> {
    return this.defenseTeams.setTeams(worldId, teams);
  }

  // ── Siege replay (./WorldApiClient/siege.ts) ──────────────────────────────
  getSiegeReplay(worldId: string, siegeId: string): Promise<SiegeReplayView> {
    return this.siege.getSiegeReplay(worldId, siegeId);
  }

  listSieges(worldId: string, limit?: number): Promise<SiegeSummaryView[]> {
    return this.siege.listSieges(worldId, limit);
  }

  // ── Nations / season (./WorldApiClient/nationsSeason.ts) ─────────────────
  getNations(worldId: string): Promise<NationView[]> {
    return this.nationsSeason.getNations(worldId);
  }

  setNationName(worldId: string, capitalIdx: number, name: string): Promise<{ ok: true }> {
    return this.nationsSeason.setNationName(worldId, capitalIdx, name);
  }

  getSeason(worldId: string): Promise<SeasonView> {
    return this.nationsSeason.getSeason(worldId);
  }

  // ── SLG shop (./WorldApiClient/shop.ts) ───────────────────────────────────
  getShopItems(): Promise<SlgShopItemView[]> {
    return this.slgShop.getShopItems();
  }

  buyShopItem(worldId: string, itemId: string): Promise<PlayerWorldView> {
    return this.slgShop.buyShopItem(worldId, itemId);
  }

  // ── Family (./WorldApiClient/family.ts) ───────────────────────────────────
  getMyFamily(): Promise<FamilyDetailView | null> {
    return this.family.getMyFamily();
  }

  listFamilies(): Promise<FamilyView[]> {
    return this.family.listFamilies();
  }

  getFamily(familyId: string): Promise<FamilyDetailView> {
    return this.family.getFamily(familyId);
  }

  createFamily(name: string, tag: string): Promise<FamilyDetailView> {
    return this.family.createFamily(name, tag);
  }

  requestJoinFamily(familyId: string): Promise<{ requestId: string }> {
    return this.family.requestJoinFamily(familyId);
  }

  listJoinRequests(): Promise<FamilyJoinRequestView[]> {
    return this.family.listJoinRequests();
  }

  respondJoinRequest(requestId: string, accept: boolean): Promise<{ ok: true }> {
    return this.family.respondJoinRequest(requestId, accept);
  }

  browseFamilies(query?: string, limit?: number): Promise<FamilyView[]> {
    return this.family.browseFamilies(query, limit);
  }

  leaveFamily(): Promise<{ ok: true }> {
    return this.family.leaveFamily();
  }

  kickMember(targetId: string): Promise<{ ok: true }> {
    return this.family.kickMember(targetId);
  }

  setRole(targetId: string, role: FamilyRole): Promise<{ ok: true }> {
    return this.family.setRole(targetId, role);
  }

  dissolveFamily(): Promise<{ ok: true }> {
    return this.family.dissolveFamily();
  }

  sendFamilyMessage(familyId: string, body: string, senderName?: string): Promise<{ id: string }> {
    return this.family.sendFamilyMessage(familyId, body, senderName);
  }

  getFamilyChannel(
    familyId: string,
    opts?: { before?: number; limit?: number }
  ): Promise<FamilyMessageView[]> {
    return this.family.getFamilyChannel(familyId, opts);
  }

  getProfileExtra(publicId: string): Promise<PlayerProfileExtra> {
    return this.family.getProfileExtra(publicId);
  }

  // ── Auction (./WorldApiClient/auction.ts) ─────────────────────────────────
  listAuctions(opts?: { itemType?: string; limit?: number }): Promise<AuctionView[]> {
    return this.auction.listAuctions(opts);
  }

  getMyListings(): Promise<AuctionView[]> {
    return this.auction.getMyListings();
  }

  getAuctionRefBand(
    category: string
  ): Promise<{ ref: number; floor: number; ceil: number } | null> {
    return this.auction.getAuctionRefBand(category);
  }

  createAuction(
    itemType: 'material' | 'equipment' | 'card' | 'skin',
    item: Record<string, unknown>,
    qty: number,
    durationSec: number,
    opts?: {
      saleMode?: 'fixed' | 'auction';
      price?: number;
      startPrice?: number;
      buyoutPrice?: number;
      designatedBuyerId?: string;
    }
  ): Promise<AuctionView> {
    return this.auction.createAuction(itemType, item, qty, durationSec, opts);
  }

  buyAuction(auctionId: string): Promise<{ ok: true }> {
    return this.auction.buyAuction(auctionId);
  }

  placeBid(auctionId: string, amount: number): Promise<AuctionView> {
    return this.auction.placeBid(auctionId, amount);
  }

  cancelAuction(auctionId: string): Promise<{ ok: true }> {
    return this.auction.cancelAuction(auctionId);
  }

  // ── Sect (./WorldApiClient/sect.ts) ───────────────────────────────────────
  listSects(worldId: string): Promise<SectView[]> {
    return this.sect.listSects(worldId);
  }

  getSect(sectId: string): Promise<SectDetailView> {
    return this.sect.getSect(sectId);
  }

  createSect(worldId: string, name: string, tag: string): Promise<SectDetailView> {
    return this.sect.createSect(worldId, name, tag);
  }

  joinSect(worldId: string, sectId: string): Promise<{ ok: true }> {
    return this.sect.joinSect(worldId, sectId);
  }

  leaveSect(worldId: string): Promise<{ ok: true }> {
    return this.sect.leaveSect(worldId);
  }

  dissolveSect(worldId: string): Promise<{ ok: true }> {
    return this.sect.dissolveSect(worldId);
  }

  allySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.sect.allySect(worldId, targetSectId);
  }

  unallySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.sect.unallySect(worldId, targetSectId);
  }

  voteRemoveSectLeader(worldId: string, nomineeFamilyId: string): Promise<SectVoteResult> {
    return this.sect.voteRemoveSectLeader(worldId, nomineeFamilyId);
  }

  sendSectMessage(worldId: string, body: string, senderName?: string): Promise<SectMessageView> {
    return this.sect.sendSectMessage(worldId, body, senderName);
  }

  getSectChannel(
    worldId: string,
    opts?: { before?: number; limit?: number }
  ): Promise<SectMessageView[]> {
    return this.sect.getSectChannel(worldId, opts);
  }

  // ── World channel (./WorldApiClient/worldChannel.ts) ──────────────────────
  getWorldChannel(
    worldId: string,
    opts?: { before?: number; limit?: number }
  ): Promise<WorldChatMessage[]> {
    return this.worldChannel.getWorldChannel(worldId, opts);
  }

  sendWorldChannelMessage(
    worldId: string,
    body: string,
    senderName: string
  ): Promise<WorldChatMessage> {
    return this.worldChannel.sendWorldChannelMessage(worldId, body, senderName);
  }
}

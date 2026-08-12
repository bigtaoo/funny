// Generated DTO type aliases (single source of truth = openapi-world.yml) + the few hand-written
// view/error types the domain classes in this directory share. Split out of ../WorldApiClient.ts
// (2026-08-11 composition conversion) so domain files can import types without reaching through
// the facade file. Re-exported from ../WorldApiClient.ts so existing importers
// (`from '../net/WorldApiClient'`) keep resolving.
import type { components, operations } from '../openapi-world';
import type { components as socialComponents } from '../openapi-social';
import type { components as auctionComponents } from '../openapi-auction';

export type WorldTileView = components['schemas']['WorldTileView'];
export type WorldMapView = components['schemas']['WorldMapView'];

/** Sparse occupied tile (zoom 2/3 bird's-eye layer; contains only occupied tiles). */
export interface WorldTileSparseView {
  x: number;
  y: number;
  type: string;
  mine?: boolean;
  ally?: boolean;
  sectmate?: boolean;
  allySect?: boolean;
}

export interface WorldMapSparseView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  lod: 'thin' | 'mid';
  tiles: WorldTileSparseView[];
}
export type PlayerWorldView = components['schemas']['PlayerWorldView'];
export type MarchView = components['schemas']['MarchView'];
export type OccupationView = components['schemas']['OccupationView'];
export type StationedView = components['schemas']['StationedView'];

// Family DTOs are generated from server/contracts/openapi-social.yml (socialsvc's own contract,
// SOCIAL_SVC_DESIGN.md §4.1) via npm run rest:gen → src/net/openapi-social.ts. Do NOT hand-edit these type aliases.
export type FamilyMemberView = socialComponents['schemas']['FamilyMemberView'];
export type FamilyView = socialComponents['schemas']['FamilyView'];
export type FamilyDetailView = socialComponents['schemas']['FamilyDetailView'];
export type FamilyJoinRequestView = socialComponents['schemas']['FamilyJoinRequestView'];
export type FamilyMessageView = socialComponents['schemas']['FamilyMessageView'];

export type AuctionView = auctionComponents['schemas']['AuctionView'];
export type NationView = components['schemas']['NationView'];
export type SeasonView = components['schemas']['SeasonView'];
export type SlgShopItemView = components['schemas']['SlgShopItemView'];
export type SiegeReplayView = components['schemas']['SiegeReplayView'];
export type SiegeSummaryView = components['schemas']['SiegeSummaryView'];
export type DefenseConfig = components['schemas']['DefenseConfig'];
export type TeamTemplate = components['schemas']['TeamTemplate'];
export type ShardTransferTargetView = components['schemas']['ShardTransferTargetView'];
export type ArmyEntry = components['schemas']['ArmyEntry'];
export type SectView = components['schemas']['SectView'];
export type SectDetailView = components['schemas']['SectDetailView'];
export type SectMemberFamilyView = components['schemas']['SectMemberFamilyView'];
export type SectMessageView = components['schemas']['SectMessageView'];
export type SectVoteResult = components['schemas']['SectVoteResult'];
export type BuildingKey = components['schemas']['BuildingKey'];
export type CardSLGState = components['schemas']['CardSLGState'];

/** GET-alike aggregated response for POST /world/enter (P1-5, comm-audit-2026-07-27). */
export type EnterWorldView = NonNullable<
  operations['enterWorld']['responses']['200']['content']['application/json']['data']
>;

/** Rank/ELO/family/sect for an arbitrary player, fetched by public id (see {@link getProfileExtra}). */
export interface PlayerProfileExtra {
  rank?: string;
  elo?: number;
  familyName?: string;
  sectName?: string;
}

export interface WorldChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  /** 9-digit public id (display-only); empty if unknown (meta unavailable or message predates this field). */
  senderPublicId: string;
  /** Sender's equipped title (称号), if any. */
  title?: string;
  /** Sender's sect name (宗门), if any. */
  sectName?: string;
  /** Sender's family name (家族), if any. */
  familyName?: string;
  body: string;
  ts: number;
}

// Derived enum types for method parameters
export type MarchKind = Exclude<MarchView['kind'], 'return'>;
export type FamilyRole = FamilyMemberView['role'];

// gateway/Gateway.ts split (2026-08-10, single-class → independent-classes-plus-composition, ≤500-line convention,
// see claudedocs/server.md "单文件 500 行收敛"): shared types/constants/pure helpers used across the split layers
// (connRegistry/presenceBroadcaster/matchCommands/peerJudge/dispatcher). No behavior here, only declarations.
import type { WebSocket } from 'ws';
import type { FrameCmdsOut, PlayerSlotOut, ServerMsg } from '../proto';
import type { PushMsg } from '../matchsvcClient';

export const HEARTBEAT_MS = 30_000;
/** Maximum wait time for judge re-computation + report (includes network round-trip + client running the full match). */
export const JUDGE_TIMEOUT_MS = 20_000;

/**
 * Per-connection control-message rate limiting (SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4): before this,
 * `handle()` dispatched every control message unconditionally — a scripted client could hammer room_create/
 * duel_invite as fast as the socket allows, spamming matchsvc and, for duel_invite, spamming *other* players
 * with invites. Two tiers, both keyed by accountId (reusing @nw/shared's createRateLimiter, same
 * in-process/Redis-backed pair as metaserver's auth/telemetry/save limiters):
 *   - TIGHT: creates state or notifies another player (room_create/room_join/duel_invite) — the more
 *     attractive abuse target, so a stricter cap than metaserver telemetry's 30/min (NW_AUTH_RATE_LIMIT-style
 *     env override below).
 *   - STANDARD: acts on state the player already owns (duel_respond/room_ready/room_leave/room_start) —
 *     same or a bit looser, since there's no third party to spam and the actions are more "clicky".
 * judge_verdict/client_caps/ping stay unlimited (ping is the hottest path; judge_verdict is a trusted
 * peer-judge report, not an abuse surface — see pickJudge's uniform-random selection).
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Production values are read from env by config.ts (NW_GW_RATE_LIMIT_TIGHT/NW_GW_RATE_LIMIT_STANDARD,
 *  loadGatewayEnv) and passed in via the constructor opts below; these are just the fallback when a caller
 *  (tests, or a future embedder) doesn't pass one. */
export const DEFAULT_RATE_LIMIT_TIGHT = 10;
export const DEFAULT_RATE_LIMIT_STANDARD = 20;

export type RateLimitTier = 'tight' | 'standard';
/** ClientMsg.case values gated by the TIGHT tier. */
export const TIGHT_CASES = new Set(['room_create', 'room_join', 'duel_invite']);
/** ClientMsg.case values gated by the STANDARD tier. */
export const STANDARD_CASES = new Set(['duel_respond', 'room_ready', 'room_leave', 'room_start']);

export interface GwConn {
  accountId: string;
  ws: WebSocket;
  alive: boolean;
  /** Whether this client is capable of performing headless re-computation judging (reported via client_caps). */
  canJudge: boolean;
  /** Monotonic per-connection sequence (see connRegistry's nextConnSeq) — lets routeKick order two connections
   *  for the same account that landed on DIFFERENT instances, instead of evicting unconditionally. */
  connSeq: number;
}

/** meta → gateway judge request (internal HTTP /gw/judge). */
export interface JudgeArgs {
  seed: number;
  mode: number;
  endFrame: number;
  frames: FrameCmdsOut[];
  /** accountIds of both match participants — a player cannot judge their own match. */
  exclude: string[];
  /** PvE spot-check re-computation (PVE_INTEGRITY §8.6 L1): if non-empty, the judge re-runs the specified campaign level. */
  levelId?: string;
  /** SLG siege defense config JSON string (S8-3b): if non-empty, the judge re-runs in siege mode. */
  defenseJson?: string;
  /** CC-1 Hero Roster snapshot (2026-07-26 fix, PVE_INTEGRITY §9): JSON of Record<string, CardInstance>, server-authoritative, ensures deterministic PvE/siege re-computation using the player's real card levels. */
  cardInstancesJson?: string;
  /** JSON of Record<string, EquipmentInstance>, paired with cardInstancesJson. */
  equipmentInvJson?: string;
  /** Ranked PvP deck restriction (PVP_LOADOUT §6.2): the two real match clients' decks, needed for a deterministic re-simulation. */
  decks?: { top: string[]; bottom: string[] };
}
/** Judge result (returned to meta). ok=false: no eligible candidate / timeout / re-computation failed. */
export interface JudgeResult {
  ok: boolean;
  stateHash?: string;
  winnerSide?: number;
  /** Stars obtained from PvE re-computation (PVE_INTEGRITY §8.6 L1). */
  stars?: number;
  /** PvE feed-in (S9-3b): JSON of the player's per-match achievement stat counts from re-computation; always empty for PvP/siege. */
  statsJson?: string;
  judgeAccountId?: string;
}

export interface PendingJudge {
  resolve: (r: JudgeResult) => void;
  accountId: string;
  timer: NodeJS.Timeout;
}

/** matchsvc → player push, bound to a specific accountId (implemented by connRegistry, consumed by every other layer). */
export type Push = (accountId: string, msg: PushMsg, roomId?: string) => void;

/** Narrow read-only view of connRegistry's account→socket map — the shape every sibling layer actually
 *  needs (peerJudge iterates candidates, matchCommands/dispatcher/presenceBroadcaster look up one at a time),
 *  so none of them depend on connRegistry's full public surface (kick/presence/heartbeat plumbing). */
export interface ConnLookup {
  get(accountId: string): GwConn | undefined;
  has(accountId: string): boolean;
  values(): IterableIterator<GwConn>;
}

/** Player display name (gateway only has accountId; follows the gameserver's legacy convention of using the first 12 characters). */
export function displayName(accountId: string): string {
  return accountId.slice(0, 12);
}

// matchsvc PushMsg (proto-agnostic) → control-plane ServerMsg.
export function toServerMsg(msg: PushMsg): ServerMsg {
  switch (msg.kind) {
    case 'room_state':
      return {
        case: 'room_state',
        code: msg.code,
        players: msg.players as PlayerSlotOut[],
        phase: msg.phase,
      };
    case 'match_found':
      return { case: 'match_found', gameUrl: msg.gameUrl, ticket: msg.ticket };
    case 'match_bot':
      return {
        case: 'match_bot',
        seed: msg.seed,
        opponentName: msg.opponentName,
        elo: msg.elo,
        difficulty: msg.difficulty,
      };
    case 'room_error':
      return { case: 'room_error', code: msg.code, message: msg.message };
    case 'friend_presence':
      return { case: 'friend_presence', publicId: msg.publicId, online: msg.online };
    case 'friend_request':
      return {
        case: 'friend_request',
        requestId: msg.requestId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        message: msg.message,
      };
    case 'friend_update':
      return { case: 'friend_update', publicId: msg.publicId, added: msg.added };
    case 'chat_message':
      return {
        case: 'chat_message',
        convId: msg.convId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
    case 'mail_new':
      return { case: 'mail_new', mailId: msg.mailId, hasAttachment: msg.hasAttachment };
    case 'march_update':
      return {
        case: 'march_update',
        marchId: msg.marchId,
        marchKind: msg.marchKind,
        fromTile: msg.fromTile,
        toTile: msg.toTile,
        arriveAt: msg.arriveAt,
        status: msg.status,
      };
    case 'tile_update':
      return {
        case: 'tile_update',
        tileId: msg.tileId,
        type: msg.type,
        level: msg.level,
        ownerPublicId: msg.ownerPublicId,
        ownerName: msg.ownerName,
        familyId: msg.familyId,
        protectedUntil: msg.protectedUntil,
      };
    case 'under_attack':
      return {
        case: 'under_attack',
        tile: msg.tile,
        attackerName: msg.attackerName,
        attackerPublicId: msg.attackerPublicId,
        arriveAt: msg.arriveAt,
        troopsHint: msg.troopsHint,
      };
    case 'siege_result':
      return {
        case: 'siege_result',
        siegeId: msg.siegeId,
        marchId: msg.marchId,
        tile: msg.tile,
        outcome: msg.outcome,
        lootSummary: msg.lootSummary,
        replayRef: msg.replayRef,
        attackerId: msg.attackerId,
        marchKind: msg.marchKind,
      };
    case 'family_msg':
      return {
        case: 'family_msg',
        familyId: msg.familyId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
    case 'sect_msg':
      return {
        case: 'sect_msg',
        sectId: msg.sectId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
    case 'nation_msg':
      return {
        case: 'nation_msg',
        worldId: msg.worldId,
        fromPublicId: msg.fromPublicId,
        fromName: msg.fromName,
        body: msg.body,
        ts: msg.ts,
      };
    case 'duel_invited':
      return { case: 'duel_invited', inviteId: msg.inviteId, fromPublicId: msg.fromPublicId, fromName: msg.fromName };
    case 'duel_cancelled':
      return { case: 'duel_cancelled', inviteId: msg.inviteId, reason: msg.reason };
    case 'queue_state':
      return { case: 'queue_state' };
    case 'prematch_lost':
      return { case: 'pre_match_lost', context: msg.context };
  }
}

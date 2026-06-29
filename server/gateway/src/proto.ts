// Control-plane transport.proto encode/decode (gateway side, M20). Single source of truth =
// ../../contracts/transport.proto (shared with gameserver / client), parsed at runtime by protobufjs.
//
// The gateway only recognizes the control-plane subset: decodes room_create/join/ready/start/leave + ping;
// encodes room_state / room_error / match_found / pong. Lockstep messages (cmd_submit /
// frame_batch / conn_* / match_*) belong to the data plane, handled by gameserver; decoded as 'unknown' and ignored here.
import * as protobuf from 'protobufjs';
import * as fs from 'fs';
import * as path from 'path';

export const RoomPhase = {
  WAITING: 0,
  READY: 1,
  COUNTDOWN: 2,
  IN_MATCH: 3,
  OVER: 4,
} as const;
export type RoomPhaseVal = (typeof RoomPhase)[keyof typeof RoomPhase];

export const MatchMode = {
  FRIENDLY: 0,
  RANKED: 1,
} as const;
export type MatchModeVal = (typeof MatchMode)[keyof typeof MatchMode];

export type ClientMsg =
  | { case: 'room_create'; mode: number }
  | { case: 'room_join'; code: string }
  | { case: 'room_ready'; ready: boolean }
  | { case: 'room_leave' }
  | { case: 'room_start' }
  | { case: 'ping' }
  | { case: 'client_caps'; canJudge: boolean }
  | {
      case: 'judge_verdict';
      requestId: string;
      stateHash: string;
      winnerSide: number;
      ok: boolean;
      stars: number;
      /** PvE feed-in (S9-3b): JSON of per-match achievement counters recomputed by the judge; always empty for PvP/siege */
      statsJson: string;
    }
  | { case: 'unknown' };

export interface PlayerSlotOut {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
  publicId: string;
}
/** Non-empty commands for a single sim frame (judge replay frame; same structure as conn_resync.log). */
export interface FrameCmdsOut {
  frame: number;
  cmds: { side: number; commands: Uint8Array }[];
}
export type ServerMsg =
  | { case: 'room_state'; code: string; players: PlayerSlotOut[]; phase: number }
  | { case: 'match_found'; gameUrl: string; ticket: string }
  | { case: 'match_bot'; seed: number; opponentName: string; elo: number; difficulty: string }
  | { case: 'room_error'; code: string; message: string }
  | {
      case: 'judge_request';
      requestId: string;
      seed: number;
      mode: number;
      endFrame: number;
      frames: FrameCmdsOut[];
      /** PvE integrity spot-check recomputation (PVE_INTEGRITY §8.6 L1): non-empty → judge recomputes this level in campaign mode. */
      levelId: string;
      /** @deprecated S3-2 blueprint snapshot; replaced by unitLevels from S12 onwards. */
      pveUpgrades: Record<string, number>;
      /** S12 unit progression level snapshot (unitId→1..9), ensures deterministic recomputation (takes precedence over pveUpgrades). */
      unitLevels: Record<string, number>;
    }
  // —— Social push notifications (S6, SOCIAL_DESIGN §4.2) ——
  | { case: 'friend_presence'; publicId: string; online: boolean }
  | { case: 'friend_request'; requestId: string; fromPublicId: string; fromName: string; message: string }
  | { case: 'friend_update'; publicId: string; added: boolean }
  | { case: 'chat_message'; convId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { case: 'mail_new'; mailId: string; hasAttachment: boolean }
  // —— SLG overworld push notifications (S8-2) ——
  | {
      case: 'march_update';
      marchId: string;
      marchKind: string;
      fromTile: string;
      toTile: string;
      arriveAt: number;
      status: string;
    }
  | {
      case: 'tile_update';
      tileId: string;
      type: string;
      level: number;
      ownerPublicId: string;
      ownerName: string;
      familyId: string;
      protectedUntil: number;
    }
  | {
      case: 'under_attack';
      tile: string;
      attackerName: string;
      attackerPublicId: string;
      arriveAt: number;
      troopsHint: number;
    }
  | {
      case: 'siege_result';
      siegeId: string;
      tile: string;
      outcome: string;
      lootSummary: string;
      replayRef: string;
    }
  | { case: 'family_msg'; familyId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { case: 'sect_msg'; sectId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { case: 'nation_msg'; worldId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { case: 'pong' };

function resolveProtoPath(): string {
  const envDir = process.env.NW_CONTRACTS_DIR;
  const candidates = [
    envDir ? path.join(envDir, 'transport.proto') : null,
    path.resolve(__dirname, '../../contracts/transport.proto'),
    path.resolve(__dirname, '../../../contracts/transport.proto'),
    path.resolve(process.cwd(), 'contracts/transport.proto'),
    path.resolve(process.cwd(), '../contracts/transport.proto'),
  ].filter((p): p is string => p !== null);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `transport.proto not found; set NW_CONTRACTS_DIR. tried:\n${candidates.join('\n')}`,
  );
}

const root = protobuf.parse(fs.readFileSync(resolveProtoPath(), 'utf8'), {
  keepCase: true,
}).root;
const Envelope = root.lookupType('nw.transport.Envelope');

export function decodeClient(buf: Uint8Array): ClientMsg {
  const env = Envelope.decode(buf) as protobuf.Message & Record<string, unknown>;
  if ((env as Record<string, unknown>)['msg'] !== 'client') return { case: 'unknown' };
  const client = (env as Record<string, unknown>)['client'] as
    | (protobuf.Message & Record<string, unknown>)
    | undefined;
  if (!client) return { case: 'unknown' };
  const c = (client as Record<string, unknown>)['body'] as string | undefined;
  const get = (k: string): Record<string, unknown> =>
    ((client as Record<string, unknown>)[k] as Record<string, unknown>) ?? {};
  switch (c) {
    case 'room_create':
      return { case: 'room_create', mode: Number(get('room_create')['mode'] ?? 0) };
    case 'room_join':
      return { case: 'room_join', code: String(get('room_join')['code'] ?? '') };
    case 'room_ready':
      return { case: 'room_ready', ready: Boolean(get('room_ready')['ready']) };
    case 'room_leave':
      return { case: 'room_leave' };
    case 'room_start':
      return { case: 'room_start' };
    case 'ping':
      return { case: 'ping' };
    case 'client_caps':
      return { case: 'client_caps', canJudge: Boolean(get('client_caps')['can_judge']) };
    case 'judge_verdict': {
      const v = get('judge_verdict');
      return {
        case: 'judge_verdict',
        requestId: String(v['request_id'] ?? ''),
        stateHash: String(v['state_hash'] ?? ''),
        winnerSide: Number(v['winner_side'] ?? 0),
        ok: Boolean(v['ok']),
        stars: Number(v['stars'] ?? 0),
        statsJson: String(v['stats_json'] ?? ''),
      };
    }
    default:
      return { case: 'unknown' };
  }
}

export function encodeServer(msg: ServerMsg): Uint8Array {
  let server: Record<string, unknown>;
  switch (msg.case) {
    case 'room_state':
      server = {
        room_state: {
          code: msg.code,
          players: msg.players.map((p) => ({
            side: p.side,
            name: p.name,
            ready: p.ready,
            connected: p.connected,
            public_id: p.publicId,
          })),
          phase: msg.phase,
        },
      };
      break;
    case 'match_found':
      server = { match_found: { game_url: msg.gameUrl, ticket: msg.ticket } };
      break;
    case 'match_bot':
      server = {
        match_bot: {
          seed: msg.seed,
          opponent_name: msg.opponentName,
          elo: msg.elo,
          difficulty: msg.difficulty,
        },
      };
      break;
    case 'room_error':
      server = { room_error: { code: msg.code, message: msg.message } };
      break;
    case 'judge_request':
      server = {
        judge_request: {
          request_id: msg.requestId,
          seed: msg.seed,
          mode: msg.mode,
          end_frame: msg.endFrame,
          frames: msg.frames.map((f) => ({
            frame: f.frame,
            cmds: f.cmds.map((c) => ({ side: c.side, commands: c.commands })),
          })),
          level_id: msg.levelId,
          pve_upgrades: msg.pveUpgrades,
          unit_levels: msg.unitLevels,
        },
      };
      break;
    case 'friend_presence':
      server = { friend_presence: { public_id: msg.publicId, online: msg.online } };
      break;
    case 'friend_request':
      server = {
        friend_request: {
          request_id: msg.requestId,
          from_public_id: msg.fromPublicId,
          from_name: msg.fromName,
          message: msg.message,
        },
      };
      break;
    case 'friend_update':
      // FriendUpdateKind: ADDED=0, REMOVED=1.
      server = { friend_update: { public_id: msg.publicId, kind: msg.added ? 0 : 1 } };
      break;
    case 'chat_message':
      server = {
        chat_message: {
          conv_id: msg.convId,
          from_public_id: msg.fromPublicId,
          from_name: msg.fromName,
          body: msg.body,
          ts: msg.ts,
        },
      };
      break;
    case 'mail_new':
      server = { mail_new: { mail_id: msg.mailId, has_attachment: msg.hasAttachment } };
      break;
    case 'march_update':
      server = {
        march_update: {
          march_id: msg.marchId,
          kind: msg.marchKind,
          from_tile: msg.fromTile,
          to_tile: msg.toTile,
          arrive_at: msg.arriveAt,
          status: msg.status,
        },
      };
      break;
    case 'tile_update':
      server = {
        tile_update: {
          tile_id: msg.tileId,
          type: msg.type,
          level: msg.level,
          owner_public_id: msg.ownerPublicId,
          owner_name: msg.ownerName,
          family_id: msg.familyId,
          protected_until: msg.protectedUntil,
        },
      };
      break;
    case 'under_attack':
      server = {
        under_attack: {
          tile: msg.tile,
          attacker_name: msg.attackerName,
          attacker_public_id: msg.attackerPublicId,
          arrive_at: msg.arriveAt,
          troops_hint: msg.troopsHint,
        },
      };
      break;
    case 'siege_result':
      server = {
        siege_result: {
          siege_id: msg.siegeId,
          tile: msg.tile,
          outcome: msg.outcome,
          loot_summary: msg.lootSummary,
          replay_ref: msg.replayRef,
        },
      };
      break;
    case 'family_msg':
      server = {
        family_msg: {
          family_id: msg.familyId,
          from_public_id: msg.fromPublicId,
          from_name: msg.fromName,
          text: msg.body,
          ts: msg.ts,
        },
      };
      break;
    case 'sect_msg':
      server = {
        sect_msg: {
          sect_id: msg.sectId,
          from_public_id: msg.fromPublicId,
          from_name: msg.fromName,
          text: msg.body,
          ts: msg.ts,
        },
      };
      break;
    case 'nation_msg':
      server = {
        nation_msg: {
          world_id: msg.worldId,
          from_public_id: msg.fromPublicId,
          from_name: msg.fromName,
          text: msg.body,
          ts: msg.ts,
        },
      };
      break;
    case 'pong':
      server = { pong: {} };
      break;
  }
  const env = Envelope.fromObject({ server });
  return Envelope.encode(env).finish();
}

// transport.proto encode/decode layer (M12). Single source of truth = ../../contracts/transport.proto,
// parsed at runtime with protobufjs (no second schema maintained). The server only recognises this layer;
// `commands` is bytes, opaque to the server (passed through without decoding).
//
// Public API: decode ClientMsg (discriminated union) + construct and encode ServerMsg.
import * as protobuf from 'protobufjs';
import * as fs from 'fs';
import * as path from 'path';

// ── 枚举常量（与 transport.proto 对齐；编码统一传数值）──────
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

// ── 透传载荷形状（服务器侧）────────────────────────────
export interface SideCmd {
  side: number;
  commands: Uint8Array; // game.proto PlayerCommand[]，opaque
}
export interface FrameCmds {
  frame: number;
  cmds: SideCmd[];
}

// ── ClientMsg 判别联合（按 oneof case）───────────────────
export type ClientMsg =
  | { case: 'room_create'; mode: number }
  | { case: 'room_join'; code: string }
  | { case: 'room_ready'; ready: boolean }
  | { case: 'room_leave' }
  | { case: 'room_start' }
  | { case: 'cmd_submit'; commands: Uint8Array }
  | { case: 'match_result'; stateHash: string; winnerSide: number; stats?: Record<string, number> }
  | { case: 'conn_resume'; roomId: string; lastFrame: number }
  | { case: 'ping' }
  | { case: 'unknown' };

// ── ServerMsg 构造入参（按 oneof case）───────────────────
export interface PlayerSlotOut {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
}
export type ServerMsg =
  | { case: 'room_state'; code: string; players: PlayerSlotOut[]; phase: number }
  | {
      case: 'match_start';
      roomId: string;
      mode: number;
      seed: number;
      startFrame: number;
      localSide: number;
      opponentName: string;
      opponentPublicId: string;
      /** 对手佩戴称号 id（空串=无称号；S10）。 */
      opponentTitle?: string;
    }
  | { case: 'frame_batch'; toFrame: number; frames: FrameCmds[] }
  | {
      case: 'conn_resync';
      seed: number;
      startFrame: number;
      log: FrameCmds[];
      curFrame: number;
    }
  | { case: 'peer_dc'; side: number; graceMs: number }
  | {
      case: 'match_over';
      winnerSide: number;
      reason: string;
      mismatch: boolean;
      elo?: { delta: number; after: number; rankAfter: string };
    }
  | { case: 'room_error'; code: string; message: string }
  | { case: 'pong' };

// ── 加载 transport.proto（候选路径，兼容 dev/dist/docker）──
function resolveProtoPath(): string {
  const envDir = process.env.NW_CONTRACTS_DIR;
  const candidates = [
    envDir ? path.join(envDir, 'transport.proto') : null,
    // dev (tsx, src/proto) 与 dist (dist/proto) 均回到 server/contracts
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
  keepCase: true, // 保留 proto 原始 snake_case 字段名，避免歧义
}).root;

const Envelope = root.lookupType('nw.transport.Envelope');

/**
 * S9-6: 防御性解析 match_result.stats_json（客户端上报的本局成就计数）。
 * 仅接受 `{ [k:string]: number }` 形态；任何异常 → undefined（gameserver 透传，meta 再做 L1 校验）。
 */
function parseStatsJson(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

// ── 解码：bytes → ClientMsg ──────────────────────────────
export function decodeClient(buf: Uint8Array): ClientMsg {
  const env = Envelope.decode(buf) as protobuf.Message & Record<string, unknown>;
  // Envelope.oneof = 'msg'；只处理 client 方向
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
    case 'cmd_submit':
      return {
        case: 'cmd_submit',
        commands: (get('cmd_submit')['commands'] as Uint8Array) ?? new Uint8Array(0),
      };
    case 'match_result':
      return {
        case: 'match_result',
        stateHash: String(get('match_result')['state_hash'] ?? ''),
        winnerSide: Number(get('match_result')['winner_side'] ?? 0),
        // S9-6: 本方本局成就计数（JSON 字符串）。防御性解析；非法/缺失 → undefined（meta 视无统计）。
        stats: parseStatsJson(get('match_result')['stats_json']),
      };
    case 'conn_resume':
      return {
        case: 'conn_resume',
        roomId: String(get('conn_resume')['room_id'] ?? ''),
        lastFrame: Number(get('conn_resume')['last_frame'] ?? 0),
      };
    case 'ping':
      return { case: 'ping' };
    default:
      return { case: 'unknown' };
  }
}

// ── 编码：ServerMsg → bytes ──────────────────────────────
function framesToWire(frames: FrameCmds[]): unknown[] {
  return frames.map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((s) => ({ side: s.side, commands: s.commands })),
  }));
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
          })),
          phase: msg.phase,
        },
      };
      break;
    case 'match_start':
      server = {
        match_start: {
          room_id: msg.roomId,
          mode: msg.mode,
          seed: msg.seed,
          start_frame: msg.startFrame,
          local_side: msg.localSide,
          opponent_name: msg.opponentName,
          opponent_public_id: msg.opponentPublicId,
          ...(msg.opponentTitle ? { opponent_title: msg.opponentTitle } : {}),
        },
      };
      break;
    case 'frame_batch':
      server = {
        frame_batch: { to_frame: msg.toFrame, frames: framesToWire(msg.frames) },
      };
      break;
    case 'conn_resync':
      server = {
        conn_resync: {
          seed: msg.seed,
          start_frame: msg.startFrame,
          log: framesToWire(msg.log),
          cur_frame: msg.curFrame,
        },
      };
      break;
    case 'peer_dc':
      server = { peer_dc: { side: msg.side, grace_ms: msg.graceMs } };
      break;
    case 'match_over':
      server = {
        match_over: {
          winner_side: msg.winnerSide,
          reason: msg.reason,
          mismatch: msg.mismatch,
          ...(msg.elo
            ? {
                elo: {
                  delta: msg.elo.delta,
                  after: msg.elo.after,
                  rank_after: msg.elo.rankAfter,
                },
              }
            : {}),
        },
      };
      break;
    case 'room_error':
      server = { room_error: { code: msg.code, message: msg.message } };
      break;
    case 'pong':
      server = { pong: {} };
      break;
  }
  const env = Envelope.fromObject({ server });
  return Envelope.encode(env).finish();
}

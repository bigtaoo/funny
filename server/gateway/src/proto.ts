// 控制面 transport.proto 编解码（gateway 侧，M20）。契约单一来源 =
// ../../contracts/transport.proto（与 gameserver / 客户端同一份），运行期 protobufjs 解析。
//
// gateway 只认控制面子集：解码 room_create/join/ready/start/leave + ping；
// 编码 room_state / room_error / match_found / pong。锁步消息（cmd_submit /
// frame_batch / conn_* / match_*）属数据面，由 gameserver 处理，这里解码成 'unknown' 忽略。
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
  | { case: 'unknown' };

export interface PlayerSlotOut {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
}
export type ServerMsg =
  | { case: 'room_state'; code: string; players: PlayerSlotOut[]; phase: number }
  | { case: 'match_found'; gameUrl: string; ticket: string }
  | { case: 'room_error'; code: string; message: string }
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
          })),
          phase: msg.phase,
        },
      };
      break;
    case 'match_found':
      server = { match_found: { game_url: msg.gameUrl, ticket: msg.ticket } };
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

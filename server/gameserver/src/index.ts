// gameserver 引导骨架（S1）。WS 接入 + JWT 握手鉴权 + RoomRegistry 口子已就位；
// room-service / 节拍器中继 / 重连（S1-1~5）随 S1 落地。
// 反代将 /ws 转到本进程（SERVER_API.md §0）。
import { WebSocketServer, type WebSocket } from 'ws';
import {
  InMemoryRoomRegistry,
  loadServerEnv,
  verifyToken,
  type RoomRegistry,
} from '@nw/shared';

const env = loadServerEnv();
const PORT = Number(process.env.NW_GAME_PORT ?? 8081);
const HOST = process.env.NW_GAME_HOST ?? '0.0.0.0';

// v1 内存实现；扩展时换 Redis（META_DESIGN.md §6.5）。
const rooms: RoomRegistry = new InMemoryRoomRegistry();

const wss = new WebSocketServer({ host: HOST, port: PORT, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  // 握手鉴权：?token=<jwt>（SERVER_API.md §1.1）。
  const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
  const token = url.searchParams.get('token');
  let accountId: string;
  try {
    accountId = verifyToken(token ?? '', { secret: env.jwtSecret });
  } catch {
    ws.close(4401, 'unauthenticated');
    return;
  }

  // TODO(S1): protobuf Envelope 编解码 + room/锁步中继 + 心跳 + 重连。
  console.log(`[gameserver] connected account=${accountId}`);
  ws.on('close', () => console.log(`[gameserver] disconnected account=${accountId}`));
});

void rooms; // 占位：S1 room-service 使用
console.log(`gameserver (skeleton) listening on ws://${HOST}:${PORT}/ws`);

// gameserver 进程引导（S1-1~5）：WS 接入 + JWT 握手 + 心跳 + 房间/锁步中继。
// 反代将 /ws 转到本进程（SERVER_API.md §0）。
import { WebSocketServer, type WebSocket } from 'ws';
import {
  InMemoryRoomRegistry,
  createMongo,
  verifyToken,
  type Collections,
  type RoomRegistry,
} from '@nw/shared';
import { loadGameEnv } from './config';
import { Connection } from './Connection';
import { RoomManager } from './RoomManager';
import { decodeClient } from './proto/transport';

const HEARTBEAT_MS = 30_000; // 心跳巡检：两轮无响应（无 pong/消息）判死

// 在 ws 上挂 Connection 引用，供心跳巡检反查。
const CONN = Symbol('nwConn');
type WsWithConn = WebSocket & { [CONN]?: Connection };

async function main(): Promise<void> {
  const env = loadGameEnv();

  // Mongo 仅用于对局归档（S1-5）；不可用时降级为纯中继。
  let cols: Collections | null = null;
  if (!env.disableMongo) {
    try {
      const mongo = await createMongo(env.mongoUri, env.mongoDb);
      await mongo.ensureIndexes();
      cols = mongo.collections;
      console.log('[gameserver] mongo connected (match archival on)');
    } catch (e) {
      console.warn('[gameserver] mongo unavailable, archival disabled:', (e as Error).message);
    }
  }

  // v1 内存实现；扩展时换 Redis（META_DESIGN.md §6.5）。
  const registry: RoomRegistry = new InMemoryRoomRegistry();
  const manager = new RoomManager(registry, cols);

  const wss = new WebSocketServer({ host: env.host, port: env.port, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    // 握手鉴权：?token=<jwt>（SERVER_API.md §1.1）
    const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
    const token = url.searchParams.get('token');
    let accountId: string;
    try {
      accountId = verifyToken(token ?? '', { secret: env.jwtSecret });
    } catch {
      ws.close(4401, 'unauthenticated');
      return;
    }

    const conn = new Connection(accountId, ws);
    conn.alive = true;
    (ws as WsWithConn)[CONN] = conn;
    manager.register(conn);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      conn.alive = true;
      if (!isBinary) return; // 协议是二进制 protobuf
      let msg;
      try {
        msg = decodeClient(new Uint8Array(data));
      } catch {
        return; // 坏帧丢弃
      }
      manager.handle(conn, msg);
    });
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => manager.onClose(conn));
    ws.on('error', () => {
      /* close 随后触发，统一在那里收口 */
    });
  });

  // 心跳巡检：上轮 alive 置 false，本轮仍 false ⇒ 判死断开；否则发 ping。
  const conns = (): Connection[] =>
    [...wss.clients].map((ws) => (ws as WsWithConn)[CONN]).filter((c): c is Connection => !!c);
  const heartbeat = setInterval(() => {
    for (const conn of conns()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));

  const shutdown = (): void => {
    clearInterval(heartbeat);
    wss.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`gameserver listening on ws://${env.host}:${env.port}/ws`);
}

main().catch((e) => {
  console.error('gameserver failed to start:', e);
  process.exit(1);
});

// gameserver 环境变量（复用 @nw/shared ServerEnv）。瘦身后（M16）不再连 Mongo：
// 身份由 ticket（internalKey 验签）确定，局末结果 POST 给 meta（metaBaseUrl）。
import { loadServerEnv, type ServerEnv } from '@nw/shared';
import { randomUUID } from 'crypto';

export interface GameEnv extends ServerEnv {
  port: number;
  host: string;
  /** meta REST 内部基址（局末上报 POST {metaBaseUrl}/internal/match/report）。null = 不上报。 */
  metaBaseUrl: string | null;
  /** 本实例对客户端公开的 WS 地址（写进 ticket.game_url；向 gateway 注册用）。 */
  publicWsUrl: string | null;
  /** gateway 内部 HTTP 基址（启动注册 + 心跳）。null = 不注册（gateway 用静态兜底地址）。 */
  gatewayInternalUrl: string | null;
  /** 本实例 id（注册标识）。 */
  gameId: string;
  /** 并发对局容量（分配权重）。 */
  capacity: number;
}

export function loadGameEnv(): GameEnv {
  return {
    ...loadServerEnv(),
    port: Number(process.env.NW_GAME_PORT ?? 8081),
    host: process.env.NW_GAME_HOST ?? '0.0.0.0',
    metaBaseUrl: process.env.NW_META_BASE_URL ?? null,
    publicWsUrl: process.env.NW_GAME_PUBLIC_WS_URL ?? null,
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL ?? null,
    gameId: process.env.NW_GAME_ID ?? randomUUID(),
    capacity: Number(process.env.NW_GAME_CAPACITY ?? 100),
  };
}

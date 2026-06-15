// Match ticket（M18，S1-M）：matchsvc 签、gameserver 验。
//
// 配对 / 房主开局后，matchsvc 给每位玩家签一张 ticket（HMAC-JWT，密钥 = NW_INTERNAL_KEY），
// 经 gateway 推给客户端（match_found）。客户端拿 ticket 连 game 数据面 WS（?ticket=<jwt>）；
// gameserver 只验签 + 交叉核对两张 ticket 的 room_id/seed 一致即开局，不查任何库（M16）。
//
// 设计基准：SERVER_API.md §8.2、MATCHSVC_DESIGN.md §2.4。
import jwt from 'jsonwebtoken';

export interface TicketClaims {
  /** 对局 id（双方 ticket 同 id；game 交叉核对一致才开局）。 */
  roomId: string;
  /** 确定性内核种子（双方 ticket 同 seed）。 */
  seed: number;
  /** 本方阵营（→ match_start.local_side）。 */
  side: 0 | 1;
  mode: 'friendly' | 'ranked';
  /** 对手展示名（UI 用）。 */
  opponent: string;
  /** 对手 9 位数字公开 id（UI 用，纯展示；缺省空串）。 */
  opponentPublicId: string;
  /** 分配到的 gameserver 公开 WS 地址（写进 match_found.game_url）。 */
  gameUrl: string;
  /**
   * 本方 accountId。gameserver 局末上报 meta 结算 ELO 需按 side → accountId 写 saves.pvp；
   * 服务器逻辑无关（M16），accountId 仅作上报标识透传，不读库。
   */
  accountId: string;
}

interface TicketPayload extends TicketClaims {
  /** 过期时间戳（秒，jwt 标准 exp）。 */
  exp: number;
}

export interface TicketConfig {
  /** 共用内部密钥（ServerEnv.internalKey）。 */
  key: string;
  /** 有效期秒数（match_found 到连上 game 的容忍窗口）。默认 30s。 */
  ttlSec?: number;
}

/** 签一张 ticket（HMAC-SHA256 JWT）。 */
export function signTicket(claims: TicketClaims, cfg: TicketConfig): string {
  const ttl = cfg.ttlSec ?? 30;
  return jwt.sign(claims, cfg.key, { expiresIn: ttl });
}

/**
 * 验签并取出 claims。`ignoreExpiration` 为 true 时只校验签名、不看 exp——
 * 重连（conn_resume）时复用同一张 ticket，对局已活，exp 仅约束首次握手，
 * 故重连握手放过过期但签名仍有效的 ticket（首连由 RoomManager 自行查 exp）。
 * 失败抛错（调用方关连接）。
 */
export function verifyTicket(
  token: string,
  cfg: TicketConfig,
  opts: { ignoreExpiration?: boolean } = {},
): TicketPayload {
  const decoded = jwt.verify(token, cfg.key, {
    ignoreExpiration: opts.ignoreExpiration ?? false,
  });
  if (
    typeof decoded === 'string' ||
    typeof decoded.roomId !== 'string' ||
    typeof decoded.seed !== 'number' ||
    (decoded.side !== 0 && decoded.side !== 1)
  ) {
    throw new Error('invalid ticket payload');
  }
  return decoded as TicketPayload;
}

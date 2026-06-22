// 统一响应包络 + 错误码（SERVER_API.md §1.2 / §1.3）。

export type ApiResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export const ErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  REV_CONFLICT: 'REV_CONFLICT',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  DAILY_CAP_REACHED: 'DAILY_CAP_REACHED',
  INVALID_RECEIPT: 'INVALID_RECEIPT',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
  // —— 账号系统（SA-1/SA-2）——
  LOGIN_ID_TAKEN: 'LOGIN_ID_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  ALREADY_BOUND: 'ALREADY_BOUND',
  OAUTH_FAILED: 'OAUTH_FAILED',
  // —— 社交系统（S6，SOCIAL_DESIGN §5）——
  FRIEND_CAP_REACHED: 'FRIEND_CAP_REACHED',
  ALREADY_FRIEND: 'ALREADY_FRIEND',
  NOT_FRIEND: 'NOT_FRIEND',
  BLOCKED: 'BLOCKED',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  NO_ATTACHMENT: 'NO_ATTACHMENT',
  // —— SLG 大世界（S8，SLG_DESIGN §14.7）——
  WORLD_FULL: 'WORLD_FULL',
  WORLD_CLOSED: 'WORLD_CLOSED',
  TILE_NOT_OWNED: 'TILE_NOT_OWNED',
  TILE_OCCUPIED: 'TILE_OCCUPIED',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  NO_TROOPS: 'NO_TROOPS',
  TROOP_CAP_REACHED: 'TROOP_CAP_REACHED',
  PROTECTED: 'PROTECTED',
  MARCH_NOT_FOUND: 'MARCH_NOT_FOUND',
  FAMILY_FULL: 'FAMILY_FULL',
  NOT_IN_FAMILY: 'NOT_IN_FAMILY',
  ALREADY_IN_FAMILY: 'ALREADY_IN_FAMILY',
  AUCTION_NOT_FOUND: 'AUCTION_NOT_FOUND',
  AUCTION_CLOSED: 'AUCTION_CLOSED',
  NOT_DESIGNATED_BUYER: 'NOT_DESIGNATED_BUYER',
  INSUFFICIENT_RESOURCES: 'INSUFFICIENT_RESOURCES',
  AUCTION_LIMIT_REACHED: 'AUCTION_LIMIT_REACHED',
  // —— S8-5 拍卖行反 RMT 缺口（C/E/G/B）——
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE',       // G 价格护栏：单价越界
  MATERIAL_NOT_TRADEABLE: 'MATERIAL_NOT_TRADEABLE', // E 绑定材料禁挂
  BID_TOO_LOW: 'BID_TOO_LOW',                      // B 竞拍：出价低于起拍/加价幅度
  NO_PERMISSION: 'NO_PERMISSION',
  // —— S8-6.6 A* 寻路 ——
  PATH_BLOCKED: 'PATH_BLOCKED',
  // —— S8-4b 宗门（Sect）——
  SECT_FULL: 'SECT_FULL',
  NOT_IN_SECT: 'NOT_IN_SECT',
  ALREADY_IN_SECT: 'ALREADY_IN_SECT',
  ALLY_CAP_REACHED: 'ALLY_CAP_REACHED',
  // —— G2 繁荣度（建宗门门槛，§17.4）——
  PROSPERITY_TOO_LOW: 'PROSPERITY_TOO_LOW',
  // —— 装备系统（E2 合成 + 拍卖装备交易，EQUIPMENT_DESIGN §4.A/§18）——
  INSUFFICIENT_MATERIALS: 'INSUFFICIENT_MATERIALS', // 合成材料不足
  INVENTORY_FULL: 'INVENTORY_FULL',                 // 装备库存达 300 上限
  EQUIP_NOT_FOUND: 'EQUIP_NOT_FOUND',               // 装备实例不存在
  EQUIP_LOCKED: 'EQUIP_LOCKED',                     // 装备被锁（防误用为燃料）→ 不可挂拍/分解
  EQUIP_IN_USE: 'EQUIP_IN_USE',                     // 装备穿戴中 → 不可挂拍/分解
  // —— 装备 E3 强化/分解 + E4 穿戴（EQUIPMENT_DESIGN §6/§18）——
  ENHANCE_MAX_LEVEL: 'ENHANCE_MAX_LEVEL',           // 已 +9 满级，不可再强化
  NOT_SALVAGEABLE: 'NOT_SALVAGEABLE',               // 不可分解（+5 及以上，§6.3）
  INVALID_SLOT: 'INVALID_SLOT',                     // 穿戴槽位与装备定义槽位不匹配
  // —— PvE 反作弊（S4-4）——
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',                 // 录像复算三次拒绝封号
  // —— 合规（C5）——
  ACCOUNT_DELETED: 'ACCOUNT_DELETED',               // 软删除账号，auth 返 410
  // —— 体力系统（A4）——
  INSUFFICIENT_STAMINA: 'INSUFFICIENT_STAMINA',     // 体力不足，无法进关
  // —— 社交频道（B7）——
  NOT_IN_WORLD: 'NOT_IN_WORLD',                     // 玩家尚未入驻该世界（无 playerWorld 记录）
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function err(code: ErrorCode, message: string): {
  ok: false;
  error: { code: string; message: string };
} {
  return { ok: false, error: { code, message } };
}

/** HTTP 状态码 → 错误码的约定映射（SERVER_API.md §2 标注的状态码）。 */
export const ERROR_HTTP_STATUS: Record<string, number> = {
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.REV_CONFLICT]: 409,
  [ErrorCode.INSUFFICIENT_FUNDS]: 402,
  [ErrorCode.DAILY_CAP_REACHED]: 429,
  [ErrorCode.INVALID_RECEIPT]: 400,
  [ErrorCode.ROOM_NOT_FOUND]: 404,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ROOM_FULL]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.NOT_IMPLEMENTED]: 501,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.INTERNAL]: 500,
  [ErrorCode.LOGIN_ID_TAKEN]: 409,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.WEAK_PASSWORD]: 400,
  [ErrorCode.ALREADY_BOUND]: 409,
  [ErrorCode.OAUTH_FAILED]: 400,
  [ErrorCode.FRIEND_CAP_REACHED]: 409,
  [ErrorCode.ALREADY_FRIEND]: 409,
  [ErrorCode.NOT_FRIEND]: 403,
  [ErrorCode.BLOCKED]: 403,
  [ErrorCode.ALREADY_CLAIMED]: 409,
  [ErrorCode.NO_ATTACHMENT]: 400,
  [ErrorCode.WORLD_FULL]: 409,
  [ErrorCode.WORLD_CLOSED]: 409,
  [ErrorCode.TILE_NOT_OWNED]: 403,
  [ErrorCode.TILE_OCCUPIED]: 409,
  [ErrorCode.OUT_OF_RANGE]: 400,
  [ErrorCode.NO_TROOPS]: 409,
  [ErrorCode.TROOP_CAP_REACHED]: 409,
  [ErrorCode.PROTECTED]: 403,
  [ErrorCode.MARCH_NOT_FOUND]: 404,
  [ErrorCode.FAMILY_FULL]: 409,
  [ErrorCode.NOT_IN_FAMILY]: 403,
  [ErrorCode.ALREADY_IN_FAMILY]: 409,
  [ErrorCode.AUCTION_NOT_FOUND]: 404,
  [ErrorCode.AUCTION_CLOSED]: 409,
  [ErrorCode.NOT_DESIGNATED_BUYER]: 403,
  [ErrorCode.INSUFFICIENT_RESOURCES]: 402,
  [ErrorCode.AUCTION_LIMIT_REACHED]: 409,
  [ErrorCode.PRICE_OUT_OF_RANGE]: 400,
  [ErrorCode.MATERIAL_NOT_TRADEABLE]: 400,
  [ErrorCode.BID_TOO_LOW]: 400,
  [ErrorCode.NO_PERMISSION]: 403,
  [ErrorCode.PATH_BLOCKED]: 400,
  [ErrorCode.SECT_FULL]: 409,
  [ErrorCode.NOT_IN_SECT]: 403,
  [ErrorCode.ALREADY_IN_SECT]: 409,
  [ErrorCode.ALLY_CAP_REACHED]: 409,
  [ErrorCode.PROSPERITY_TOO_LOW]: 400,
  [ErrorCode.INSUFFICIENT_MATERIALS]: 402,
  [ErrorCode.INVENTORY_FULL]: 409,
  [ErrorCode.EQUIP_NOT_FOUND]: 404,
  [ErrorCode.EQUIP_LOCKED]: 409,
  [ErrorCode.EQUIP_IN_USE]: 409,
  [ErrorCode.ENHANCE_MAX_LEVEL]: 409,
  [ErrorCode.NOT_SALVAGEABLE]: 409,
  [ErrorCode.INVALID_SLOT]: 400,
  [ErrorCode.ACCOUNT_BANNED]: 403,
  [ErrorCode.INSUFFICIENT_STAMINA]: 402,
  [ErrorCode.NOT_IN_WORLD]: 403,
};

// Unified response envelope + error codes (SERVER_API.md §1.2 / §1.3).

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
  // —— account system (SA-1/SA-2) ——
  LOGIN_ID_TAKEN: 'LOGIN_ID_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  ALREADY_BOUND: 'ALREADY_BOUND',
  OAUTH_FAILED: 'OAUTH_FAILED',
  // —— social system (S6, SOCIAL_DESIGN §5) ——
  FRIEND_CAP_REACHED: 'FRIEND_CAP_REACHED',
  ALREADY_FRIEND: 'ALREADY_FRIEND',
  NOT_FRIEND: 'NOT_FRIEND',
  BLOCKED: 'BLOCKED',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  NO_ATTACHMENT: 'NO_ATTACHMENT',
  // —— SLG world map (S8, SLG_DESIGN §14.7) ——
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
  // —— S8-5 auction house anti-RMT gaps (C/E/G/B) ——
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE',       // G price guardrail: unit price out of range
  MATERIAL_NOT_TRADEABLE: 'MATERIAL_NOT_TRADEABLE', // E bound material may not be listed
  BID_TOO_LOW: 'BID_TOO_LOW',                      // B auction bid: bid below starting price or minimum increment
  NO_PERMISSION: 'NO_PERMISSION',
  // —— S8-6.6 A* pathfinding ——
  PATH_BLOCKED: 'PATH_BLOCKED',
  // —— S8-4b Sect ——
  SECT_FULL: 'SECT_FULL',
  NOT_IN_SECT: 'NOT_IN_SECT',
  ALREADY_IN_SECT: 'ALREADY_IN_SECT',
  ALLY_CAP_REACHED: 'ALLY_CAP_REACHED',
  // —— G2 prosperity (sect founding threshold, §17.4) ——
  PROSPERITY_TOO_LOW: 'PROSPERITY_TOO_LOW',
  // —— equipment system (E2 crafting + auction equipment trading, EQUIPMENT_DESIGN §4.A/§18) ——
  INSUFFICIENT_MATERIALS: 'INSUFFICIENT_MATERIALS', // insufficient crafting materials
  INVENTORY_FULL: 'INVENTORY_FULL',                 // equipment inventory at 300-item cap
  EQUIP_NOT_FOUND: 'EQUIP_NOT_FOUND',               // equipment instance not found
  EQUIP_LOCKED: 'EQUIP_LOCKED',                     // equipment is locked (to prevent accidental use as fuel) → may not be listed/salvaged
  EQUIP_IN_USE: 'EQUIP_IN_USE',                     // equipment is equipped → may not be listed/salvaged
  // —— equipment E3 enhancement/salvage + E4 equip (EQUIPMENT_DESIGN §6/§18) ——
  ENHANCE_MAX_LEVEL: 'ENHANCE_MAX_LEVEL',           // already at +9 max level, cannot enhance further
  NOT_SALVAGEABLE: 'NOT_SALVAGEABLE',               // not salvageable (+5 and above, §6.3)
  INVALID_SLOT: 'INVALID_SLOT',                     // equip slot does not match the equipment's defined slot
  // —— character card system (CC-5, CHARACTER_CARDS_DESIGN §11) ——
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',                 // card instance not found in cardInv
  CARD_HAS_GEAR: 'CARD_HAS_GEAR',                   // card has equipped gear; must unequip before listing on auction
  // —— PvE anti-cheat (S4-4) ——
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',                 // replay re-computation rejected three times — account banned
  // —— compliance (C5) ——
  ACCOUNT_DELETED: 'ACCOUNT_DELETED',               // soft-deleted account; auth returns 410
  // —— stamina system (A4) ——
  INSUFFICIENT_STAMINA: 'INSUFFICIENT_STAMINA',     // insufficient stamina to enter a stage
  // —— social channel (B7) ——
  NOT_IN_WORLD: 'NOT_IN_WORLD',                     // player has not yet joined this world (no playerWorld record)
  // —— gacha monetization (GACHA_DESIGN §2/§6/§7) ——
  POOL_UNAVAILABLE: 'POOL_UNAVAILABLE',             // gacha pool unknown or a limited pool outside its open window
  FATE_INSUFFICIENT: 'FATE_INSUFFICIENT',           // not enough Fate Points to redeem (§7)
  FATE_INVALID_ITEM: 'FATE_INVALID_ITEM',           // fate redemption target is not a (past-)featured limited legendary
  ALREADY_PURCHASED: 'ALREADY_PURCHASED',           // one-off starter pack already bought (§6)
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

/** Conventional mapping from HTTP status codes to error codes (status codes noted in SERVER_API.md §2). */
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
  [ErrorCode.CARD_NOT_FOUND]: 404,
  [ErrorCode.CARD_HAS_GEAR]: 409,
  [ErrorCode.POOL_UNAVAILABLE]: 404,
  [ErrorCode.FATE_INSUFFICIENT]: 402,
  [ErrorCode.FATE_INVALID_ITEM]: 400,
  [ErrorCode.ALREADY_PURCHASED]: 409,
};

// 账号解析（S0-4 / S0-7）+ 密码账号（SA-1）。
// 匿名 device/wx → 稳定 accountId；密码注册/登录/改密。
import { randomUUID, randomInt } from 'node:crypto';
import type { Collections, ChatRegion } from '@nw/shared';
import {
  hashPassword,
  isAnonymousAccount,
  normalizeLoginId,
  verifyPassword,
} from '@nw/shared';

/**
 * auth 时把惰性推断出的合规地区写回账号（best-effort，私聊敏感词分地区选词表用）。
 * 仅当 region 非 `global` 时写入——无 Accept-Language 信号的请求不把已探明的真实地区降级。
 */
async function touchRegion(cols: Collections, accountId: string, region: ChatRegion): Promise<void> {
  if (region === 'global') return;
  await cols.accounts.updateOne({ _id: accountId }, { $set: { region } });
}

export interface ResolvedAccount {
  accountId: string;
  isNew: boolean;
  isAnonymous: boolean;
  /** 展示名（注册时填）；用于客户端个人资料显示，缺省 undefined。 */
  displayName?: string;
  /** 9 位数字公开 id（由 {@link ensurePublicId} 惰性生成后回填）。 */
  publicId?: string;
}

/** 按 deviceId 取/建账号（Web / CrazyGames）。同设备稳定返回同 id。 */
export async function resolveByDevice(
  cols: Collections,
  deviceId: string,
  now: number,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ deviceId });
  if (existing) {
    await touchRegion(cols, existing._id, region);
    return { accountId: existing._id, isNew: false, isAnonymous: isAnonymousAccount(existing), displayName: existing.displayName };
  }

  const accountId = randomUUID();
  // deviceId 唯一索引：并发首建只有一个插入成功，另一个回读。
  await cols.accounts.updateOne(
    { deviceId },
    {
      $setOnInsert: { _id: accountId, deviceId, createdAt: now },
      ...(region !== 'global' ? { $set: { region } } : {}),
    },
    { upsert: true },
  );
  const doc = await cols.accounts.findOne({ deviceId });
  const isNew = doc?._id === accountId;
  // device-only 账号 = 匿名；若该 device 已绑过凭证则取实际值。
  return {
    accountId: doc ? doc._id : accountId,
    isNew,
    isAnonymous: doc ? isAnonymousAccount(doc) : true,
  };
}

/** 按 openid 取/建账号（微信）。微信 = 可恢复凭证，非匿名。 */
export async function resolveByOpenid(
  cols: Collections,
  openid: string,
  now: number,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ openid });
  if (existing) {
    await touchRegion(cols, existing._id, region);
    return { accountId: existing._id, isNew: false, isAnonymous: isAnonymousAccount(existing), displayName: existing.displayName };
  }

  const accountId = randomUUID();
  await cols.accounts.updateOne(
    { openid },
    {
      $setOnInsert: { _id: accountId, openid, createdAt: now },
      ...(region !== 'global' ? { $set: { region } } : {}),
    },
    { upsert: true },
  );
  const doc = await cols.accounts.findOne({ openid });
  return {
    accountId: doc ? doc._id : accountId,
    isNew: doc?._id === accountId,
    isAnonymous: doc ? isAnonymousAccount(doc) : false,
  };
}

export type RegisterResult =
  | { kind: 'ok'; account: ResolvedAccount }
  | { kind: 'taken' };

/**
 * 密码注册（SA-1）。建一个**新** account（不绑当前匿名账号——转正合并由客户端
 * 登录后走 SaveManager.reconcile，ACCOUNT_DESIGN §4.4）。loginId 规范化后唯一。
 */
export async function registerWithPassword(
  cols: Collections,
  loginId: string,
  password: string,
  displayName: string | undefined,
  now: number,
  region: ChatRegion = 'global',
): Promise<RegisterResult> {
  const norm = normalizeLoginId(loginId);
  const hash = await hashPassword(password);
  const accountId = randomUUID();
  // 唯一索引 'password.loginId' 守卫：upsert 命中已存在则未插入 → taken。
  const res = await cols.accounts.updateOne(
    { 'password.loginId': norm },
    {
      $setOnInsert: {
        _id: accountId,
        createdAt: now,
        password: { loginId: norm, hash },
        ...(displayName ? { displayName } : {}),
        ...(region !== 'global' ? { region } : {}),
      },
    },
    { upsert: true },
  );
  if (!res.upsertedId) return { kind: 'taken' };
  return { kind: 'ok', account: { accountId, isNew: true, isAnonymous: false, displayName } };
}

/** 密码登录（SA-1）。loginId 规范化匹配 + 哈希比对。 */
export async function loginWithPassword(
  cols: Collections,
  loginId: string,
  password: string,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount | null> {
  const norm = normalizeLoginId(loginId);
  const doc = await cols.accounts.findOne({ 'password.loginId': norm });
  if (!doc?.password) return null;
  const ok = await verifyPassword(password, doc.password.hash);
  if (!ok) return null;
  await touchRegion(cols, doc._id, region);
  return { accountId: doc._id, isNew: false, isAnonymous: isAnonymousAccount(doc), displayName: doc.displayName };
}

/** 读账号合规地区（私聊敏感词选词表用）。缺省 / 旧账号无字段 → `'global'`。 */
export async function getRegion(cols: Collections, accountId: string): Promise<ChatRegion> {
  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { region: 1 } });
  return doc?.region ?? 'global';
}

/** 读账号展示名（GET /save 顺带回带，token 续登恢复个人资料）。 */
export async function getDisplayName(
  cols: Collections,
  accountId: string,
): Promise<string | undefined> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  return doc?.displayName;
}

/**
 * 公开资料（展示名 + 9 位数字公开 id）。gateway 据此把房间里的玩家显示为昵称（#id），
 * 而非 accountId。publicId 缺失时惰性生成。
 */
export async function getProfile(
  cols: Collections,
  accountId: string,
): Promise<{ displayName?: string; publicId: string; equippedTitle?: string }> {
  const [doc, saveDoc, publicId] = await Promise.all([
    cols.accounts.findOne({ _id: accountId }),
    cols.saves.findOne({ _id: accountId }, { projection: { 'save.equipped': 1 } }),
    ensurePublicId(cols, accountId),
  ]);
  const equippedTitle = (saveDoc?.save.equipped as Record<string, string> | undefined)?.['title'];
  return {
    ...(doc?.displayName ? { displayName: doc.displayName } : {}),
    publicId,
    ...(equippedTitle ? { equippedTitle } : {}),
  };
}

/**
 * 确保账号有 9 位数字公开 id：已有直接返回，否则生成一个全局唯一的并写入。
 * publicId 唯一索引在并发/碰撞时会让 updateOne 抛错 → 重试换号；900M 空间下碰撞极罕见。
 */
export async function ensurePublicId(cols: Collections, accountId: string): Promise<string> {
  const existing = await cols.accounts.findOne({ _id: accountId }, { projection: { publicId: 1 } });
  if (existing?.publicId) return existing.publicId;
  for (let attempt = 0; attempt < 8; attempt++) {
    // 100000000–999999999：定长 9 位，首位非 0。
    const candidate = String(randomInt(100_000_000, 1_000_000_000));
    try {
      // 仅当本账号尚无 publicId 时写入；唯一索引守卫跨账号不撞号。
      const res = await cols.accounts.updateOne(
        { _id: accountId, publicId: { $exists: false } },
        { $set: { publicId: candidate } },
      );
      if (res.modifiedCount === 1) return candidate;
      // 没改到：可能并发已写入 → 回读取真实值。
      const now = await cols.accounts.findOne({ _id: accountId }, { projection: { publicId: 1 } });
      if (now?.publicId) return now.publicId;
    } catch {
      // 唯一索引碰撞（candidate 已被别的账号占用）→ 换号重试。
    }
  }
  throw new Error('failed to allocate publicId after retries');
}

/** 按 9 位公开 id 反查 accountId（admin player.lookup，OPS_DESIGN §4.1）。未找到 null。 */
export async function resolveByPublicId(
  cols: Collections,
  publicId: string,
): Promise<string | null> {
  const doc = await cols.accounts.findOne({ publicId }, { projection: { _id: 1 } });
  return doc?._id ?? null;
}

/** 改展示名（改名功能，已扣币后写入）。 */
export async function setDisplayName(
  cols: Collections,
  accountId: string,
  displayName: string,
): Promise<void> {
  await cols.accounts.updateOne({ _id: accountId }, { $set: { displayName } });
}

export type ChangePasswordResult = 'ok' | 'no-password' | 'invalid';

/** 改密（SA-1，需 JWT）。校验旧密码后替换哈希。 */
export async function changePassword(
  cols: Collections,
  accountId: string,
  oldPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  if (!doc?.password) return 'no-password';
  const ok = await verifyPassword(oldPassword, doc.password.hash);
  if (!ok) return 'invalid';
  const hash = await hashPassword(newPassword);
  await cols.accounts.updateOne(
    { _id: accountId },
    { $set: { 'password.hash': hash } },
  );
  return 'ok';
}

/**
 * 微信 code → openid。配置了 NW_WX_APPID/SECRET 走官方 jscode2session；
 * 否则 dev 回退：把 code 直接当 openid（仅本地联调）。
 */
export async function exchangeWxCode(code: string): Promise<string> {
  const appid = process.env.NW_WX_APPID;
  const secret = process.env.NW_WX_SECRET;
  if (!appid || !secret) {
    return `dev-openid:${code}`;
  }
  const url =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}` +
    `&secret=${secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const body = (await resp.json()) as { openid?: string; errcode?: number; errmsg?: string };
  if (!body.openid) {
    throw new Error(`wx jscode2session failed: ${body.errcode} ${body.errmsg}`);
  }
  return body.openid;
}

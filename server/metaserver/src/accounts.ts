// 账号解析（S0-4 / S0-7）+ 密码账号（SA-1）。
// 匿名 device/wx → 稳定 accountId；密码注册/登录/改密。
import { randomUUID } from 'node:crypto';
import type { Collections } from '@nw/shared';
import {
  hashPassword,
  isAnonymousAccount,
  normalizeLoginId,
  verifyPassword,
} from '@nw/shared';

export interface ResolvedAccount {
  accountId: string;
  isNew: boolean;
  isAnonymous: boolean;
  /** 展示名（注册时填）；用于客户端个人资料显示，缺省 undefined。 */
  displayName?: string;
}

/** 按 deviceId 取/建账号（Web / CrazyGames）。同设备稳定返回同 id。 */
export async function resolveByDevice(
  cols: Collections,
  deviceId: string,
  now: number,
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ deviceId });
  if (existing) return { accountId: existing._id, isNew: false, isAnonymous: isAnonymousAccount(existing), displayName: existing.displayName };

  const accountId = randomUUID();
  // deviceId 唯一索引：并发首建只有一个插入成功，另一个回读。
  await cols.accounts.updateOne(
    { deviceId },
    { $setOnInsert: { _id: accountId, deviceId, createdAt: now } },
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
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ openid });
  if (existing) return { accountId: existing._id, isNew: false, isAnonymous: isAnonymousAccount(existing), displayName: existing.displayName };

  const accountId = randomUUID();
  await cols.accounts.updateOne(
    { openid },
    { $setOnInsert: { _id: accountId, openid, createdAt: now } },
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
): Promise<ResolvedAccount | null> {
  const norm = normalizeLoginId(loginId);
  const doc = await cols.accounts.findOne({ 'password.loginId': norm });
  if (!doc?.password) return null;
  const ok = await verifyPassword(password, doc.password.hash);
  if (!ok) return null;
  return { accountId: doc._id, isNew: false, isAnonymous: isAnonymousAccount(doc), displayName: doc.displayName };
}

/** 读账号展示名（GET /save 顺带回带，token 续登恢复个人资料）。 */
export async function getDisplayName(
  cols: Collections,
  accountId: string,
): Promise<string | undefined> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  return doc?.displayName;
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

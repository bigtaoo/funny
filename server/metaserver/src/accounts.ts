// 匿名账号解析（S0-4 / S0-7）。openid / deviceId → 稳定 accountId。
import { randomUUID } from 'node:crypto';
import type { Collections } from '@nw/shared';

export interface ResolvedAccount {
  accountId: string;
  isNew: boolean;
}

/** 按 deviceId 取/建账号（Web / CrazyGames）。同设备稳定返回同 id。 */
export async function resolveByDevice(
  cols: Collections,
  deviceId: string,
  now: number,
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ deviceId });
  if (existing) return { accountId: existing._id, isNew: false };

  const accountId = randomUUID();
  // deviceId 唯一索引：并发首建只有一个插入成功，另一个回读。
  await cols.accounts.updateOne(
    { deviceId },
    { $setOnInsert: { _id: accountId, deviceId, createdAt: now } },
    { upsert: true },
  );
  const doc = await cols.accounts.findOne({ deviceId });
  return { accountId: doc ? doc._id : accountId, isNew: doc?._id === accountId };
}

/** 按 openid 取/建账号（微信）。 */
export async function resolveByOpenid(
  cols: Collections,
  openid: string,
  now: number,
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ openid });
  if (existing) return { accountId: existing._id, isNew: false };

  const accountId = randomUUID();
  await cols.accounts.updateOne(
    { openid },
    { $setOnInsert: { _id: accountId, openid, createdAt: now } },
    { upsert: true },
  );
  const doc = await cols.accounts.findOne({ openid });
  return { accountId: doc ? doc._id : accountId, isNew: doc?._id === accountId };
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

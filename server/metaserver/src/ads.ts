// 广告平台验签（C2）。
// 包含：
//   1. verifyAdPlatformToken  — 客户端 POST /ads/reward 的轻量平台令牌验证。
//   2. registerAdCallbackRoutes — AdMob SSV / 微信广告服务端回调（平台主动调用）。
//
// AdMob SSV 流程：
//   客户端展示广告前用 accountId 作 custom_data 注册，广告播完 Google 回调
//   GET /ads/callback/admob?transaction_id=…&custom_data=…&signature=…&key_id=…
//   本模块用 ECDSA-P256 验签（公钥从 Google gstatic 拉取并缓存）后记账发奖。
//
// 微信广告回调（WECHAT_ADS）：
//   POST /ads/callback/wechat  Body: { openid, trans_id, timestamp, nonce, sign }
//   HMAC-SHA256(sort(params_kvs).join('&'), NW_WECHAT_ADS_KEY) 验签。

import { createHash, createVerify, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Collections } from '@nw/shared';
import { ADS_REWARD_COINS, ADS_DAILY_CAP, ADS_MIN_INTERVAL_MS } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { adsDayKey, bumpAdsCap, mirrorCoins, checkAdInterval, recordAdToken, hashAdToken } from './economy.js';

// ── 客户端令牌验签（轻量，服务端无秘钥时可选跳过）────────────────────────────

/**
 * 客户端 `POST /ads/reward` 中 adToken 的平台验签。
 * - `admob_client`：adToken = HMAC-SHA256(transactionId, NW_ADMOB_CLIENT_KEY)
 *   客户端收到广告 SDK transactionId 后，服务端以共享密钥验其一致性。
 * - `wechat_client`：同上，NW_WECHAT_ADS_CLIENT_KEY。
 * - 无对应环境变量时返回 true（降级开放，依靠凭证唯一性 + cap 防刷）。
 */
export function verifyAdPlatformToken(platform: string, adToken: string): boolean {
  if (platform === 'admob_client') {
    const key = process.env.NW_ADMOB_CLIENT_KEY;
    if (!key) return true; // 未配置时放行，依赖幂等 + cap
    const [transId, sig] = adToken.split(':');
    if (!transId || !sig) return false;
    const expected = createHmac('sha256', key).update(transId).digest('hex');
    return expected === sig;
  }
  if (platform === 'wechat_client') {
    const key = process.env.NW_WECHAT_ADS_CLIENT_KEY;
    if (!key) return true;
    const [transId, sig] = adToken.split(':');
    if (!transId || !sig) return false;
    const expected = createHmac('sha256', key).update(transId).digest('hex');
    return expected === sig;
  }
  return false; // 未知平台拒绝
}

// ── AdMob SSV 验签（服务端回调）──────────────────────────────────────────────

interface AdmobKey {
  keyId: number;
  pem: string;
}

// 内存缓存，TTL 5min。
let admobKeysCache: { keys: AdmobKey[]; fetchedAt: number } | null = null;
const ADMOB_KEY_TTL = 5 * 60 * 1000;
const ADMOB_KEY_URL = 'https://gstatic.com/admob/reward/verifier-keys.json';

async function getAdmobKeys(): Promise<AdmobKey[]> {
  const now = Date.now();
  if (admobKeysCache && now - admobKeysCache.fetchedAt < ADMOB_KEY_TTL) {
    return admobKeysCache.keys;
  }
  const resp = await fetch(ADMOB_KEY_URL);
  if (!resp.ok) throw new Error(`admob keys fetch HTTP ${resp.status}`);
  const json = (await resp.json()) as { keys?: AdmobKey[] };
  const keys = json.keys ?? [];
  admobKeysCache = { keys, fetchedAt: now };
  return keys;
}

/**
 * 验签 AdMob SSV callback 查询参数。
 * message = 所有查询参数（除 signature + key_id）按原始顺序拼接的 query string。
 * signature = base64url ECDSA-P256-SHA256。
 */
async function verifyAdmobCallback(
  rawQuery: string, // 完整 query string（如 URL 中 ? 之后部分）
  signature: string,
  keyId: string,
): Promise<boolean> {
  let keys: AdmobKey[];
  try {
    keys = await getAdmobKeys();
  } catch {
    return false; // 网络问题时保守拒绝
  }
  const kid = Number(keyId);
  const keyEntry = keys.find((k) => k.keyId === kid);
  if (!keyEntry) return false;

  // message = query string 去掉 signature 和 key_id 两个参数（保留其他参数的原始顺序）。
  const params = new URLSearchParams(rawQuery);
  params.delete('signature');
  params.delete('key_id');
  const message = params.toString();

  try {
    const verify = createVerify('SHA256');
    verify.update(message);
    return verify.verify(keyEntry.pem, signature, 'base64url');
  } catch {
    return false;
  }
}

// ── 微信广告 SSV 验签 ──────────────────────────────────────────────────────

interface WechatAdsCallbackBody {
  openid?: string;
  trans_id?: string;
  timestamp?: number;
  nonce?: string;
  sign?: string;
}

/**
 * 验签微信广告 SSV POST 回调。
 * 签名规则：按字典序排列 key=value 对（除 sign 外），&拼接，HMAC-SHA256(message, NW_WECHAT_ADS_KEY)。
 */
function verifyWechatAdsCallback(body: WechatAdsCallbackBody, key: string): boolean {
  const { openid, trans_id, timestamp, nonce, sign } = body;
  if (!openid || !trans_id || timestamp == null || !nonce || !sign) return false;
  const pairs = [
    ['nonce', nonce],
    ['openid', openid],
    ['timestamp', String(timestamp)],
    ['trans_id', trans_id],
  ];
  pairs.sort(([a = ''], [b = '']) => a.localeCompare(b));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const expected = createHmac('sha256', key).update(message).digest('hex');
  return expected === sign;
}

// ── 回调路由注册 ─────────────────────────────────────────────────────────────

interface CallbackDeps {
  cols: Collections;
  commercial: CommercialClient;
  now: () => number;
}

/**
 * 注册广告平台服务端回调路由（不经 openapi glue，直接 Fastify 注册）。
 * - GET  /ads/callback/admob  — AdMob SSV
 * - POST /ads/callback/wechat — 微信广告
 */
export function registerAdCallbackRoutes(app: FastifyInstance, deps: CallbackDeps): void {
  // ── AdMob SSV ────────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>(
    '/ads/callback/admob',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const qs = req.query as Record<string, string>;
      const { user_id, transaction_id, signature, key_id, custom_data } = qs;

      // custom_data = accountId（客户端发起广告请求时设置）。
      const accountId = custom_data ?? user_id;
      if (!accountId || !transaction_id || !signature || !key_id) {
        return reply.code(400).send('missing params');
      }

      // 验签。
      const rawQuery = new URLSearchParams(qs).toString();
      const valid = await verifyAdmobCallback(rawQuery, signature, key_id);
      if (!valid) return reply.code(400).send('invalid signature');

      const { cols, commercial, now } = deps;
      const ts = now();
      const dayKey = adsDayKey(ts);

      // 凭证唯一性（使用 transaction_id）。
      const tokenHash = hashAdToken(transaction_id);
      const unique = await recordAdToken(cols, tokenHash, accountId, ts);
      if (!unique) return reply.code(200).send('already processed'); // 幂等返 200

      // 日 cap。
      const intervalOk = await checkAdInterval(cols, accountId, dayKey, ts, ADS_MIN_INTERVAL_MS);
      const allowed = intervalOk && await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, ts);
      if (!allowed) return reply.code(200).send('cap reached'); // Google 要求返 200，否则重试

      const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
      if (!credit.ok) return reply.code(200).send('credit failed');
      await mirrorCoins(cols, accountId, credit.coinsAfter, ts);
      return reply.code(200).send('OK');
    },
  );

  // ── 微信广告 SSV ─────────────────────────────────────────────────────────
  app.post<{ Body: WechatAdsCallbackBody }>(
    '/ads/callback/wechat',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = process.env.NW_WECHAT_ADS_KEY;
      if (!key) return reply.code(503).send('wechat ads not configured');

      const body = req.body as WechatAdsCallbackBody;
      const valid = verifyWechatAdsCallback(body, key);
      if (!valid) return reply.code(400).send('invalid signature');

      const { openid, trans_id } = body;
      if (!openid || !trans_id) return reply.code(400).send('missing fields');

      // 用 openid 作 accountId（微信环境下已绑定账号）。
      const accountId = openid;
      const { cols, commercial, now } = deps;
      const ts = now();
      const dayKey = adsDayKey(ts);

      const tokenHash = hashAdToken(trans_id);
      const unique = await recordAdToken(cols, tokenHash, accountId, ts);
      if (!unique) return reply.code(200).send(JSON.stringify({ errcode: 0, errmsg: 'ok' }));

      const intervalOk = await checkAdInterval(cols, accountId, dayKey, ts, ADS_MIN_INTERVAL_MS);
      const allowed = intervalOk && await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, ts);
      if (!allowed) return reply.code(200).send(JSON.stringify({ errcode: 0, errmsg: 'cap' }));

      const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
      if (!credit.ok) return reply.code(200).send(JSON.stringify({ errcode: 1, errmsg: credit.error }));
      await mirrorCoins(cols, accountId, credit.coinsAfter, ts);
      return reply.code(200).send(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    },
  );
}

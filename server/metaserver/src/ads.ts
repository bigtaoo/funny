// Ad platform signature verification (C2).
// Contains:
//   1. verifyAdPlatformToken  — lightweight platform token verification for client POST /ads/reward.
//   2. registerAdCallbackRoutes — AdMob SSV / WeChat Ads server-side callbacks (platform-initiated calls).
//
// AdMob SSV flow:
//   The client registers accountId as custom_data before showing an ad; after playback Google calls back
//   GET /ads/callback/admob?transaction_id=…&custom_data=…&signature=…&key_id=…
//   This module verifies the ECDSA-P256 signature (public key fetched from Google gstatic and cached), then credits the reward.
//
// WeChat Ads callback (WECHAT_ADS):
//   POST /ads/callback/wechat  Body: { openid, trans_id, timestamp, nonce, sign }
//   Verified with HMAC-SHA256(sort(params_kvs).join('&'), NW_WECHAT_ADS_KEY).

import { createHash, createVerify, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Collections } from '@nw/shared';
import { ADS_REWARD_COINS, ADS_DAILY_CAP, ADS_MIN_INTERVAL_MS } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { adsDayKey, bumpAdsCap, mirrorCoins, checkAdInterval, recordAdToken, hashAdToken } from './economy.js';

// ── Client token verification (lightweight; optionally bypassed when server has no secret key) ────────────────────────────

/**
 * Platform signature verification for the adToken in client `POST /ads/reward`.
 * - `admob_client`: adToken = HMAC-SHA256(transactionId, NW_ADMOB_CLIENT_KEY)
 *   The client receives a transactionId from the ad SDK; the server validates its integrity using the shared secret.
 * - `wechat_client`: same as above, using NW_WECHAT_ADS_CLIENT_KEY.
 * - Returns true if the corresponding env var is not set (open fallback, relying on token uniqueness + cap to prevent abuse).
 */
export function verifyAdPlatformToken(platform: string, adToken: string): boolean {
  if (platform === 'admob_client') {
    const key = process.env.NW_ADMOB_CLIENT_KEY;
    if (!key) return true; // not configured: allow through, rely on idempotency + cap
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
  return false; // unknown platform: reject
}

// ── AdMob SSV signature verification (server-side callback) ──────────────────────────────────────────────

interface AdmobKey {
  keyId: number;
  pem: string;
}

// In-memory cache, TTL 5min.
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
 * Verify the AdMob SSV callback query parameters.
 * message = query string of all parameters (except signature + key_id) in their original order.
 * signature = base64url ECDSA-P256-SHA256.
 */
async function verifyAdmobCallback(
  rawQuery: string, // full query string (the part after ? in the URL)
  signature: string,
  keyId: string,
): Promise<boolean> {
  let keys: AdmobKey[];
  try {
    keys = await getAdmobKeys();
  } catch {
    return false; // conservatively reject on network errors
  }
  const kid = Number(keyId);
  const keyEntry = keys.find((k) => k.keyId === kid);
  if (!keyEntry) return false;

  // message = query string with signature and key_id removed (other parameters retain their original order).
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

// ── WeChat Ads SSV signature verification ──────────────────────────────────────────────────────

interface WechatAdsCallbackBody {
  openid?: string;
  trans_id?: string;
  timestamp?: number;
  nonce?: string;
  sign?: string;
}

/**
 * Verify the WeChat Ads SSV POST callback.
 * Signature rule: sort key=value pairs alphabetically (excluding sign), join with &, HMAC-SHA256(message, NW_WECHAT_ADS_KEY).
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

// ── Callback route registration ─────────────────────────────────────────────────────────────

interface CallbackDeps {
  cols: Collections;
  commercial: CommercialClient;
  now: () => number;
}

/**
 * Register ad platform server-side callback routes (registered directly with Fastify, bypassing the openapi glue).
 * - GET  /ads/callback/admob  — AdMob SSV
 * - POST /ads/callback/wechat — WeChat Ads
 */
export function registerAdCallbackRoutes(app: FastifyInstance, deps: CallbackDeps): void {
  // ── AdMob SSV ────────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>(
    '/ads/callback/admob',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const qs = req.query as Record<string, string>;
      const { user_id, transaction_id, signature, key_id, custom_data } = qs;

      // custom_data = accountId (set by the client when initiating the ad request).
      const accountId = custom_data ?? user_id;
      if (!accountId || !transaction_id || !signature || !key_id) {
        return reply.code(400).send('missing params');
      }

      // Verify signature.
      const rawQuery = new URLSearchParams(qs).toString();
      const valid = await verifyAdmobCallback(rawQuery, signature, key_id);
      if (!valid) return reply.code(400).send('invalid signature');

      const { cols, commercial, now } = deps;
      const ts = now();
      const dayKey = adsDayKey(ts);

      // Token uniqueness check (using transaction_id).
      const tokenHash = hashAdToken(transaction_id);
      const unique = await recordAdToken(cols, tokenHash, accountId, ts);
      if (!unique) return reply.code(200).send('already processed'); // idempotent: return 200

      // Daily cap.
      const intervalOk = await checkAdInterval(cols, accountId, dayKey, ts, ADS_MIN_INTERVAL_MS);
      const allowed = intervalOk && await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, ts);
      if (!allowed) return reply.code(200).send('cap reached'); // Google requires 200, otherwise it retries

      const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
      if (!credit.ok) return reply.code(200).send('credit failed');
      await mirrorCoins(cols, accountId, credit.coinsAfter, ts);
      return reply.code(200).send('OK');
    },
  );

  // ── WeChat Ads SSV ──────────────────────────────────────────────────────
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

      // Use openid as accountId (already bound to an account in the WeChat environment).
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

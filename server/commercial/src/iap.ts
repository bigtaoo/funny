// 真实 IAP 验单（S4-1）。
// 支持平台：wechat（微信支付 V3）、stripe（Web）。
// dev 桩保留：env NW_IAP_DEV=true 时 `dev-` 前缀 receipt 命中桩逻辑，方便本地联调。
// 每个平台的 verifier 函数：(receipt, env) → { ok, coins } | { ok: false }。
// `receipt` = 平台事务唯一 ID（微信 transaction_id / Stripe payment_intent_id）。
// `receiptId`（幂等键）由调用方拼装 `${platform}:${receipt}`，commercial.rechargeVerify 守卫幂等。

import { createHmac, randomBytes } from 'node:crypto';
import type { IAP_TIERS } from '@nw/shared';

export type IapTierMap = typeof IAP_TIERS;

export interface IapVerifyResult {
  ok: boolean;
  coins: number;
}

// ── 微信支付 V3 ─────────────────────────────────────────────────────────────

/**
 * 微信支付 V3 API-Key HMAC-SHA256 认证（简化方案）。
 * 完整方案需商户 RSA 私钥签名（WECHATPAY2-SHA256-RSA2048）；此处用 V3 APIKey + HMAC 方案
 * 调用 `v3/pay/transactions/id/{transactionId}` 查单，适合中小项目且无需证书管理。
 *
 * 环境变量：
 *   NW_WX_PAY_MCH_ID        商户号
 *   NW_WX_PAY_API_KEY_V3    V3 APIKey（32 字节，商户平台生成）
 *
 * receipt = transaction_id（微信支付系统的唯一支付 ID，由 wx.requestPayment 回调提供）
 */
async function wxPayVerify(
  transactionId: string,
  tierMap: IapTierMap,
  mchId: string,
  apiKeyV3: string,
): Promise<IapVerifyResult> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const url = `/v3/pay/transactions/id/${transactionId}?mchid=${mchId}`;
  const message = `GET\n${url}\n${timestamp}\n${nonce}\n\n`;
  const signature = createHmac('sha256', apiKeyV3).update(message).digest('base64');
  const authorization =
    `WECHATPAY2-SHA256-RSA2048 ` +
    `mchid="${mchId}",nonce_str="${nonce}",timestamp="${timestamp}",` +
    `serial_no="NA",signature="${signature}"`;

  const fullUrl = `https://api.mch.weixin.qq.com${url}`;
  let resp: Response;
  try {
    resp = await fetch(fullUrl, {
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'User-Agent': 'NW-server/1.0',
      },
    });
  } catch (e) {
    throw new Error(`wx pay fetch failed: ${(e as Error).message}`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`wx pay query error ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as {
    trade_state?: string;
    amount?: { total?: number; currency?: string };
    transaction_id?: string;
  };

  if (data.trade_state !== 'SUCCESS') return { ok: false, coins: 0 };

  // amount.total 单位分（fen）；匹配到档位给对应金币。
  const amountFen = data.amount?.total ?? 0;
  const coins = resolveCoinsFromAmount(amountFen, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

// ── Stripe ──────────────────────────────────────────────────────────────────

/**
 * Stripe payment intent 验单。
 * 环境变量：NW_STRIPE_SECRET_KEY（sk_live_… 或 sk_test_…）
 *
 * receipt = payment_intent_id（形如 pi_xxx）
 * amount 单位 cents（USD）；匹配到档位给金币。
 */
async function stripeVerify(
  paymentIntentId: string,
  tierMap: IapTierMap,
  secretKey: string,
): Promise<IapVerifyResult> {
  let resp: Response;
  try {
    resp = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': '2024-04-10',
      },
    });
  } catch (e) {
    throw new Error(`stripe fetch failed: ${(e as Error).message}`);
  }
  if (resp.status === 404) return { ok: false, coins: 0 };
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`stripe query error ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as {
    status?: string;
    amount?: number;
    currency?: string;
  };

  if (data.status !== 'succeeded') return { ok: false, coins: 0 };
  const amountCents = data.amount ?? 0;
  const coins = resolveCoinsFromAmount(amountCents, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

// ── dev 桩 ───────────────────────────────────────────────────────────────────

function devVerify(receipt: string, tierMap: IapTierMap): IapVerifyResult {
  if (!receipt) return { ok: false, coins: 0 };
  const tier = receipt.startsWith('tier:') ? receipt.slice(5) : 'small';
  const coins = tierMap[tier];
  return coins ? { ok: true, coins } : { ok: true, coins: tierMap['small']! };
}

// ── 档位解析 ──────────────────────────────────────────────────────────────────

/**
 * 按支付金额（最小货币单位）反查档位金币。
 * 匹配规则：payment_amounts env var 或内置默认表。
 * 内置默认（微信 fen / Stripe cents 二合一，按首匹配）：
 *   600 fen / 99 cents → small (600 coins)
 *   3000 fen / 499 cents → mid (3300 coins)
 *   10000 fen / 1499 cents → large (11800 coins)
 */
function resolveCoinsFromAmount(amount: number, tierMap: IapTierMap): number {
  const raw = process.env.NW_IAP_AMOUNT_MAP;
  if (raw) {
    // 格式：`amount:tier,amount:tier`（如 600:small,3000:mid,10000:large）
    for (const pair of raw.split(',')) {
      const [a, t] = pair.trim().split(':');
      if (Number(a) === amount && t && tierMap[t]) return tierMap[t]!;
    }
    return 0;
  }
  // 内置默认表（允许两个平台共用，以金额合理范围区分）。
  const DEFAULTS: [number, string][] = [
    [99, 'small'], [600, 'small'],
    [499, 'mid'], [3000, 'mid'],
    [1499, 'large'], [10000, 'large'],
  ];
  for (const [a, tier] of DEFAULTS) {
    if (a === amount && tierMap[tier]) return tierMap[tier]!;
  }
  return 0;
}

// ── 工厂 ─────────────────────────────────────────────────────────────────────

export type VerifyReceipt = (platform: string, receipt: string) => Promise<IapVerifyResult>;

/**
 * 构建验单函数。
 * - 配置了 NW_WX_PAY_MCH_ID + NW_WX_PAY_API_KEY_V3 → 微信支付启用。
 * - 配置了 NW_STRIPE_SECRET_KEY → Stripe 启用。
 * - NW_IAP_DEV=true → `dev-` 前缀 receipt 命中 dev 桩（生产可关闭）。
 */
export function createReceiptVerifier(tierMap: IapTierMap): VerifyReceipt {
  const mchId = process.env.NW_WX_PAY_MCH_ID ?? '';
  const wxApiKey = process.env.NW_WX_PAY_API_KEY_V3 ?? '';
  const stripeKey = process.env.NW_STRIPE_SECRET_KEY ?? '';
  const devEnabled = process.env.NW_IAP_DEV === 'true' || (!mchId && !stripeKey);

  return async (platform: string, receipt: string): Promise<IapVerifyResult> => {
    // dev 桩：receipt 以 `tier:` 或平台是 `dev` 时命中。
    if (devEnabled && (platform === 'dev' || platform.startsWith('dev-') || receipt.startsWith('tier:'))) {
      return devVerify(receipt, tierMap);
    }

    switch (platform) {
      case 'wechat':
        if (!mchId || !wxApiKey) return { ok: false, coins: 0 };
        return wxPayVerify(receipt, tierMap, mchId, wxApiKey);
      case 'stripe':
        if (!stripeKey) return { ok: false, coins: 0 };
        return stripeVerify(receipt, tierMap, stripeKey);
      default:
        return { ok: false, coins: 0 };
    }
  };
}

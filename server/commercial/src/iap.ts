// 真实 IAP 验单（S4-1 / C1）。
// 支持平台：apple（App Store StoreKit 1 receipt）、google（Google Play）、
//           wechat（微信支付 V3）、stripe（Web）。
// dev 桩保留：NW_IAP_DEV=true 或缺少真实凭据时，tier: 前缀 receipt 命中桩逻辑。
//
// receipt 格式约定：
//   apple   → base64 encoded App Store receipt data
//   google  → "${productId}:${purchaseToken}"
//   wechat  → transaction_id
//   stripe  → payment_intent_id
//
// receiptId 幂等键由调用方拼装 `${platform}:${receipt}`，
// commercial.rechargeVerify 守卫幂等，此文件不重复校验。

import { createHmac, createSign, randomBytes } from 'node:crypto';
import type { IAP_TIERS } from '@nw/shared';

export type IapTierMap = typeof IAP_TIERS;

export interface IapVerifyResult {
  ok: boolean;
  coins: number;
}

// ── 产品 ID → 档位映射 ──────────────────────────────────────────────────────

/**
 * 将 App Store / Google Play product_id 映射到金币档位名称。
 * 优先读 NW_IAP_PRODUCT_MAP（格式：`productId:tier,...`），
 * 否则用内置默认表（bundle 前缀可通过 NW_IAP_BUNDLE 覆盖，默认 com.nw）。
 */
function resolveCoinsFromProductId(productId: string, tierMap: IapTierMap): number {
  const raw = process.env.NW_IAP_PRODUCT_MAP;
  if (raw) {
    for (const pair of raw.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx < 0) continue;
      const pid = pair.slice(0, colonIdx).trim();
      const tier = pair.slice(colonIdx + 1).trim();
      if (pid === productId && tier && tierMap[tier]) return tierMap[tier]!;
    }
    return 0;
  }
  const bundle = process.env.NW_IAP_BUNDLE ?? 'com.nw';
  const DEFAULTS: Record<string, string> = {
    [`${bundle}.coins.small`]: 'small',
    [`${bundle}.coins.mid`]: 'mid',
    [`${bundle}.coins.large`]: 'large',
  };
  const tier = DEFAULTS[productId];
  return tier && tierMap[tier] ? tierMap[tier]! : 0;
}

// ── Apple App Store（StoreKit 1 receipt 验签）─────────────────────────────────

const APPLE_PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

interface AppleInApp {
  product_id: string;
  transaction_id: string;
  purchase_date_ms: string;
}

interface AppleVerifyResponse {
  status: number;
  receipt?: { in_app?: AppleInApp[] };
  latest_receipt_info?: AppleInApp[];
}

async function applePost(url: string, body: object): Promise<AppleVerifyResponse> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`apple verifyReceipt HTTP ${resp.status}`);
  return (await resp.json()) as AppleVerifyResponse;
}

/**
 * Apple StoreKit 1 receipt 验签。
 * prod 返回 21007（sandbox receipt）时自动重试 sandbox 端点。
 * 从 in_app[] 取最新一条（按 purchase_date_ms 降序）的 product_id 映射金币。
 */
async function appleVerify(
  receiptData: string,
  tierMap: IapTierMap,
  password: string,
): Promise<IapVerifyResult> {
  const payload = {
    'receipt-data': receiptData,
    password,
    'exclude-old-transactions': true,
  };

  let data: AppleVerifyResponse;
  try {
    data = await applePost(APPLE_PROD_URL, payload);
    if (data.status === 21007) {
      data = await applePost(APPLE_SANDBOX_URL, payload);
    }
  } catch (e) {
    throw new Error(`apple verify failed: ${(e as Error).message}`);
  }

  if (data.status !== 0) return { ok: false, coins: 0 };

  // latest_receipt_info 是扁平数组（包含所有续订/消耗品）；回退到 receipt.in_app。
  const inApps: AppleInApp[] = data.latest_receipt_info ?? data.receipt?.in_app ?? [];
  if (inApps.length === 0) return { ok: false, coins: 0 };

  // 取最新一条交易。
  const latest = inApps.reduce((a, b) =>
    Number(a.purchase_date_ms) >= Number(b.purchase_date_ms) ? a : b,
  );
  const coins = resolveCoinsFromProductId(latest.product_id, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

// ── Google Play（androidpublisher v3）─────────────────────────────────────────

interface GoogleServiceAccount {
  private_key: string;
  client_email: string;
}

/** 用服务账户私钥构造 RS256 JWT，换取 OAuth2 access token。 */
async function getGoogleAccessToken(sa: GoogleServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const sigInput = `${header}.${claim}`;
  const signer = createSign('RSA-SHA256');
  signer.update(sigInput);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = `${sigInput}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`google oauth2 token HTTP ${resp.status}`);
  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('google oauth2: no access_token in response');
  return json.access_token;
}

interface GooglePurchase {
  purchaseState?: number; // 0 = purchased
  consumptionState?: number;
  orderId?: string;
}

/**
 * Google Play Purchases.products.get 验签。
 * receipt 格式：`${productId}:${purchaseToken}`（冒号分隔）
 * purchaseState === 0 表示已成功购买。
 */
async function googleVerify(
  receipt: string,
  tierMap: IapTierMap,
  sa: GoogleServiceAccount,
  packageName: string,
): Promise<IapVerifyResult> {
  const colonIdx = receipt.indexOf(':');
  if (colonIdx < 0) return { ok: false, coins: 0 };
  const productId = receipt.slice(0, colonIdx);
  const purchaseToken = receipt.slice(colonIdx + 1);
  if (!productId || !purchaseToken) return { ok: false, coins: 0 };

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(sa);
  } catch (e) {
    throw new Error(`google auth failed: ${(e as Error).message}`);
  }

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${packageName}/purchases/products/${productId}/tokens/${purchaseToken}`;

  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    throw new Error(`google play fetch failed: ${(e as Error).message}`);
  }

  if (resp.status === 404) return { ok: false, coins: 0 };
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`google play query error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as GooglePurchase;
  if (data.purchaseState !== 0) return { ok: false, coins: 0 };

  const coins = resolveCoinsFromProductId(productId, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
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

// ── 档位解析（金额）──────────────────────────────────────────────────────────

/**
 * 按支付金额（最小货币单位）反查档位金币（微信/Stripe 共用）。
 * 内置默认（微信 fen / Stripe cents）：
 *   600 fen / 99 cents → small (600 coins)
 *   3000 fen / 499 cents → mid (3300 coins)
 *   10000 fen / 1499 cents → large (11800 coins)
 */
function resolveCoinsFromAmount(amount: number, tierMap: IapTierMap): number {
  const raw = process.env.NW_IAP_AMOUNT_MAP;
  if (raw) {
    for (const pair of raw.split(',')) {
      const [a, t] = pair.trim().split(':');
      if (Number(a) === amount && t && tierMap[t]) return tierMap[t]!;
    }
    return 0;
  }
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
 * 构建验单函数。支持四个平台：
 * - apple：NW_APPLE_PASSWORD（App Store shared secret）
 * - google：NW_GOOGLE_SERVICE_ACCOUNT_JSON（服务账户 JSON 字符串）+ NW_GOOGLE_PACKAGE_NAME
 * - wechat：NW_WX_PAY_MCH_ID + NW_WX_PAY_API_KEY_V3
 * - stripe：NW_STRIPE_SECRET_KEY
 * - dev 桩：NW_IAP_DEV=true 或所有真实凭据均缺失时，tier:xxx receipt 命中桩逻辑。
 *   **加固（L2-3）**：生产环境（NODE_ENV=production）下 dev 桩一律强制关闭——既不因
 *   NW_IAP_DEV=true 误开，也不因「缺凭据」自动回退。生产缺凭据 → 验签返失败（fail closed），
 *   绝不发币。误设 NW_IAP_DEV=true 的进程由 commercial 引导期拒启（index.ts），此处为第二道防线。
 */
export function createReceiptVerifier(tierMap: IapTierMap): VerifyReceipt {
  const applePassword = process.env.NW_APPLE_PASSWORD ?? '';
  const googleSaJson = process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON ?? '';
  const googlePackage = process.env.NW_GOOGLE_PACKAGE_NAME ?? 'com.nw.game';
  const mchId = process.env.NW_WX_PAY_MCH_ID ?? '';
  const wxApiKey = process.env.NW_WX_PAY_API_KEY_V3 ?? '';
  const stripeKey = process.env.NW_STRIPE_SECRET_KEY ?? '';
  const isProd = process.env.NODE_ENV === 'production';
  const devEnabled =
    !isProd &&
    (process.env.NW_IAP_DEV === 'true' ||
      (!applePassword && !googleSaJson && !mchId && !stripeKey));

  let googleSa: GoogleServiceAccount | null = null;
  if (googleSaJson) {
    try {
      googleSa = JSON.parse(googleSaJson) as GoogleServiceAccount;
    } catch {
      console.error('NW_GOOGLE_SERVICE_ACCOUNT_JSON parse error — Google Play disabled');
    }
  }

  return async (platform: string, receipt: string): Promise<IapVerifyResult> => {
    if (
      devEnabled &&
      (platform === 'dev' || platform.startsWith('dev-') || receipt.startsWith('tier:'))
    ) {
      return devVerify(receipt, tierMap);
    }

    switch (platform) {
      case 'apple':
        if (!applePassword) return { ok: false, coins: 0 };
        return appleVerify(receipt, tierMap, applePassword);
      case 'google':
        if (!googleSa) return { ok: false, coins: 0 };
        return googleVerify(receipt, tierMap, googleSa, googlePackage);
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

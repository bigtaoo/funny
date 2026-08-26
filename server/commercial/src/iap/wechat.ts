// Split from iap.ts (2026-08-10, independent function module range 6, part 5/7).
// WeChat Pay V3.
import { createHmac, randomBytes } from 'node:crypto';
import { resolveCoinsFromAmount, resolveNonCoinProductFromAmount } from './productResolve';
import type { IapTierMap, IapVerifyResult } from './types';

/**
 * WeChat Pay V3 API-Key HMAC-SHA256 authentication (simplified approach).
 * The full approach requires a merchant RSA private-key signature (WECHATPAY2-SHA256-RSA2048);
 * here we use the V3 APIKey + HMAC scheme to query `v3/pay/transactions/id/{transactionId}`,
 * suitable for small-to-medium projects that do not need certificate management.
 *
 * Environment variables:
 *   NW_WX_PAY_MCH_ID        Merchant ID
 *   NW_WX_PAY_API_KEY_V3    V3 APIKey (32 bytes, generated on the merchant platform)
 *
 * receipt = transaction_id (the unique payment ID in the WeChat Pay system, provided by the wx.requestPayment callback)
 */
export async function wxPayVerify(
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
    throw new Error(`wx pay fetch failed: ${(e as Error).message}`, { cause: e });
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

  // amount.total is in fen (smallest unit); match to a tier to award the corresponding coins.
  const amountFen = data.amount?.total ?? 0;
  const product = resolveNonCoinProductFromAmount(amountFen);
  if (product) return { ok: true, coins: 0, product };
  const coins = resolveCoinsFromAmount(amountFen, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

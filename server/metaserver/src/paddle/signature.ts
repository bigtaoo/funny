// Paddle webhook signature verification (2026-08-11 split, see paddle.ts's header). Zero cross-file
// dependency, used only by webhookRoute.ts.
//
// Paddle webhook signature (h1 scheme):
//   Header:  Paddle-Signature: ts=<epoch>;h1=<hmac-sha256-hex>
//   Message: `${ts}:${rawBody}`
//   Key:     NW_PADDLE_WEBHOOK_SECRET
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Paddle webhook signature header.
 * Header format: `ts=<epoch>;h1=<hmac-sha256-hex>`
 * HMAC message:  `${ts}:${rawBody}`
 */
export function verifyPaddleSignature(secret: string, rawBody: string, header: string): boolean {
  const parts: Record<string, string> = {};
  for (const seg of header.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;

  const expected = createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(h1, 'hex'));
  } catch {
    return false;
  }
}

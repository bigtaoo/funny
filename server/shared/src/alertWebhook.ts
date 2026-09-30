// Ops alert webhook (S4-3 process alerts; UGC report alerts for App Store Review Guideline 1.2).
// One NW_ALERT_WEBHOOK_URL may point at Slack, Discord or WeCom, and the three disagree on the JSON body:
// Slack reads `text`, Discord reads `content`, WeCom wants `{ msgtype: 'text', text: { content } }`.
// WeCom is recognised by host; for everything else one body carries both `text` and `content` so the same
// payload works on Slack and Discord (each ignores the other's field).

export function alertWebhookPayload(webhookUrl: string, text: string): Record<string, unknown> {
  let host = '';
  try {
    host = new URL(webhookUrl).host;
  } catch {
    /* malformed URL: fall through to the Slack/Discord shape; the POST will fail and be ignored */
  }
  if (host === 'qyapi.weixin.qq.com') return { msgtype: 'text', text: { content: text } };
  return { text, content: text };
}

export interface PostAlertOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Abort the POST after this long (default 5s) so a hung webhook never pins a socket. */
  timeoutMs?: number;
}

/**
 * Fire-and-forget POST to an alert webhook. Never throws and never rejects: delivery failures are swallowed
 * (the caller's request/crash path must not depend on a chat service being up). Resolves to whether the
 * webhook answered 2xx, which only tests look at.
 */
export async function postAlertWebhook(webhookUrl: string, text: string, opts: PostAlertOptions = {}): Promise<boolean> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alertWebhookPayload(webhookUrl, text)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

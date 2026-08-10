// Split from accounts.ts (2026-08-10, independent function module range 6, part 6/6).
/**
 * WeChat code → openid. If NW_WX_APPID/SECRET are configured, calls the official jscode2session
 * endpoint; otherwise falls back to dev mode: uses the code directly as the openid (local
 * integration testing only).
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

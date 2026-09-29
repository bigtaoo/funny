// Guideline 1.2 ops alert: every new report/block is posted to NW_ALERT_WEBHOOK_URL. Fake fetch only —
// no network. Covers the three webhook dialects, the "never throws / never blocks" contract, and the text.
import { describe, expect, it, vi } from 'vitest';
import { alertWebhookPayload, postAlertWebhook } from '@nw/shared';
import { createReportAlerter, formatReportAlert, nullReportAlerter, ALERT_SNAPSHOT_PREVIEW } from '../src/reportAlert';
import type { ReportDoc } from '../src/db';

const report = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  _id: 'rep-1', reporterId: 'a', targetId: 'b', reason: 'rude', ts: 1, status: 'open', source: 'report',
  category: 'harassment',
  contentRef: { kind: 'content', channel: 'dm', messageId: 'm1', snapshot: 'you are awful', snapshotSource: 'server' },
  ...over,
});

function fakeFetch(impl?: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return impl ? impl() : new Response('ok', { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('alertWebhookPayload', () => {
  it('Slack/Discord get one body carrying both `text` and `content`', () => {
    expect(alertWebhookPayload('https://hooks.slack.com/services/x', 'hi')).toEqual({ text: 'hi', content: 'hi' });
    expect(alertWebhookPayload('https://discord.com/api/webhooks/1/abc', 'hi')).toEqual({ text: 'hi', content: 'hi' });
  });
  it('WeCom (qyapi.weixin.qq.com) gets its msgtype envelope', () => {
    expect(alertWebhookPayload('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', 'hi')).toEqual({ msgtype: 'text', text: { content: 'hi' } });
  });
  it('a malformed URL does not throw', () => {
    expect(alertWebhookPayload('not a url', 'hi')).toEqual({ text: 'hi', content: 'hi' });
  });
});

describe('postAlertWebhook', () => {
  it('POSTs JSON with a timeout signal and resolves true on 2xx', async () => {
    const f = fakeFetch();
    expect(await postAlertWebhook('https://hooks.slack.com/x', 'hello', { fetch: f.fn })).toBe(true);
    expect(f.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ text: 'hello', content: 'hello' });
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
  it('swallows rejections and non-2xx (resolves false, never throws)', async () => {
    expect(await postAlertWebhook('https://x', 't', { fetch: fakeFetch(async () => { throw new Error('ECONNREFUSED'); }).fn })).toBe(false);
    expect(await postAlertWebhook('https://x', 't', { fetch: fakeFetch(async () => new Response('no', { status: 500 })).fn })).toBe(false);
  });
});

describe('formatReportAlert', () => {
  it('names id, kind, target, category, channel, snapshot and the 24h deadline', () => {
    const text = formatReportAlert({ report: report(), targetPublicId: 'P-B', targetName: 'Bob' });
    expect(text).toContain('Player report rep-1');
    expect(text).toContain('within 24h');
    expect(text).toContain('Bob (P-B)');
    expect(text).toContain('category: harassment');
    expect(text).toContain('channel: dm');
    expect(text).toContain('"you are awful"');
  });
  it('labels blocks and truncates long snapshots', () => {
    const long = 'z'.repeat(ALERT_SNAPSHOT_PREVIEW + 50);
    const text = formatReportAlert({ report: report({ source: 'block', contentRef: { kind: 'content', channel: 'world', snapshot: long } }) });
    expect(text).toContain('Player blocked rep-1');
    expect(text).toContain(`"${'z'.repeat(ALERT_SNAPSHOT_PREVIEW)}…"`);
    expect(text).not.toContain('z'.repeat(ALERT_SNAPSHOT_PREVIEW + 1));
    expect(text).toContain('target: b'); // no publicId resolved → raw accountId
  });
  it('a player-level report (no category/content) still formats', () => {
    const text = formatReportAlert({ report: report({ category: undefined, contentRef: undefined }) });
    expect(text).toContain('category: -  channel: -');
  });
});

describe('createReportAlerter', () => {
  it('no webhook URL → the null alerter (no fetch ever)', () => {
    expect(createReportAlerter({ webhookUrl: undefined })).toBe(nullReportAlerter);
  });
  it('notify returns synchronously, posts in the background, and a failing webhook never surfaces', async () => {
    const ok = fakeFetch();
    const alerter = createReportAlerter({ webhookUrl: 'https://hooks.slack.com/x', fetch: ok.fn, timeoutMs: 50 });
    expect(alerter.notify({ report: report() })).toBeUndefined();
    await flush();
    expect(ok.calls).toHaveLength(1);
    expect(JSON.parse(String(ok.calls[0]!.init.body)).text).toContain('rep-1');

    const bad = fakeFetch(async () => { throw new Error('down'); });
    const failing = createReportAlerter({ webhookUrl: 'https://hooks.slack.com/x', fetch: bad.fn });
    expect(() => failing.notify({ report: report() })).not.toThrow();
    await flush();
    expect(bad.calls).toHaveLength(1);
  });
});

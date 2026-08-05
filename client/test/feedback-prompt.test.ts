// In-game player feedback (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13): the transport-layer
// pieces that back FeedbackDialog, mirroring appeal-prompt.test.ts's coverage of the twin appeal feature:
//   1. net/log.ts's requestFeedbackDialog/setFeedbackSink sink itself (same pattern as
//      showToastMessage/setToastSink and maybePromptAppeal/setAppealSink).
//   2. ApiClient.submitFeedback (POST /feedback with {text}), the AuthMixin method FeedbackDialog's
//      onSubmit callback (wired in app.ts) ultimately calls.
//   3. createAppCore's AppCore.submitFeedback bridges to ApiClient.submitFeedback, and is undefined
//      when offline (no api base configured) so the lobby's onOpenFeedback sink can no-op safely.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setFeedbackSink, requestFeedbackDialog } from '../src/net/log';
import { ApiClient } from '../src/net/ApiClient';
import { createAppCore } from '../src/app/createAppCore';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('net/log: requestFeedbackDialog / setFeedbackSink', () => {
  afterEach(() => {
    setFeedbackSink(() => {}); // reset to a no-op so later test files don't inherit a stale sink
  });

  it('fires the registered sink', () => {
    const sink = vi.fn();
    setFeedbackSink(sink);

    requestFeedbackDialog();

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no sink has been registered yet', () => {
    // Simulate the pre-app.ts-bootstrap state (or offline mode, where app.ts skips registration
    // entirely — see app.ts's `if (!core.submitFeedback || feedbackDialog) return;` guard).
    expect(() => requestFeedbackDialog()).not.toThrow();
  });

  it('swallows an exception thrown by the sink instead of propagating it', () => {
    setFeedbackSink(() => { throw new Error('boom'); });
    expect(() => requestFeedbackDialog()).not.toThrow();
  });
});

describe('ApiClient.submitFeedback', () => {
  it('POSTs to /feedback with the trimmed-by-caller text', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse({ ok: true, data: { ok: true } });
    };

    const client = new ApiClient('http://x');
    await client.submitFeedback('love the ink-splatter effect');

    expect(capturedUrl).toContain('/feedback');
    expect(capturedBody).toEqual({ text: 'love the ink-splatter effect' });
  });

  it('propagates a server error (e.g. 429 rate-limited) instead of swallowing it', async () => {
    (globalThis as Record<string, unknown>).fetch = async () =>
      ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }) } as unknown as Response);

    const client = new ApiClient('http://x');
    await expect(client.submitFeedback('another note')).rejects.toThrow();
  });
});

describe('createAppCore().submitFeedback', () => {
  it('is undefined when offline (no api base configured), so the lobby sink can no-op safely', () => {
    const platform = new HeadlessPlatform();
    const core = createAppCore(platform, new HeadlessAppViews());
    expect(core.submitFeedback).toBeUndefined();
  });

  it('delegates to ApiClient.submitFeedback (POST /feedback) when an api base is configured', async () => {
    const platform = new HeadlessPlatform({ storage: { nw_api_base: 'http://x' } });
    let capturedBody: unknown;
    (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse({ ok: true, data: { ok: true } });
    };

    const core = createAppCore(platform, new HeadlessAppViews());
    expect(core.submitFeedback).toBeInstanceOf(Function);
    await core.submitFeedback!('please add more character skins');

    expect(capturedBody).toEqual({ text: 'please add more character skins' });
  });
});

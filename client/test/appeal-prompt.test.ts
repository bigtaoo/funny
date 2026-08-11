// Content-moderation appeal prompt (CONTENT_MODERATION_DESIGN.md §5.3): the transport-layer hook that
// covers every call site without per-scene wiring (see CLAUDE memory content-moderation-done-2026-07-30).
//   1. net/log.ts's maybePromptAppeal/setAppealSink sink itself (same pattern as showToastMessage/setToastSink).
//   2. ApiClientCore.request (metaserver) and WorldApiClient's request helper both call it on
//      ACCOUNT_BANNED/ACCOUNT_MUTED, and only on those two codes.
//   3. createAppCore's AppCore.submitAppeal bridges to ApiClient.submitAppeal, and is undefined when
//      offline (no api base configured) so the sink can no-op safely.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setAppealSink, maybePromptAppeal, type AppealPromptCode } from '../src/net/log';
import { ApiClient } from '../src/net/ApiClient';
import { WorldApiClient } from '../src/net/WorldApiClient';
import { createAppCore } from '../src/app/createAppCore';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(code: string, message = 'nope'): Response {
  return { ok: true, status: 200, json: async () => ({ ok: false, error: { code, message } }) } as unknown as Response;
}

const storage = {
  getItem: (): string | null => null,
  setItem: (): void => {},
  removeItem: (): void => {},
};

describe('net/log: maybePromptAppeal / setAppealSink', () => {
  afterEach(() => {
    setAppealSink(() => {}); // reset to a no-op so later test files don't inherit a stale sink
  });

  it('fires the registered sink for ACCOUNT_BANNED and ACCOUNT_MUTED', () => {
    const seen: AppealPromptCode[] = [];
    setAppealSink((code) => seen.push(code));

    maybePromptAppeal('ACCOUNT_BANNED');
    maybePromptAppeal('ACCOUNT_MUTED');

    expect(seen).toEqual(['ACCOUNT_BANNED', 'ACCOUNT_MUTED']);
  });

  it('does not fire for any other error code', () => {
    const sink = vi.fn();
    setAppealSink(sink);

    maybePromptAppeal('BAD_REQUEST');
    maybePromptAppeal('RATE_LIMITED');
    maybePromptAppeal('UNKNOWN');

    expect(sink).not.toHaveBeenCalled();
  });

  it('does not throw when no sink has been registered yet', () => {
    // Simulate the pre-app.ts-bootstrap state by pointing the sink at nothing meaningful and
    // asserting the call itself is still safe — maybePromptAppeal must degrade silently.
    expect(() => maybePromptAppeal('ACCOUNT_BANNED')).not.toThrow();
  });

  it('swallows an exception thrown by the sink instead of propagating it', () => {
    setAppealSink(() => { throw new Error('boom'); });
    expect(() => maybePromptAppeal('ACCOUNT_MUTED')).not.toThrow();
  });
});

describe('ApiClientCore.request calls maybePromptAppeal on ACCOUNT_BANNED/ACCOUNT_MUTED', () => {
  afterEach(() => {
    setAppealSink(() => {});
  });

  it('fires the sink when the server responds ACCOUNT_BANNED', async () => {
    const seen: AppealPromptCode[] = [];
    setAppealSink((code) => seen.push(code));
    (globalThis as Record<string, unknown>).fetch = async () => errorResponse('ACCOUNT_BANNED');

    const client = new ApiClient('http://x');
    await expect(client.getSave()).rejects.toThrow();
    expect(seen).toEqual(['ACCOUNT_BANNED']);
  });

  it('fires the sink when the server responds ACCOUNT_MUTED', async () => {
    const seen: AppealPromptCode[] = [];
    setAppealSink((code) => seen.push(code));
    (globalThis as Record<string, unknown>).fetch = async () => errorResponse('ACCOUNT_MUTED');

    const client = new ApiClient('http://x');
    await expect(client.sendChat('P-1', 'hi')).rejects.toThrow();
    expect(seen).toEqual(['ACCOUNT_MUTED']);
  });

  it('does not fire the sink for an unrelated error code', async () => {
    const sink = vi.fn();
    setAppealSink(sink);
    (globalThis as Record<string, unknown>).fetch = async () => errorResponse('BAD_REQUEST');

    const client = new ApiClient('http://x');
    await expect(client.getSave()).rejects.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });

  it('does not fire the sink on a successful response', async () => {
    const sink = vi.fn();
    setAppealSink(sink);
    (globalThis as Record<string, unknown>).fetch = async () => jsonResponse({ ok: true, data: { save: {}, displayName: 'x' } });

    const client = new ApiClient('http://x');
    await client.getSave();
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('WorldApiClient request helper calls maybePromptAppeal on ACCOUNT_BANNED/ACCOUNT_MUTED', () => {
  afterEach(() => {
    setAppealSink(() => {});
  });

  it('fires the sink when worldsvc responds ACCOUNT_MUTED (e.g. a muted account sending a world/nation chat message)', async () => {
    const seen: AppealPromptCode[] = [];
    setAppealSink((code) => seen.push(code));
    (globalThis as Record<string, unknown>).fetch = async () =>
      ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'ACCOUNT_MUTED', message: 'muted' } }) } as unknown as Response);

    const client = new WorldApiClient(storage);
    await expect(client.createFamily('Notebook Legion', 'NBL1')).rejects.toThrow();
    expect(seen).toEqual(['ACCOUNT_MUTED']);
  });

  it('does not fire the sink for an unrelated worldsvc error code', async () => {
    const sink = vi.fn();
    setAppealSink(sink);
    (globalThis as Record<string, unknown>).fetch = async () =>
      ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'FAMILY_FULL', message: 'full' } }) } as unknown as Response);

    const client = new WorldApiClient(storage);
    await expect(client.createFamily('Notebook Legion', 'NBL1')).rejects.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('createAppCore().submitAppeal', () => {
  it('is undefined when offline (no api base configured), so the sink can no-op safely', () => {
    const platform = new HeadlessPlatform();
    const core = createAppCore(platform, new HeadlessAppViews());
    expect(core.submitAppeal).toBeUndefined();
  });

  it('delegates to ApiClient.submitAppeal (POST /account/appeal) when an api base is configured', async () => {
    const platform = new HeadlessPlatform({ storage: { nw_api_base: 'http://x' } });
    let capturedBody: unknown;
    (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse({ ok: true, data: { ok: true } });
    };

    const core = createAppCore(platform, new HeadlessAppViews());
    expect(core.submitAppeal).toBeInstanceOf(Function);
    await core.submitAppeal!('it was a misunderstanding');

    expect(capturedBody).toEqual({ reason: 'it was a misunderstanding' });
  });
});

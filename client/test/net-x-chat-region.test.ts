// O-CM5 (CONTENT_MODERATION_DESIGN.md §8): the client never sent X-Chat-Region, so socialsvc's
// region-specific word lists (cn/de/en) never actually took effect — every real request fell through
// to httpApi.ts's `?? 'global'` default. This pins the client side of the fix: WorldApiClient's
// createFamily/sendFamilyMessage and ApiClient's sendChat must attach X-Chat-Region derived from the
// player's current i18n locale (chatRegion.ts, mirroring server/shared/src/chatFilter.ts's
// regionFromLocale: zh→cn, de→de, en→en).
import { describe, it, expect, afterEach } from 'vitest';
import { WorldApiClient } from '../src/net/WorldApiClient';
import { ApiClient } from '../src/net/ApiClient';
import { setLocale, initI18n } from '../src/i18n';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const storage = {
  getItem: (): string | null => null,
  setItem: (): void => {},
  removeItem: (): void => {},
};

describe('X-Chat-Region header wiring (O-CM5)', () => {
  afterEach(() => {
    setLocale('zh'); // restore default used by every other test in the suite
  });

  it('WorldApiClient.createFamily sends X-Chat-Region derived from the current locale', async () => {
    initI18n('zh'); // → locale 'zh' → region 'cn'
    let capturedHeaders: Record<string, string> | undefined;
    (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ ok: true, data: { familyId: 'fam:X' } });
    };

    const client = new WorldApiClient(storage);
    await client.createFamily('Notebook Legion', 'NBL1');

    expect(capturedHeaders?.['X-Chat-Region']).toBe('cn');
  });

  it('WorldApiClient.sendFamilyMessage sends X-Chat-Region for the "de" locale', async () => {
    setLocale('de');
    let capturedHeaders: Record<string, string> | undefined;
    (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ ok: true, data: { id: 'fm:1' } });
    };

    const client = new WorldApiClient(storage);
    await client.sendFamilyMessage('fam:X', 'hallo');

    expect(capturedHeaders?.['X-Chat-Region']).toBe('de');
  });

  it('ApiClient.sendChat sends X-Chat-Region for the "en" locale', async () => {
    setLocale('en');
    let capturedHeaders: Record<string, string> | undefined;
    (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ ok: true, data: { messageId: 'm1', ts: 0 } });
    };

    const client = new ApiClient('');
    await client.sendChat('P-1', 'hi there');

    expect(capturedHeaders?.['X-Chat-Region']).toBe('en');
  });
});

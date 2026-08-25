/**
 * wechatNetworkKind.ui.ts — `WechatPlatform.getNetworkKind()`'s string mapping (ASSET_PACKAGING §14.2).
 *
 * This is the one platform that can answer "what kind of link is this?" properly: the web's only
 * source, `navigator.connection`, is Chromium-only and simply does not exist in the mini-game
 * runtime, so before this the WeChat build read every link as "unknown" and prefetched ~5 MB on
 * any connection. `wx.getNetworkType` had never been called anywhere in the repo.
 *
 * A string map is exactly the kind of code that rots quietly — WeChat's `networkType` list has
 * already grown once ('5g' was added after launch), and a mapping that silently drops a new value
 * into the wrong bucket produces no error, just a worse decision. Hence a case per value, plus the
 * two failure paths (a `fail` callback, and the API throwing outright), which must both degrade to
 * "normal link" rather than reject: `shouldSkipPrefetch` awaits this, so a rejection would take
 * the whole prefetch chain down with it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { NetworkKind } from '../../src/assets/prefetchPolicy';

type WxStub = { getNetworkType(opts: { success?: (r: { networkType: string }) => void; fail?: (e: unknown) => void }): void };

function installWx(stub: WxStub | undefined): void {
  (globalThis as unknown as { wx?: WxStub }).wx = stub;
}
afterEach(() => { delete (globalThis as unknown as { wx?: WxStub }).wx; });

/** Answers with `networkType`, as the real API does on success. */
const reporting = (networkType: string): WxStub => ({
  getNetworkType: (opts) => opts.success?.({ networkType }),
});

async function kindFor(stub: WxStub | undefined): Promise<NetworkKind> {
  installWx(stub);
  // Imported lazily and re-imported per case: the module reads the ambient `wx` global at call
  // time, but importing it at file scope would bind before the stub exists on the first case.
  const { WechatPlatform } = await import('../../src/platform/wechat/WechatPlatform');
  return new WechatPlatform().getNetworkKind();
}

describe('WechatPlatform.getNetworkKind', () => {
  it.each([
    ['wifi', 'wifi'],
    ['none', 'none'],
    // Only 2g is slow enough that speculative bytes genuinely hurt.
    ['2g', 'slow'],
    ['3g', 'cellular'],
    ['4g', 'cellular'],
    ['5g', 'cellular'],
  ] as const)('maps networkType "%s" to %s', async (networkType, expected) => {
    expect(await kindFor(reporting(networkType))).toBe(expected);
  });

  // The list is an open set. A future '6g' must land somewhere sane rather than being mistaken for
  // a slow link (which would switch the prefetch off on the fastest connections there are).
  it('treats an unrecognised value as a normal link, not a slow one', async () => {
    expect(await kindFor(reporting('6g'))).toBe('cellular');
    expect(await kindFor(reporting('quantum'))).toBe('unknown');
  });

  it('resolves rather than rejects when the API reports failure', async () => {
    expect(await kindFor({ getNetworkType: (opts) => opts.fail?.(new Error('nope')) })).toBe('unknown');
  });

  // shouldSkipPrefetch() awaits this; a throw that escaped would reject the whole prefetch chain
  // rather than degrading to "prefetch normally".
  it('resolves rather than throwing when the API itself throws', async () => {
    expect(await kindFor({ getNetworkType: () => { throw new Error('boom'); } })).toBe('unknown');
  });

  // 'cellular' must NOT skip the prefetch — the rule is "links where speculative bytes genuinely
  // hurt", not "anything short of wifi", which would turn the prefetch off for most phones.
  // idlePrefetch.ui.ts pins the consuming side; this pins that 3g/4g/5g reach it as 'cellular'.
  it('never reports plain mobile data as slow', async () => {
    for (const t of ['3g', '4g', '5g']) {
      expect(await kindFor(reporting(t)), `${t} must not read as slow`).not.toBe('slow');
    }
  });
});

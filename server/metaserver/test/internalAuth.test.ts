// @nw/shared/internalAuth unit tests (S12-1): HTTP authentication between internal services.
// Runs in the metaserver workspace (shared has no standalone vitest; tsc -b is run before tests to build the shared dist).
import { describe, it, expect } from 'vitest';
import {
  parseInternalKeys,
  createInternalAuth,
  internalHeaders,
  outboundInternalKey,
  INTERNAL_KEY_HEADER,
  INTERNAL_CALLER_HEADER,
} from '@nw/shared';

describe('parseInternalKeys', () => {
  it('empty / unconfigured → {}', () => {
    expect(parseInternalKeys(undefined)).toEqual({});
    expect(parseInternalKeys('')).toEqual({});
  });

  it('parses caller=key list', () => {
    expect(parseInternalKeys('gateway=k1,meta=k2,worldsvc=k3')).toEqual({
      gateway: 'k1',
      meta: 'k2',
      worldsvc: 'k3',
    });
  });

  it('tolerant: skips segments missing = or with empty name/value, trims whitespace', () => {
    expect(parseInternalKeys(' gateway = k1 ,bad,=novalue,name=,meta=k2')).toEqual({
      gateway: 'k1',
      meta: 'k2',
    });
  });

  it('value containing = is not truncated (key may be base64)', () => {
    expect(parseInternalKeys('meta=ab==cd')).toEqual({ meta: 'ab==cd' });
  });
});

describe('outboundInternalKey', () => {
  it('registry has own entry → use dedicated key', () => {
    expect(outboundInternalKey('worldsvc', 'legacy', { worldsvc: 'wkey' })).toBe('wkey');
  });
  it('registry has no own entry → fall back to single shared key', () => {
    expect(outboundInternalKey('worldsvc', 'legacy', { meta: 'mkey' })).toBe('legacy');
  });
  it('empty registry → fallback', () => {
    expect(outboundInternalKey('meta', 'legacy', {})).toBe('legacy');
  });
});

describe('internalHeaders', () => {
  it('includes caller identity header + key header', () => {
    // Note: the second argument is the legacy fallback key, used directly when NW_INTERNAL_KEYS env is absent.
    const h = internalHeaders('admin', 'legacy');
    expect(h[INTERNAL_CALLER_HEADER]).toBe('admin');
    expect(h[INTERNAL_KEY_HEADER]).toBe('legacy');
  });
});

describe('createInternalAuth — single shared key fallback mode (empty registry)', () => {
  const auth = createInternalAuth({ legacyKey: 'shared-key' });

  it('strict=false', () => {
    expect(auth.strict).toBe(false);
  });

  it('correct key → ok, caller taken from x-internal-caller hint', () => {
    const r = auth.verify({ [INTERNAL_KEY_HEADER]: 'shared-key', [INTERNAL_CALLER_HEADER]: 'meta' });
    expect(r).toEqual({ ok: true, caller: 'meta' });
  });

  it('correct key but no caller header → ok, caller=null', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'shared-key' })).toEqual({ ok: true, caller: null });
  });

  it('wrong key → rejected', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'wrong' }).ok).toBe(false);
  });

  it('missing key header → rejected (no throw)', () => {
    expect(auth.verify({}).ok).toBe(false);
  });
});

describe('createInternalAuth — per-caller strict mode (non-empty registry)', () => {
  const auth = createInternalAuth({
    keys: { gateway: 'gk', meta: 'mk' },
    legacyKey: 'shared-key',
  });

  it('strict=true', () => {
    expect(auth.strict).toBe(true);
  });

  it('key matches → ok and identifies the owning caller (regardless of x-internal-caller header)', () => {
    const r = auth.verify({ [INTERNAL_KEY_HEADER]: 'gk', [INTERNAL_CALLER_HEADER]: 'meta' });
    // Identity is proven by the key itself: gk belongs to gateway, so the spoofed caller=meta header has no effect on the outcome.
    expect(r).toEqual({ ok: true, caller: 'gateway' });
  });

  it('another registered caller\'s key → identified as that caller', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'mk' })).toEqual({ ok: true, caller: 'meta' });
  });

  it('legacyKey is no longer accepted in strict mode', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'shared-key' }).ok).toBe(false);
  });

  it('unregistered key → rejected', () => {
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'unknown' }).ok).toBe(false);
  });
});

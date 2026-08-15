// Unit tests for internalAuth.ts: parseInternalKeys, internalKeysFromEnv (module-level cache — isolated
// via vi.resetModules() + dynamic re-import per test that touches env), outboundInternalKey, internalHeaders,
// createInternalAuth (fallback + strict modes), and loadInternalAuth.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseInternalKeys,
  outboundInternalKey,
  internalHeaders,
  createInternalAuth,
  INTERNAL_KEY_HEADER,
  INTERNAL_CALLER_HEADER,
} from '../src/internalAuth';

describe('parseInternalKeys', () => {
  it('undefined input returns {}', () => {
    expect(parseInternalKeys(undefined)).toEqual({});
  });

  it('parses a normal "a=1,b=2" string', () => {
    expect(parseInternalKeys('a=1,b=2')).toEqual({ a: '1', b: '2' });
  });

  it('trims whitespace around name/key', () => {
    expect(parseInternalKeys(' a = 1 , b = 2 ')).toEqual({ a: '1', b: '2' });
  });

  it('skips segments with no "="', () => {
    expect(parseInternalKeys('a=1,noequalshere,b=2')).toEqual({ a: '1', b: '2' });
  });

  it('skips segments with an empty name (leading "=")', () => {
    expect(parseInternalKeys('=novalue,a=1')).toEqual({ a: '1' });
  });

  it('skips segments with an empty key (trailing "=")', () => {
    expect(parseInternalKeys('a=,b=2')).toEqual({ b: '2' });
  });

  it('empty string input returns {} (falsy short-circuit)', () => {
    expect(parseInternalKeys('')).toEqual({});
  });
});

describe('internalKeysFromEnv (module-level cache)', () => {
  const ORIGINAL = process.env.NW_INTERNAL_KEYS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NW_INTERNAL_KEYS;
    else process.env.NW_INTERNAL_KEYS = ORIGINAL;
  });

  it('reads and caches process.env.NW_INTERNAL_KEYS on first call', async () => {
    vi.resetModules();
    process.env.NW_INTERNAL_KEYS = 'gateway=key1,meta=key2';
    const mod = await import('../src/internalAuth');
    expect(mod.internalKeysFromEnv()).toEqual({ gateway: 'key1', meta: 'key2' });
  });

  it('subsequent calls return the cached value even if env changes afterward', async () => {
    vi.resetModules();
    process.env.NW_INTERNAL_KEYS = 'gateway=key1';
    const mod = await import('../src/internalAuth');
    expect(mod.internalKeysFromEnv()).toEqual({ gateway: 'key1' });
    process.env.NW_INTERNAL_KEYS = 'gateway=changed';
    expect(mod.internalKeysFromEnv()).toEqual({ gateway: 'key1' }); // still cached
  });

  it('with NW_INTERNAL_KEYS unset, caches an empty object', async () => {
    vi.resetModules();
    delete process.env.NW_INTERNAL_KEYS;
    const mod = await import('../src/internalAuth');
    expect(mod.internalKeysFromEnv()).toEqual({});
  });
});

describe('outboundInternalKey', () => {
  it('returns the caller\'s own registry key when present', () => {
    expect(outboundInternalKey('gateway', 'legacy-key', { gateway: 'gw-key' })).toBe('gw-key');
  });

  it('falls back to legacyKey when the caller is not in the registry', () => {
    expect(outboundInternalKey('gateway', 'legacy-key', { meta: 'meta-key' })).toBe('legacy-key');
  });

  it('falls back to legacyKey when the registry is empty', () => {
    expect(outboundInternalKey('gateway', 'legacy-key', {})).toBe('legacy-key');
  });
});

describe('internalHeaders', () => {
  it('assembles the x-internal-key and x-internal-caller headers', () => {
    const headers = internalHeaders('matchsvc', 'legacy-key');
    expect(headers[INTERNAL_KEY_HEADER]).toBe('legacy-key');
    expect(headers[INTERNAL_CALLER_HEADER]).toBe('matchsvc');
  });

  it('uses the caller-specific key when internalKeysFromEnv would resolve one', () => {
    // outboundInternalKey defaults its registry param to internalKeysFromEnv(); without stubbing env
    // this exercises the "registry defaults to env, falls back to legacy" path end-to-end.
    const headers = internalHeaders('gameserver', 'legacy-key');
    expect(headers[INTERNAL_CALLER_HEADER]).toBe('gameserver');
    expect(typeof headers[INTERNAL_KEY_HEADER]).toBe('string');
  });
});

describe('createInternalAuth — fallback mode (empty keys)', () => {
  it('strict is false when keys is empty/omitted', () => {
    const auth = createInternalAuth({ legacyKey: 'legacy' });
    expect(auth.strict).toBe(false);
  });

  it('accepts a presented key equal to legacyKey, caller taken from x-internal-caller header', () => {
    const auth = createInternalAuth({ legacyKey: 'legacy' });
    const result = auth.verify({ [INTERNAL_KEY_HEADER]: 'legacy', [INTERNAL_CALLER_HEADER]: 'gateway' });
    expect(result).toEqual({ ok: true, caller: 'gateway' });
  });

  it('caller is null when x-internal-caller header is absent', () => {
    const auth = createInternalAuth({ legacyKey: 'legacy' });
    const result = auth.verify({ [INTERNAL_KEY_HEADER]: 'legacy' });
    expect(result).toEqual({ ok: true, caller: null });
  });

  it('rejects a presented key that does not match legacyKey', () => {
    const auth = createInternalAuth({ legacyKey: 'legacy' });
    const result = auth.verify({ [INTERNAL_KEY_HEADER]: 'wrong' });
    expect(result).toEqual({ ok: false, caller: null });
  });

  it('rejects when no key is presented at all', () => {
    const auth = createInternalAuth({ legacyKey: 'legacy' });
    expect(auth.verify({})).toEqual({ ok: false, caller: null });
  });

  it('handles x-internal-caller as an array header (takes the first element)', () => {
    const auth = createInternalAuth({ legacyKey: 'legacy' });
    const result = auth.verify({ [INTERNAL_KEY_HEADER]: 'legacy', [INTERNAL_CALLER_HEADER]: ['gateway', 'other'] });
    expect(result).toEqual({ ok: true, caller: 'gateway' });
  });

  it('handles x-internal-key as an array header (takes the first element)', () => {
    const auth = createInternalAuth({ legacyKey: 'legacy' });
    const result = auth.verify({ [INTERNAL_KEY_HEADER]: ['legacy', 'other'] });
    expect(result).toEqual({ ok: true, caller: null });
  });
});

describe('createInternalAuth — strict mode (non-empty keys)', () => {
  it('strict is true when keys is non-empty', () => {
    const auth = createInternalAuth({ keys: { gateway: 'gw-key' }, legacyKey: 'legacy' });
    expect(auth.strict).toBe(true);
  });

  it('identifies the matching caller by key', () => {
    const auth = createInternalAuth({ keys: { gateway: 'gw-key', meta: 'meta-key' }, legacyKey: 'legacy' });
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'gw-key' })).toEqual({ ok: true, caller: 'gateway' });
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'meta-key' })).toEqual({ ok: true, caller: 'meta' });
  });

  it('returns ok:false, caller:null for a key not in the registry', () => {
    const auth = createInternalAuth({ keys: { gateway: 'gw-key' }, legacyKey: 'legacy' });
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'unknown-key' })).toEqual({ ok: false, caller: null });
  });

  it('does NOT accept the legacy key in strict mode', () => {
    const auth = createInternalAuth({ keys: { gateway: 'gw-key' }, legacyKey: 'legacy' });
    expect(auth.verify({ [INTERNAL_KEY_HEADER]: 'legacy' })).toEqual({ ok: false, caller: null });
  });

  it('returns ok:false immediately when presented is empty/undefined', () => {
    const auth = createInternalAuth({ keys: { gateway: 'gw-key' }, legacyKey: 'legacy' });
    expect(auth.verify({})).toEqual({ ok: false, caller: null });
  });
});

describe('loadInternalAuth', () => {
  const ORIGINAL = process.env.NW_INTERNAL_KEYS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NW_INTERNAL_KEYS;
    else process.env.NW_INTERNAL_KEYS = ORIGINAL;
  });

  it('builds a strict verifier from NW_INTERNAL_KEYS env', async () => {
    vi.resetModules();
    process.env.NW_INTERNAL_KEYS = 'gateway=gw-key';
    const mod = await import('../src/internalAuth');
    const auth = mod.loadInternalAuth('legacy');
    expect(auth.strict).toBe(true);
    expect(auth.verify({ [mod.INTERNAL_KEY_HEADER]: 'gw-key' })).toEqual({ ok: true, caller: 'gateway' });
  });

  it('builds a fallback verifier when NW_INTERNAL_KEYS is unset', async () => {
    vi.resetModules();
    delete process.env.NW_INTERNAL_KEYS;
    const mod = await import('../src/internalAuth');
    const auth = mod.loadInternalAuth('legacy');
    expect(auth.strict).toBe(false);
    expect(auth.verify({ [mod.INTERNAL_KEY_HEADER]: 'legacy' })).toEqual({ ok: true, caller: null });
  });
});

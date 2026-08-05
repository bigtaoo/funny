// Regression coverage for platform/uuid.ts — previously zero tests despite backing the anonymous
// device identity used for Web/CrazyGames analytics (S0-4). Covers all three genUuid() generation
// paths and the getOrCreateDeviceId() persistence contract.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { genUuid, getOrCreateDeviceId } from '../src/platform/uuid';
import type { IStorage } from '../src/platform/IPlatform';

function memStore(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('genUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('produces a well-formed v4 UUID via crypto.randomUUID when available (the default path)', () => {
    const id = genUuid();
    expect(id).toMatch(UUID_RE);
  });

  it('produces distinct ids across calls', () => {
    expect(genUuid()).not.toBe(genUuid());
  });

  it('falls back to manual construction via crypto.getRandomValues when randomUUID is absent', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    const id = genUuid();
    expect(id).toMatch(UUID_RE);
    // Version 4 (bits 6-7 of byte 6 = 0100) and RFC4122 variant (bits 6-7 of byte 8 = 10xx).
    expect(id[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(id[19]!.toLowerCase());
  });

  it('falls back to a time+random string when crypto is entirely unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const id = genUuid();
    expect(id.startsWith('dev-')).toBe(true);
    expect(id).not.toMatch(UUID_RE);
  });
});

describe('getOrCreateDeviceId', () => {
  it('generates and persists an id on first call', () => {
    const store = memStore();
    expect(store.getItem('nw_device_id')).toBeNull();

    const id = getOrCreateDeviceId(store);
    expect(id).toMatch(UUID_RE);
    expect(store.getItem('nw_device_id')).toBe(id);
  });

  it('returns the same id on subsequent calls instead of generating a new one', () => {
    const store = memStore();
    const first = getOrCreateDeviceId(store);
    const second = getOrCreateDeviceId(store);
    expect(second).toBe(first);
  });

  it('reads back a pre-existing id without overwriting it', () => {
    const store = memStore();
    store.setItem('nw_device_id', 'pre-existing-id');
    expect(getOrCreateDeviceId(store)).toBe('pre-existing-id');
    expect(store.getItem('nw_device_id')).toBe('pre-existing-id');
  });
});

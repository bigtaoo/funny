// i18n's INITIAL locale — the one thing i18n.test.ts cannot reach. `detectInitialLocale()` runs
// once at module-evaluation time (`let locale: Locale = detectInitialLocale()`), so by the time a
// test that imports the module normally can run, the decision is already made and unobservable.
// It was the only partially-covered branch left in the package's gated scope.
//
// What it protects is not exotic: pick 中文, reload the editor, it must still be 中文. That is a
// pure localStorage round-trip, and the whole of it lives in a function no other test can call.
// Each case re-imports the module under a different localStorage stand-in via vi.resetModules().
//
// Kept in its own file, not appended to i18n.test.ts: that file imports `../src/i18n` at the top
// level (as it should — it tests the live dictionaries), which would evaluate the module before any
// stubbing here could take effect.
//
// The storage KEY is deliberately never written down here. It is a module-private constant, and the
// first draft of this file hardcoded a guess at it — which passed four of five cases, because a
// wrong key is indistinguishable from an empty store. Driving the round-trip through setLocale()
// instead pins something a literal cannot: that the key detectInitialLocale reads is the same key
// setLocale writes. Divergent keys would produce an editor that saves your language and then
// forgets it on every reload, with both halves individually "working".
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  /** Test-only: what the module actually persisted, without this file needing to know the key. */
  keys(): string[];
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

/** Loads a FRESH copy of src/i18n with `localStorage` replaced — i.e. simulates a page reload. */
async function boot(stub: unknown) {
  vi.resetModules();
  vi.stubGlobal('localStorage', stub);
  return await import('../src/i18n');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('initial locale', () => {
  it('restores the locale the previous session persisted, in both directions', async () => {
    const store = fakeStorage();

    (await boot(store)).setLocale('zh');
    expect(store.keys(), 'setLocale persisted nothing — the round-trip below would pass vacuously').toHaveLength(1);
    expect((await boot(store)).getLocale()).toBe('zh');

    (await boot(store)).setLocale('en');
    expect((await boot(store)).getLocale()).toBe('en');
  });

  it('defaults to en when nothing is saved', async () => {
    expect((await boot(fakeStorage())).getLocale()).toBe('en');
  });

  it('ignores a junk saved value instead of trusting it', async () => {
    // The stored string is user-writable (devtools, a stale build, a hand-edited profile). Anything
    // that is not exactly 'en'/'zh' must fall through to the default, because `locale` indexes the
    // dictionary map directly — a bogus value would make every t() lookup read undefined[key].
    // The key is recovered from a real setLocale() rather than assumed.
    const probe = fakeStorage();
    (await boot(probe)).setLocale('zh');
    const key = probe.keys()[0]!;
    for (const junk of ['de', 'EN', 'zh-CN', '', 'null', '["zh"]']) {
      const locale = (await boot(fakeStorage({ [key]: junk }))).getLocale();
      expect(locale, `junk value ${JSON.stringify(junk)} was trusted`).toBe('en');
    }
  });

  it('survives localStorage being unavailable entirely', async () => {
    // Private browsing / blocked cookies: touching localStorage THROWS rather than returning null,
    // which is why detectInitialLocale wraps the read in try/catch. Without the catch this throws
    // during module evaluation and the whole editor fails to boot — a blank page, not a wrong
    // language. setLocale has the same guard, so toggling must not throw either.
    const throwing = {
      getItem: () => { throw new DOMException('SecurityError'); },
      setItem: () => { throw new DOMException('SecurityError'); },
      removeItem: () => {},
    };
    const mod = await boot(throwing);
    expect(mod.getLocale()).toBe('en');
    expect(() => mod.toggleLocale()).not.toThrow();
    expect(mod.getLocale()).toBe('zh');
  });

  it('keeps working when the global is missing altogether', async () => {
    // Same guard, different failure shape: the property access is on `undefined`, so the throw is a
    // TypeError from the access itself rather than from getItem.
    expect((await boot(undefined)).getLocale()).toBe('en');
  });
});

// `assets/prefetchPolicy.ts` at unit level — the mapping table and the storage edges that
// `idlePrefetch.test.ts` exercises only indirectly.
//
// That suite drives the whole warm-up chain and therefore only ever asks the policy the questions
// the chain asks: "may we speculate", "has this feature been used". It left four branches and two
// lines cold, and each of them is a silent one:
//
//   • `navigatorNetworkKind`'s `type` arm (wifi / ethernet / cellular) — the values the Network
//     Information API actually reports on desktop Chromium. Getting these wrong does not throw,
//     it just moves a player between "warms 2.0 MB" and "warms nothing", which is invisible until
//     somebody profiles a cold start.
//   • `setDataSaverEnabled(false)` — the OFF path is a `removeItem`, not a `setItem('0')`. A
//     regression to the latter would leave `isDataSaverEnabled()` reading `'0' === '1'` → false,
//     i.e. it would keep working by accident while the key silently accumulated; but flip the
//     comparison anywhere later and every player is a data-saver player.
//   • `markFeatureUsed`'s swallowed throw — a full or blocked `storage` (iOS private browsing,
//     a WebView with site data off) must never break the scene that called it. The catch is the
//     whole point of the function being safe to call from deep in the render tree.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installPrefetchPolicy, resetPrefetchPolicyForTest,
  markFeatureUsed, hasUsedFeature,
  isDataSaverEnabled, setDataSaverEnabled, DATA_SAVER_KEY,
  navigatorNetworkKind, networkKind, shouldSkipPrefetch,
  type NetworkKind,
} from '../src/assets/prefetchPolicy';
import type { IStorage } from '../src/platform/IPlatform';

/** In-memory platform storage, plus a switch that makes every write throw. */
function memStorage() {
  const map = new Map<string, string>();
  let failWrites = false;
  const storage: IStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (failWrites) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k) => {
      if (failWrites) throw new Error('QuotaExceededError');
      map.delete(k);
    },
  };
  return { storage, map, fail: () => { failWrites = true; } };
}

/** Install (or clear) `navigator.connection` for `navigatorNetworkKind` to read. */
function setConnection(conn: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(globalThis.navigator ?? {}), connection: conn },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  resetPrefetchPolicyForTest();
  setConnection(undefined);
});

describe('navigatorNetworkKind — the Network Information API mapping', () => {
  it('no API at all → unknown (Safari / Firefox / WeChat: assume a normal link)', () => {
    setConnection(undefined);
    expect(navigatorNetworkKind()).toBe('unknown');
  });

  it('saveData → slow, because both mean "do not spend bytes speculatively"', () => {
    setConnection({ saveData: true, type: 'wifi' });
    // Note it wins over `type: 'wifi'`: the player asked, the link's capability is irrelevant.
    expect(navigatorNetworkKind()).toBe('slow');
  });

  it('effectiveType 2g / slow-2g → slow', () => {
    setConnection({ effectiveType: 'slow-2g' });
    expect(navigatorNetworkKind()).toBe('slow');
    setConnection({ effectiveType: '2g' });
    expect(navigatorNetworkKind()).toBe('slow');
  });

  it('effectiveType 3g and up is NOT slow', () => {
    setConnection({ effectiveType: '3g' });
    expect(navigatorNetworkKind()).toBe('unknown');
    setConnection({ effectiveType: '4g' });
    expect(navigatorNetworkKind()).toBe('unknown');
  });

  it('type wifi and type ethernet both map to wifi', () => {
    setConnection({ type: 'wifi' });
    expect(navigatorNetworkKind()).toBe('wifi');
    setConnection({ type: 'ethernet' });
    expect(navigatorNetworkKind()).toBe('wifi');
  });

  it('type cellular maps to cellular — a distinct answer from slow, on purpose', () => {
    setConnection({ type: 'cellular' });
    expect(navigatorNetworkKind()).toBe('cellular');
  });

  it('an unrecognised type falls through to unknown rather than to a skip', () => {
    setConnection({ type: 'bluetooth' });
    expect(navigatorNetworkKind()).toBe('unknown');
  });
});

describe('shouldSkipPrefetch — which of those answers actually stops the warm-up', () => {
  it('skips only on slow and none; wifi / cellular / unknown all proceed', async () => {
    const kinds: Array<[NetworkKind, boolean]> = [
      ['wifi', false], ['cellular', false], ['unknown', false], ['slow', true], ['none', true],
    ];
    for (const [kind, expected] of kinds) {
      const { storage } = memStorage();
      installPrefetchPolicy({ storage, getNetworkKind: () => Promise.resolve(kind) });
      expect(await shouldSkipPrefetch(), `${kind}`).toBe(expected);
      resetPrefetchPolicyForTest();
    }
  });

  it('an installed platform probe replaces navigator.connection entirely (WeChat)', async () => {
    // The probe is the seam WechatPlatform uses for wx.getNetworkType, which has no web
    // equivalent. If navigator.connection were still consulted, a WeChat session on 2G would
    // read `unknown` from the absent API and prefetch anyway.
    setConnection({ type: 'wifi' });
    const { storage } = memStorage();
    installPrefetchPolicy({ storage, getNetworkKind: () => Promise.resolve('slow') });
    expect(await networkKind()).toBe('slow');
    expect(await shouldSkipPrefetch()).toBe(true);
  });

  it('with no probe installed it falls back to navigator.connection', async () => {
    setConnection({ effectiveType: '2g' });
    const { storage } = memStorage();
    installPrefetchPolicy({ storage });
    expect(await networkKind()).toBe('slow');
  });
});

describe('the data-saver switch', () => {
  let mem: ReturnType<typeof memStorage>;

  beforeEach(() => {
    mem = memStorage();
    installPrefetchPolicy({ storage: mem.storage, getNetworkKind: () => Promise.resolve('wifi') });
  });

  it('off by default', () => {
    expect(isDataSaverEnabled()).toBe(false);
  });

  it('on writes the flag; off REMOVES the key rather than writing a falsy value', () => {
    setDataSaverEnabled(true);
    expect(mem.map.get(DATA_SAVER_KEY)).toBe('1');
    expect(isDataSaverEnabled()).toBe(true);

    setDataSaverEnabled(false);
    expect(mem.map.has(DATA_SAVER_KEY)).toBe(false);
    expect(isDataSaverEnabled()).toBe(false);
  });

  it('overrides even a wifi link', async () => {
    setDataSaverEnabled(true);
    expect(await shouldSkipPrefetch()).toBe(true);
  });
});

describe('usage marks', () => {
  it('unset by default, set per feature, and independent of each other', () => {
    const { storage } = memStorage();
    installPrefetchPolicy({ storage });
    expect(hasUsedFeature('world')).toBe(false);
    expect(hasUsedFeature('gacha')).toBe(false);

    markFeatureUsed('world');
    expect(hasUsedFeature('world')).toBe(true);
    expect(hasUsedFeature('gacha')).toBe(false);
  });

  it('a storage that throws on write loses the mark but never the caller', () => {
    // markFeatureUsed is called from WorldMapRenderer/lifecycle.ts, i.e. from inside a scene
    // build. A throw there would take the screen down over a performance hint.
    const mem = memStorage();
    installPrefetchPolicy({ storage: mem.storage });
    mem.fail();
    expect(() => markFeatureUsed('world')).not.toThrow();
    expect(hasUsedFeature('world')).toBe(false);
  });

  it('with nothing installed at all, marks read false and writes are inert', () => {
    // The uninstalled state is what unit tests and the headless full-link harness run in; the
    // documented contract is "no marks, no data-saver", i.e. the gated L1 waves stay off.
    resetPrefetchPolicyForTest();
    expect(() => markFeatureUsed('gacha')).not.toThrow();
    expect(hasUsedFeature('gacha')).toBe(false);
    expect(isDataSaverEnabled()).toBe(false);
    expect(() => setDataSaverEnabled(true)).not.toThrow();
    expect(isDataSaverEnabled()).toBe(false);
  });
});

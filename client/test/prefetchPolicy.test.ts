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
// Since 2026-09-10 (§14.6) it also owns the stored-value half of the expiry window: the chain can
// only ever produce a mark this build wrote, so the legacy flag, a future stamp and outright junk
// are reachable from here and nowhere else.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installPrefetchPolicy, resetPrefetchPolicyForTest,
  markFeatureUsed, hasUsedFeature, FEATURE_MARK_TTL_MS,
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

/**
 * The storage key `markFeatureUsed('world')` writes. Spelled out rather than imported (it isn't
 * exported) because the tests below are about what is already sitting in a shipped player's
 * storage under exactly this name.
 */
const WORLD_KEY = 'nw_used_world';

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

  it('stores when, not whether — the value is a timestamp', () => {
    // The window in hasUsedFeature is the whole point of §14.6, and it can only exist if the
    // write side stops writing a flag. A regression to '1' would read as a legacy mark forever.
    const { storage, map } = memStorage();
    installPrefetchPolicy({ storage });
    const before = Date.now();
    markFeatureUsed('world');
    const stored = Number(map.get(WORLD_KEY));
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(Date.now());
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

/**
 * The expiry window (§14.6). `idlePrefetch.test.ts` pins the two edges through the whole warm-up
 * chain; what is only reachable from here is what the STORED VALUE can be — a legacy flag, a
 * clock that ran ahead, junk from some other writer — none of which the chain can produce.
 *
 * These drive the clock by writing the stamp rather than by faking timers: the question is always
 * "how old is this value", and an age is easier to read as an age.
 */
describe('usage marks expire', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A world mark whose last visit was `ageMs` ago. */
  function markAged(ageMs: number) {
    const mem = memStorage();
    installPrefetchPolicy({ storage: mem.storage });
    mem.map.set(WORLD_KEY, String(Date.now() - ageMs));
    return mem;
  }

  it('a visit inside the window still counts', () => {
    markAged(FEATURE_MARK_TTL_MS - DAY);
    expect(hasUsedFeature('world')).toBe(true);
  });

  it('a visit past the window does not', () => {
    markAged(FEATURE_MARK_TTL_MS + DAY);
    expect(hasUsedFeature('world')).toBe(false);
  });

  it('an expired mark is left alone rather than deleted, and revives on the next visit', () => {
    // Documented behaviour, not an accident: hasUsedFeature is a reader. Pinning it here means a
    // future "tidy up expired keys" change has to be a deliberate one.
    const mem = markAged(FEATURE_MARK_TTL_MS + DAY);
    expect(hasUsedFeature('world')).toBe(false);
    expect(mem.map.has(WORLD_KEY)).toBe(true);

    markFeatureUsed('world');
    expect(hasUsedFeature('world')).toBe(true);
  });

  it('a legacy "1" reads as used and is re-stamped to now', () => {
    // Every client shipped 2026-08-25 → 2026-09-10 wrote this. Number('1') is 1, i.e. 1970, so a
    // plain age check would expire the entire installed base's marks on upgrade day.
    const mem = memStorage();
    installPrefetchPolicy({ storage: mem.storage });
    mem.map.set(WORLD_KEY, '1');

    expect(hasUsedFeature('world')).toBe(true);
    expect(Number(mem.map.get(WORLD_KEY))).toBeGreaterThan(Date.now() - 5_000);
  });

  it('a stamp from the future is re-stamped, not trusted for a fortnight past it', () => {
    // A device whose clock was a year ahead and has since been corrected. Trusting the stored
    // value would keep the mark alive until a year and a fortnight from now.
    const mem = memStorage();
    installPrefetchPolicy({ storage: mem.storage });
    mem.map.set(WORLD_KEY, String(Date.now() + 365 * DAY));

    expect(hasUsedFeature('world')).toBe(true);
    expect(Number(mem.map.get(WORLD_KEY))).toBeLessThanOrEqual(Date.now());
  });

  it('an unparseable value is treated as a mark of unknown age, not as no mark', () => {
    const mem = memStorage();
    installPrefetchPolicy({ storage: mem.storage });
    mem.map.set(WORLD_KEY, 'yes');

    expect(hasUsedFeature('world')).toBe(true);
    expect(Number(mem.map.get(WORLD_KEY))).toBeGreaterThan(Date.now() - 5_000);
  });

  it('re-stamping through a storage that throws answers used and does not throw', () => {
    // Same contract as markFeatureUsed's own swallowed throw, on the read path this time —
    // hasUsedFeature runs inside the prefetch chain, whose whole job is to never take anything
    // down with it.
    const mem = memStorage();
    installPrefetchPolicy({ storage: mem.storage });
    mem.map.set(WORLD_KEY, '1');
    mem.fail();

    expect(() => hasUsedFeature('world')).not.toThrow();
    expect(hasUsedFeature('world')).toBe(true);
  });
});

import { CapacitorUpdater } from '@capgo/capacitor-updater';

// OTA hot-update (IOS_RELEASE.md §11). Self-hosted, manual mode: on each cold start we first
// confirm the running bundle booted OK (notifyAppReady → arms Capgo's auto-rollback), then fetch
// our own static manifest and, if it names a newer *and* native-compatible bundle, download it and
// arm it for the NEXT launch via next() — we never reload mid-session.
//
// Compliance (Apple 3.3.1): OTA ships only JS / web-asset changes that don't alter the app's
// purpose or introduce off-store payment paths. Anything touching native code ships through the
// App Store; `minNativeVersion` gates a bundle so old shells don't pull a build they can't run.

const MANIFEST_URL = 'https://ota.gamestao.com/manifest.json';
const FETCH_TIMEOUT_MS = 8000;

interface OtaManifest {
  /** Target bundle version — monotonic, same value baked as NW_BUILD_VERSION. */
  version: string;
  /** URL of the zipped `build:mobile` dist for that version. */
  url: string;
  /** Optional integrity hash; when present Capgo verifies the download and rejects on mismatch. */
  checksum?: string;
  /** Require the native shell to be >= this; otherwise skip and wait for an App Store update. */
  minNativeVersion?: string;
}

/** Version compiled into the JS running right now — the App Store builtin or a prior OTA bundle. */
const RUNNING_VERSION = String(
  (globalThis as { __NW_BUILD_VERSION__?: string }).__NW_BUILD_VERSION__ ?? '0.0.0',
);

/** Dotted-numeric compare: true iff `a` is strictly newer than `b` (non-numeric parts treated as 0). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

async function fetchManifest(): Promise<OtaManifest> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${MANIFEST_URL}?_=${RUNNING_VERSION}`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    return (await res.json()) as OtaManifest;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget OTA check. Safe to call from any entry: it no-ops in dev builds and when the
 * Capgo native plugin is absent (plain web / WeChat), and it never throws — any failure leaves the
 * app on its current bundle so a bad network can't white-screen the game.
 */
export async function checkOtaUpdate(): Promise<void> {
  // Dev / non-production bundles carry no real version — nothing to compare against.
  if (RUNNING_VERSION === '0.0.0') return;

  // Confirm this bundle booted successfully; this is what arms Capgo's rollback for the bundle we
  // set next. If the plugin isn't present (not a native shell), bail quietly.
  try {
    await CapacitorUpdater.notifyAppReady();
  } catch {
    return;
  }

  try {
    const m = await fetchManifest();
    if (!m?.version || !m.url) return;
    if (!isNewer(m.version, RUNNING_VERSION)) return;

    if (m.minNativeVersion) {
      // `native` is the App Store shell version (CFBundleShortVersionString). If the update needs a
      // newer shell than installed, defer to an App Store update rather than shipping a broken bundle.
      const { native } = await CapacitorUpdater.current();
      if (isNewer(m.minNativeVersion, native)) return;
    }

    const bundle = await CapacitorUpdater.download({
      url: m.url,
      version: m.version,
      checksum: m.checksum,
    });
    // Arm for the next cold start — not set(), which would reload and interrupt the current session.
    await CapacitorUpdater.next({ id: bundle.id });
  } catch (e) {
    console.warn('[ota] update check skipped:', e);
  }
}

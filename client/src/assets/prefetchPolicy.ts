/**
 * prefetchPolicy.ts — the two questions `idlePrefetch` has to answer before it spends a byte:
 * **may we speculate at all**, and **is this particular wave worth speculating on** (ASSET_PACKAGING §14).
 *
 * Split out of idlePrefetch.ts because the answers come from places the prefetch itself cannot
 * reach: a player-facing setting, a per-platform network API, and a usage mark written by scene
 * code deep in the render tree. Installed once at boot (`installPrefetchPolicy`), same
 * module-level-singleton shape as `assetIO` and for the same reason — `markFeatureUsed` is called
 * from `WorldMapRenderer/lifecycle.ts`, which has no `IPlatform` handle and should not grow one
 * just to record a hint.
 *
 * ## Why usage marks, and why they may be wrong
 *
 * Before this, every non-metered player prefetched all ~5 MB, of which `slg:world` (2.0 MB) and
 * `gacha` (1.2 MB) are the two big ones — including players who had never opened either screen.
 * The world atlas is the worse half: 1960×1827 RGBA decodes to ~13.7 MB of memory, and that cost
 * lands on wifi too, so it is not a bandwidth question at all. (§12 was a mobile-crash
 * investigation; speculatively decoding 13.7 MB on a memory-capped WebView pulls the other way.)
 *
 * A mark is a **hint, not a permission check**, so it is deliberately kept cheap and local:
 * `platform.storage`, not the server-authoritative `flags` (which would cost a `PUT /flags` round
 * trip to record something a wrong answer costs nothing for). Being wrong in either direction is
 * free — every scene gate re-awaits the same idempotent, URL-keyed loaders, so an un-prefetched
 * screen just pays its own gate exactly as it did before this file existed, and a stale mark just
 * warms something the player has stopped using.
 */
import type { IStorage } from '../platform/IPlatform';

/** Waves that are only worth warming for a player who has actually been to that screen. */
export type PrefetchFeature = 'world' | 'gacha';

const USED_KEY: Record<PrefetchFeature, string> = {
  world: 'nw_used_world',
  gacha: 'nw_used_gacha',
};

/** Player-owned "don't spend my bandwidth speculatively" switch (SettingsScene). */
export const DATA_SAVER_KEY = 'nw_data_saver';

/**
 * How a platform describes the current link. Deliberately coarse — the only decisions riding on
 * it are "skip speculation entirely" vs "don't", and a finer taxonomy would invite the exact
 * over-tightening the `cellular` case exists to prevent (see {@link shouldSkipPrefetch}).
 */
export type NetworkKind = 'wifi' | 'cellular' | 'slow' | 'none' | 'unknown';

let storage: IStorage | null = null;
let platformProbe: (() => Promise<NetworkKind>) | null = null;

/**
 * Install the boot-time dependencies. `getNetworkKind` is optional: platforms that don't implement
 * it fall back to {@link navigatorNetworkKind}. Uninstalled (unit tests, the headless full-link
 * harness) everything degrades to "no storage, no platform probe", which reads as no marks and no
 * data-saver — i.e. the L1 waves that need a mark stay off.
 */
export function installPrefetchPolicy(deps: {
  storage: IStorage;
  getNetworkKind?: () => Promise<NetworkKind>;
}): void {
  storage = deps.storage;
  platformProbe = deps.getNetworkKind ?? null;
}

/** Test seam: forget the installed platform bindings. */
export function resetPrefetchPolicyForTest(): void {
  storage = null;
  platformProbe = null;
}

/**
 * Record that the player actually opened a feature's screen, so its assets are worth warming next
 * session. Called from the scene's own asset-demand site — NOT from the loaders, which the
 * prefetch itself calls (marking there would make every wave self-justifying after one run).
 */
export function markFeatureUsed(feature: PrefetchFeature): void {
  try {
    storage?.setItem(USED_KEY[feature], '1');
  } catch {
    // A full/blocked storage must never break a scene. Losing the mark just means one more
    // cold gate later, which is the pre-2026-08-25 behaviour anyway.
  }
}

export function hasUsedFeature(feature: PrefetchFeature): boolean {
  return storage?.getItem(USED_KEY[feature]) === '1';
}

export function isDataSaverEnabled(): boolean {
  return storage?.getItem(DATA_SAVER_KEY) === '1';
}

export function setDataSaverEnabled(on: boolean): void {
  if (on) storage?.setItem(DATA_SAVER_KEY, '1');
  else storage?.removeItem(DATA_SAVER_KEY);
}

/** Minimal shape of the (non-standard, Chromium-only) Network Information API. */
interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
  type?: string;
}

/**
 * Default probe: the Network Information API. Chromium-only — absent on Safari/Firefox, and
 * absent in the WeChat runtime, which is why WechatPlatform installs its own
 * (`wx.getNetworkType`, a real API with no web equivalent).
 *
 * `saveData` maps to `slow` rather than to a state of its own: both mean "do not spend bytes
 * speculatively", which is the only thing the caller does with the answer.
 */
export function navigatorNetworkKind(): NetworkKind {
  const conn = (globalThis.navigator as (Navigator & { connection?: NetworkInformation }) | undefined)?.connection;
  if (!conn) return 'unknown'; // API absent (Safari/Firefox/WeChat) — assume a normal link
  if (conn.saveData) return 'slow';
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return 'slow';
  if (conn.type === 'wifi' || conn.type === 'ethernet') return 'wifi';
  if (conn.type === 'cellular') return 'cellular';
  return 'unknown';
}

export function networkKind(): Promise<NetworkKind> {
  return platformProbe ? platformProbe() : Promise.resolve(navigatorNetworkKind());
}

/**
 * Whether to skip the speculative warm-up entirely.
 *
 * ⚠ `cellular` deliberately does NOT skip, and that boundary is load-bearing: the point is links
 * where speculative bytes genuinely hurt, not "anything short of wifi" — widening it would turn
 * the prefetch off for most phones, i.e. for most players. What keeps a normal 4G link honest is
 * not a stricter network test but a smaller speculative set (the per-feature marks above), which
 * is the same fix that also works on iOS Safari and anywhere else with no usable network API at
 * all. `test/idlePrefetch.test.ts` pins this boundary (it lived in `test/ui/` until 2026-09-02, which
 * is exactly why this file read 0% for so long — that layer reports no coverage).
 */
export async function shouldSkipPrefetch(): Promise<boolean> {
  if (isDataSaverEnabled()) return true;
  const kind = await networkKind();
  return kind === 'slow' || kind === 'none';
}

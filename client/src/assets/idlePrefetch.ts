/**
 * idlePrefetch.ts — warm the L1 tier while the player is reading the lobby
 * (ASSET_PACKAGING §11).
 *
 * Everything outside the boot manifest is fetched on scene entry, which is why the
 * FIRST battle, the FIRST world-map open and the FIRST gacha pull each pay a visible
 * loading gate even on a fast connection: the download only starts once the player has
 * already asked for the scene. But the seconds right after the lobby appears are almost
 * pure idle — the player is looking at a static screen and the socket is quiet. Spending
 * that window on the assets those gates will ask for turns most of them into cache hits.
 *
 * Deliberately conservative, because a prefetch that competes with real work is worse
 * than no prefetch:
 *   - **Strictly serial.** One wave at a time, each awaited. Parallel prefetch would
 *     contend for the connection with whatever the player actually did next.
 *   - **Idle-scheduled.** Each wave starts from `requestIdleCallback` (falling back to a
 *     timer where it doesn't exist, e.g. WeChat), so a busy main thread defers it.
 *   - **Cheapest first.** The battle set gates the most common next action; the 3.3 MB
 *     gacha set — the least likely and the largest — goes last.
 *   - **Opt-out on metered links.** `saveData` / 2g effective types skip it entirely.
 *
 * Every loader below is URL-keyed and idempotent, so a wave that the player "beats" by
 * entering the scene first costs nothing: the scene's own gate joins the in-flight
 * promise instead of issuing a second request.
 */
import { preloadBootBackground } from './bootManifest';
import { ensureBattleAssets } from './battleAssets';
import { worldAtlas } from '../render/atlas/worldAtlas';
import { preloadRewardIconArt } from '../render/rewardIcon';
import { preloadGachaTextures } from '../render/gachaArt';

/** Minimal shape of the (non-standard, Chromium-only) Network Information API. */
interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
}

/** True when the player has asked not to spend bandwidth speculatively. */
function isMeteredConnection(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!conn) return false; // API absent (Safari/Firefox/WeChat) — assume a normal link
  if (conn.saveData) return true;
  return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
}

/** Resolve on the next idle slot, or after `timeoutMs` at the latest. */
function whenIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as unknown as IdleWindow).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: timeoutMs });
    else setTimeout(resolve, timeoutMs);
  });
}

/** Ordered cheapest/likeliest first — see the "cheapest first" note in the file header. */
const WAVES: ReadonlyArray<{ id: string; run: () => Promise<unknown> }> = [
  // The boot manifest's background tier. Normally already resolved by the time we get
  // here (preloadBoot kicks it off); listed so a boot-time failure gets one more try.
  { id: 'boot:background', run: () => preloadBootBackground() },
  // Everything enterBattle's gate awaits: all 12 unit rigs + hero/spell card art.
  // Default skins only — an equipped skin is still resolved by the gate itself.
  { id: 'battle',          run: () => ensureBattleAssets({}) },
  // Tab-icon PNGs + coin/material atlases: every reward row in every meta scene.
  { id: 'icons:reward',    run: () => preloadRewardIconArt() },
  // SLG world map, one 1.2 MB sheet — WorldMapScene shows a cover until it decodes.
  { id: 'slg:world',       run: () => worldAtlas.load() },
  // 3.3 MB of card backs/frames/banners. Biggest and least urgent, so: last.
  { id: 'gacha',           run: () => preloadGachaTextures() },
];

let started = false;

/**
 * Start warming L1 in the background. Safe to call more than once (only the first call
 * does anything) and never rejects — a failed wave logs and the next one still runs,
 * exactly like the boot gate. Fire-and-forget: nothing awaits the returned promise.
 */
export function startIdlePrefetch(): Promise<void> {
  if (started) return Promise.resolve();
  started = true;
  if (isMeteredConnection()) {
    console.info('[prefetch] skipped: metered/save-data connection');
    return Promise.resolve();
  }
  return WAVES.reduce(
    (chain, wave, i) => chain
      // A generous first delay keeps the prefetch clear of the lobby's own construction
      // and its opening API calls; later waves only need to yield between each other.
      .then(() => whenIdle(i === 0 ? 3_000 : 1_000))
      .then(() => wave.run())
      .catch((err) => console.warn(`[prefetch] wave ${wave.id} failed:`, err)),
    Promise.resolve() as Promise<unknown>,
  ).then(() => { console.info('[prefetch] L1 warm'); });
}

/** Test seam: forget that a prefetch already ran. */
export function resetIdlePrefetchForTest(): void {
  started = false;
}

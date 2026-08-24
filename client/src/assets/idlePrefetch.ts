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
 *   - **Never mid-rotation.** A wave holds until the screen has been still for a moment — see
 *     awaitRotationQuiet for why idle-scheduling alone does not cover this.
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
import { lastRotationAt } from '../net/anomaly/deviceContext';

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

/** How long after an orientation flip a wave is held back. Comfortably past PixiAppViews'
 *  REBUILD_COALESCE_MS plus the rebuild itself, so the two never overlap. */
const ROTATION_QUIET_MS = 1_500;
/** Bound on how long a wave will wait for quiet, so continuous rotation can't stall the chain forever. */
const MAX_QUIET_WAITS = 4;

/**
 * Hold off while the screen is mid-rotation.
 *
 * `requestIdleCallback` is not enough on its own here: a rotation's cost is largely *off* the main
 * thread — the WebGL drawing buffer is reallocated and the lobby's textures are re-uploaded — so the
 * thread can look idle at the exact moment GPU and memory pressure peak. Decoding a multi-megabyte
 * texture into that window is the worst available timing, and on a memory-capped mobile WebView the
 * failure mode is not slowness but the renderer process being killed. Waiting a beat costs a prefetch
 * nothing: every wave is speculative by definition, and the scene gates re-await the same loaders.
 */
async function awaitRotationQuiet(): Promise<void> {
  for (let i = 0; i < MAX_QUIET_WAITS; i++) {
    const rot = lastRotationAt();
    if (rot === undefined) return;
    const since = Date.now() - rot;
    if (since >= ROTATION_QUIET_MS) return;
    await whenIdle(ROTATION_QUIET_MS - since);
  }
}

/** Ordered cheapest/likeliest first — see the "cheapest first" note in the file header. */
const WAVES: ReadonlyArray<{ id: string; run: () => Promise<unknown> }> = [
  // The boot manifest's background tier. Normally already resolved by the time we get
  // here (preloadBoot kicks it off); listed so a boot-time failure gets one more try.
  { id: 'boot:background', run: () => preloadBootBackground() },
  // Tab-icon PNGs + coin/material atlases: ~430 KB, and as of the scene-title icon pass every
  // menu screen needs them the moment it opens — the title bar, the tab strip that navigates to
  // it, and every reward row all draw from this set. Ahead of the battle wave despite the header
  // comment's "cheapest first" ordering rule, which this obeys anyway (it IS the cheapest): the
  // battle set only gates the first *battle*, while a player who taps any menu button in the first
  // seconds hits a scene that renders once and has no reason to redraw, so a late icon decode is
  // a permanently blank glyph there rather than a one-frame flash.
  { id: 'icons:reward',    run: () => preloadRewardIconArt() },
  // Everything enterBattle's gate awaits: all 12 unit rigs + hero/spell card art.
  // Default skins only — an equipped skin is still resolved by the gate itself.
  { id: 'battle',          run: () => ensureBattleAssets({}) },
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
      .then(() => awaitRotationQuiet())
      .then(() => wave.run())
      .catch((err) => console.warn(`[prefetch] wave ${wave.id} failed:`, err)),
    Promise.resolve() as Promise<unknown>,
  ).then(() => { console.info('[prefetch] L1 warm'); });
}

/** Test seam: forget that a prefetch already ran. */
export function resetIdlePrefetchForTest(): void {
  started = false;
}

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
 *   - **Cheapest first.** The battle set gates the most common next action; the gacha
 *     set — the least likely and the largest — goes last.
 *   - **Opt-out on metered links**, and on the player's own data-saver setting — see
 *     `prefetchPolicy.shouldSkipPrefetch`.
 *   - **Scoped to features the player actually uses** (2026-08-25, §14). The two big waves
 *     (`slg:world` 2.0 MB, `gacha` 1.2 MB) only run once the player has opened that screen at
 *     least once. Before this, every player warmed all ~5 MB including the two screens they
 *     might never visit — and the world atlas's real cost is not even the download but the
 *     ~13.7 MB its 1960×1827 RGBA page decodes to, which is spent on wifi just the same.
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
import { hasUsedFeature, shouldSkipPrefetch } from './prefetchPolicy';

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
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

/**
 * Ordered cheapest/likeliest first — see the "cheapest first" note in the file header.
 *
 * `when` (optional) gates a wave on evidence it is worth warming at all. A wave with no `when`
 * runs for everyone: those are the ones every player reaches (the boot background tier, the menu
 * icon set, the battle set — a first match is the one thing every account does).
 */
const WAVES: ReadonlyArray<{ id: string; run: () => Promise<unknown>; when?: () => boolean }> = [
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
  // SLG world map, one 2.0 MB sheet — WorldMapScene shows a cover until it decodes. Gated: this
  // is the single biggest asset in the game and, at 1960×1827 RGBA, ~13.7 MB decoded. A player who
  // has never opened the world map should not be carrying that, on any link.
  { id: 'slg:world',       run: () => worldAtlas.load(),      when: () => hasUsedFeature('world') },
  // 1.2 MB of card backs/frames/banners. Biggest of the rest and least urgent, so: last. Gated for
  // the same reason as the world map, and it has its own entry gate since 2026-08-25 either way.
  { id: 'gacha',           run: () => preloadGachaTextures(), when: () => hasUsedFeature('gacha') },
];

let started = false;

/**
 * Start warming L1 in the background. Safe to call more than once (only the first call
 * does anything) and never rejects — a failed wave logs and the next one still runs,
 * exactly like the boot gate. Fire-and-forget: nothing awaits the returned promise.
 */
export async function startIdlePrefetch(): Promise<void> {
  if (started) return;
  started = true;
  if (await shouldSkipPrefetch()) {
    console.info('[prefetch] skipped: metered link or data-saver setting');
    return;
  }
  // Decided once, up front, rather than per wave: the marks cannot change while the chain runs
  // (the player is sitting on the lobby), and evaluating them here is what makes the skip
  // reportable as one line instead of silently thinning the chain — see "no silent caps".
  const due = WAVES.filter((w) => !w.when || w.when());
  const skipped = WAVES.filter((w) => !due.includes(w)).map((w) => w.id);
  if (skipped.length) console.info(`[prefetch] not warming (never opened): ${skipped.join(', ')}`);

  await due.reduce(
    (chain, wave, i) => chain
      // A generous first delay keeps the prefetch clear of the lobby's own construction
      // and its opening API calls; later waves only need to yield between each other.
      .then(() => whenIdle(i === 0 ? 3_000 : 1_000))
      .then(() => awaitRotationQuiet())
      .then(() => wave.run())
      .catch((err) => console.warn(`[prefetch] wave ${wave.id} failed:`, err)),
    Promise.resolve() as Promise<unknown>,
  );
  console.info('[prefetch] L1 warm');
}

/** Test seam: forget that a prefetch already ran. */
export function resetIdlePrefetchForTest(): void {
  started = false;
}

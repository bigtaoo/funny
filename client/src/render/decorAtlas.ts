/**
 * decorAtlas.ts — the battlefield "doodle layer" sprite atlas (art-direction §6.2,
 * A-group). Hand-drawn margin doodles (sun / star / heart / scribble …) that
 * BoardView snaps onto the paper just outside the grid and bakes into a static
 * texture. Packed into the shared decorMergedAtlas (see that module) alongside
 * the C-group and battle corner labels; frame names are the `decor_*` subset.
 *
 * Loaded once at app boot (`loadDecorAtlas`, fire-and-forget — see app.ts) and
 * shared across every battle. The PNG decodes asynchronously, so BoardView only
 * bakes decorations once `isDecorReady()` is true; a battle entered before the
 * tiny atlas finishes loading simply renders without ambient doodles (purely
 * cosmetic, §6.2: "slight misalignment is fine — pure ambience"). In headless tests no renderer/atlas exists
 * and the decoration pass is skipped entirely.
 *
 * Frame names carry NO extension (e.g. `decor_sun`) — matches pack_decos.cjs.
 * Lines are the original ink colour (not white), so they are used as-is and must
 * NOT be tinted to a faction colour (§6.2 note).
 */
import { decorMergedAtlas as atlas, framesWithPrefix } from './decorMergedAtlas';

/** True once the atlas PNG has decoded and frames are parsed. */
export const isDecorReady = atlas.isReady;

/** Texture for a frame name (e.g. `decor_sun`), or null if not loaded/unknown. */
export const getDecorTexture = atlas.getTexture;

/** A-group frame names only (empty until loaded). */
export function decorFrameNames(): string[] {
  return framesWithPrefix('decor_');
}

/**
 * Decode + parse the atlas. Idempotent: concurrent / repeat calls share one
 * in-flight promise and a successful load sticks for the session. Rejects on a
 * PNG decode error so the boot caller can log it; callers may ignore the result
 * (decorations are optional ambience).
 */
export const loadDecorAtlas = atlas.load;

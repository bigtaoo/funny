/**
 * decorCAtlas.ts — Group-C hand-drawn decoration atlas loader (art-direction §6.2 C group).
 *
 * Group C is a set of larger themed assets (castle / catapult / paper plane / ink blot…,
 * ~128px, longest side twice that of Group A), used for paper-background ambience in lobby /
 * menu UI scenes; it coexists with the battlefield Group A atlas without interference.
 *
 * Packed into the shared decorMergedAtlas (see that module) alongside the A-group and
 * battle corner labels; frame names are the `decoc_*` subset (e.g. `decoc_crown`).
 * Loading is fully symmetric with decorAtlas.ts: fire-and-forget at app start, purely
 * decorative, a failure does not block startup; lines are the original black ink and
 * must NOT be tinted.
 */
import { decorMergedAtlas as atlas, framesWithPrefix } from './decorMergedAtlas';

/** True once the C-atlas PNG has decoded and frames are parsed. */
export const isDecorCReady = atlas.isReady;

/** Texture for a C-group frame name (e.g. `decoc_crown`), or null if not ready/unknown. */
export const getDecorCTexture = atlas.getTexture;

/** C-group frame names only (empty until loaded). */
export function decorCFrameNames(): string[] {
  return framesWithPrefix('decoc_');
}

/**
 * Decode + parse the C-group atlas. Idempotent: concurrent / repeat calls share
 * one in-flight promise. Rejects on PNG decode error; callers may ignore the result
 * (decorations are optional ambience).
 */
export const loadDecorCAtlas = atlas.load;

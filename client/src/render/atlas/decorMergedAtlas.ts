/**
 * decorMergedAtlas.ts — shared L0 atlas backing decorAtlas (A-group), decorCAtlas
 * (C-group), and labelDecor (battle corner labels).
 *
 * All three always load together at app boot (bootManifest.ts), so they're packed
 * into one PNG/JSON (`assets/decor/decor_merged_atlas.{png,json}`) and decoded once.
 * Frame names keep each group's original naming convention (`decor_*` / `decoc_*` /
 * `label_*` — all three prefixes are mutually exclusive, verified at merge time),
 * so `framesWithPrefix` lets decorAtlas/decorCAtlas keep exposing an own-group-only
 * frame-name list for their "pick a random doodle" callers (decorLayer/decorCLayer/
 * ResultScene) without picking up the other groups' frames.
 */
import * as PIXI from 'pixi.js-legacy';
import { createAtlasLoader } from './spriteAtlas';
import atlasUrl from '../../assets/decor/decor_merged_atlas.png';
import atlasData from '../../assets/decor/decor_merged_atlas.json';

export const decorMergedAtlas = createAtlasLoader(atlasUrl as string, atlasData as PIXI.ISpritesheetData, 'decor-merged');

/** Frame names in the shared sheet starting with `prefix` (empty until loaded). */
export function framesWithPrefix(prefix: string): string[] {
  return decorMergedAtlas.frameNames().filter((name) => name.startsWith(prefix));
}

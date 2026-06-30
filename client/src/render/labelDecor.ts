/**
 * labelDecor.ts — the battlefield "corner hand-lettering" textures (art-direction
 * §6.2, B-group). Four individual hand-drawn labels — `[START]` / `BOSS` / `WIN!` /
 * a curved `→ here` arrow — that get snapped into the paper margins around the
 * grid (see battleLabels.ts) to give a match that scribbled-notebook,
 * campaign-page feel.
 *
 * Unlike the A-group doodles (one packed atlas, decorAtlas.ts) these are a tiny
 * handful of separate PNGs, so we just decode each one as its own texture rather
 * than build a sheet. Loaded once at app boot (`loadLabelDecor`, fire-and-forget
 * — see app.ts) and shared across every battle. A battle entered before the PNGs
 * finish decoding simply renders without labels (purely cosmetic, like the
 * A-group ambience). In headless tests no renderer exists and the label pass is
 * skipped entirely.
 *
 * Lines are already the spec ink colour (red marker / blue pen — baked in by
 * art/ui/decos-b/pack_labels.cjs per "player=blue, enemy=red"), so they are used as-is and must
 * NOT be tinted (same rule as §6.2 note for the A group).
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import bossUrl  from '../assets/decor/battle/label_boss.png';
import startUrl from '../assets/decor/battle/label_start.png';
import winUrl   from '../assets/decor/battle/label_win.png';
import arrowUrl from '../assets/decor/battle/label_arrow_here.png';

/** Stable label names — one per B-group asset. */
export type LabelName = 'label_boss' | 'label_start' | 'label_win' | 'label_arrow_here';

const URLS: Record<LabelName, string> = {
  label_boss:       bossUrl  as string,
  label_start:      startUrl as string,
  label_win:        winUrl   as string,
  label_arrow_here: arrowUrl as string,
};

let textures: Record<LabelName, PIXI.Texture> | null = null;
let loading: Promise<void> | null = null;

/** True once all four label PNGs have decoded. */
export function isLabelDecorReady(): boolean {
  return textures !== null;
}

/** Texture for a label name, or null if not loaded yet. */
export function getLabelTexture(name: LabelName): PIXI.Texture | null {
  return textures ? textures[name] : null;
}

/**
 * Decode the four label PNGs. Idempotent: concurrent / repeat calls share one
 * in-flight promise and a successful load sticks for the session. Rejects if any
 * PNG fails to decode so the boot caller can log it; callers may ignore the
 * result (labels are optional ambience).
 */
export async function loadLabelDecor(): Promise<void> {
  if (textures) return;
  if (loading) return loading;
  loading = (async () => {
    const names = Object.keys(URLS) as LabelName[];
    const decoded = await Promise.all(names.map(async (name) => {
      const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(URLS[name]));
      return new Promise<PIXI.Texture>((resolve, reject) => {
        if (baseTex.valid) { resolve(new PIXI.Texture(baseTex)); return; }
        baseTex.once('loaded', () => resolve(new PIXI.Texture(baseTex)));
        baseTex.once('error', (err: unknown) => reject(new Error(`label decor load error (${name}): ${String(err)}`)));
      });
    }));
    const map = {} as Record<LabelName, PIXI.Texture>;
    names.forEach((name, i) => { map[name] = decoded[i]!; });
    textures = map;
  })();
  return loading;
}

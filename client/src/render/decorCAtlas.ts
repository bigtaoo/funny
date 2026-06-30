/**
 * decorCAtlas.ts — Group-C hand-drawn decoration atlas loader (art-direction §6.2 C group).
 *
 * Group C is a set of larger themed assets (castle / catapult / paper plane / ink blot…,
 * ~128px, longest side twice that of Group A), used for paper-background ambience in lobby /
 * menu UI scenes; it coexists with the battlefield Group A atlas without interference.
 *
 * The atlas lives at `client/src/assets/decor/decor_c_atlas.{png,json}` (not under the
 * battle/ subdirectory — it is general-purpose). Frame names have no extension (e.g. `decoc_crown`).
 * Loading is fully symmetric with decorAtlas.ts: fire-and-forget at app start, purely decorative,
 * a failure does not block startup; lines are the original black ink and must NOT be tinted.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/decor/decor_c_atlas.png';
import atlasData from '../assets/decor/decor_c_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the C-atlas PNG has decoded and frames are parsed. */
export function isDecorCReady(): boolean {
  return sheet !== null;
}

/** Texture for a C-group frame name (e.g. `decoc_crown`), or null if not ready/unknown. */
export function getDecorCTexture(name: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[name] ?? null) : null;
}

/** All available C-group frame names (empty until loaded). */
export function decorCFrameNames(): string[] {
  return sheet ? Object.keys(sheet.textures) : [];
}

/**
 * Decode + parse the C-group atlas. Idempotent: concurrent / repeat calls share
 * one in-flight promise. Rejects on PNG decode error; callers may ignore the result
 * (decorations are optional ambience).
 */
export async function loadDecorCAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`decor-c atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}

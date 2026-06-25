/**
 * decorAtlas.ts — the battlefield "doodle layer" sprite atlas (art-direction §6.2,
 * A 组). A single 256×256 TexturePacker sheet of hand-drawn margin doodles
 * (sun / star / heart / scribble …) that BoardView snaps onto the paper just
 * outside the grid and bakes into a static texture.
 *
 * Loaded once at app boot (`loadDecorAtlas`, fire-and-forget — see app.ts) and
 * shared across every battle. The PNG decodes asynchronously, so BoardView only
 * bakes decorations once `isDecorReady()` is true; a battle entered before the
 * tiny atlas finishes loading simply renders without ambient doodles (purely
 * cosmetic, §6.2: "错位无妨，纯氛围"). In headless tests no renderer/atlas exists
 * and the decoration pass is skipped entirely.
 *
 * Frame names carry NO extension (e.g. `decor_sun`) — matches pack_decos.cjs.
 * Lines are the original ink colour (not white), so they are used as-is and must
 * NOT be tinted to a faction colour (§6.2 注).
 */
import * as PIXI from 'pixi.js-legacy';
import atlasUrl from '../assets/decor/battle/decor_atlas.png';
import atlasData from '../assets/decor/battle/decor_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isDecorReady(): boolean {
  return sheet !== null;
}

/** Texture for a frame name (e.g. `decor_sun`), or null if not loaded/unknown. */
export function getDecorTexture(name: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[name] ?? null) : null;
}

/** All available frame names (empty until loaded). */
export function decorFrameNames(): string[] {
  return sheet ? Object.keys(sheet.textures) : [];
}

/**
 * Decode + parse the atlas. Idempotent: concurrent / repeat calls share one
 * in-flight promise and a successful load sticks for the session. Rejects on a
 * PNG decode error so the boot caller can log it; callers may ignore the result
 * (decorations are optional ambience).
 */
export async function loadDecorAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(atlasUrl as string);
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.on('loaded', () => resolve());
      baseTex.on('error', (err: unknown) => reject(new Error(`decor atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}

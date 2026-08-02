/**
 * spriteAtlas.ts — shared PixiJS Spritesheet loader factory.
 *
 * Every hand-packed atlas (decor/equipment/material/faction/avatar/SLG world-map
 * groups) used the same decode-BaseTexture-then-parse-Spritesheet dance with its
 * own idempotent load/cache bookkeeping, copy-pasted per atlas. `createAtlasLoader`
 * is the single implementation; each atlas module becomes a thin named wrapper
 * around one instance so call sites keep their existing function names/signatures.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../../assets/assetIO';

export interface AtlasLoader {
  /** True once the atlas PNG has decoded and frames are parsed. */
  isReady(): boolean;
  /** Texture for a frame name, or null if not loaded yet / unknown. */
  getTexture(name: string): PIXI.Texture | null;
  /** All available frame names (empty until loaded). */
  frameNames(): string[];
  /**
   * Decode + parse the atlas. Idempotent: concurrent/repeat calls share one
   * in-flight promise and a successful load sticks for the session. Rejects on
   * decode error so the caller can log it; callers generally treat atlases as
   * optional cosmetic upgrades and degrade to a procedural fallback on null.
   */
  load(): Promise<void>;
}

/**
 * `label` is only used to make a rejected load's error message identify the atlas.
 * `texOptions` forwards to the BaseTexture constructor (e.g. mipmap + LINEAR for
 * atlases whose frames get drawn far smaller than their packed cell).
 */
export function createAtlasLoader(
  url: string,
  data: PIXI.ISpritesheetData,
  label: string,
  texOptions?: Partial<PIXI.IBaseTextureOptions>,
): AtlasLoader {
  let sheet: PIXI.Spritesheet | null = null;
  let loading: Promise<void> | null = null;

  function load(): Promise<void> {
    if (sheet) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      try {
        const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(url), texOptions);
        await new Promise<void>((resolve, reject) => {
          if (baseTex.valid) { resolve(); return; }
          baseTex.once('loaded', () => resolve());
          baseTex.once('error', (err: unknown) => reject(new Error(`${label} atlas load error: ${String(err)}`)));
        });
        const ss = new PIXI.Spritesheet(baseTex, data);
        await ss.parse();
        sheet = ss;
      } catch (e) {
        // Reset the in-flight promise so a later load() call (e.g. after a network blip clears up)
        // retries instead of replaying this same rejection forever (audit 2026-07-29: a transient
        // failure used to permanently negative-cache the atlas for the rest of the session).
        loading = null;
        throw e;
      }
    })();
    return loading;
  }

  return {
    isReady: () => sheet !== null,
    getTexture: (name: string) => (sheet ? (sheet.textures[name] ?? null) : null),
    frameNames: () => (sheet ? Object.keys(sheet.textures) : []),
    load,
  };
}

/**
 * decorCAtlas.ts — C 组手绘装饰图集加载器（art-direction §6.2 C 组）。
 *
 * C 组是一套较大的主题素材（城堡/投石车/纸飞机/墨渍…，~128px，长边比 A 组大一倍），
 * 用于大厅/菜单等 UI 场景的纸面背景氛围，与战场 A 组并列存在、互不干扰。
 *
 * 图集位于 `client/src/assets/decor/decor_c_atlas.{png,json}`（非 battle/ 子目录，
 * 通用），帧名不带扩展名（如 `decoc_crown`）。加载方式与 decorAtlas.ts 完全对称：
 * App 启动时 fire-and-forget，纯装饰，失败不阻塞启动；线条为原黑墨，不 tint。
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

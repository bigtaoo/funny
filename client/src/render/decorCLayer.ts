/**
 * decorCLayer.ts — C 组 UI 大背景装饰层（art-direction §6.2 C 组）。
 *
 * 将 C 组手绘素材（城堡/投石车/纸飞机/墨渍…）以极低 alpha 随机散布在 UI 场景的
 * 纸面背景上（大厅/菜单等），营造"笔记本边角涂鸦"氛围。
 *
 * 设计约束（同 A 组 decorLayer.ts）：
 * - 原墨色，不 tint；faint alpha（0.06–0.15）绝不抢前景
 * - 确定性 PRNG（固定种子），每次 build 出相同布局
 * - 静态烘焙（`bake()`），运行期零开销；headless 无渲染器时回退 live Graphics
 * - interactiveChildren = false，不吃指针
 */
import * as PIXI from 'pixi.js-legacy';
import { Prng } from '../game/math/prng';
import { bake } from './bake';
import { decorCFrameNames, getDecorCTexture, isDecorCReady } from './decorCAtlas';

// ── Tuning ────────────────────────────────────────────────────────────────────
const SIZE_PX       = 96;    // target rendered size (px); C 组源帧 128px，稍缩
const SIZE_JITTER   = 0.25;  // ± fraction of SIZE_PX
const GRID_COLS     = 4;     // divide width into N columns for placement grid
const GRID_ROWS     = 6;     // divide height into N rows
const SKIP_PROB     = 0.55;  // most cells stay empty — sparse, not wallpaper
const ROT_MAX       = 0.45;  // ± radians; more relaxed than A 组 edge doodles
const ALPHA_MIN     = 0.06;
const ALPHA_RANGE   = 0.09;
const SEED          = 0xC09C_0FFE;  // "c coffee" — stable across UI redraws

function frand(p: Prng): number { return p.nextInt(1_000_000) / 1_000_000; }

/**
 * Build a static background scatter of C-group doodles covering `(w × h)`.
 * Returns null if the atlas is not yet loaded or no frames are available
 * (caller simply skips — decorations are optional ambience).
 * The returned Container holds one baked-texture Sprite and costs nothing
 * per frame; add it directly behind the UI content layer.
 */
export function buildDecorCLayer(w: number, h: number): PIXI.Container | null {
  if (!isDecorCReady()) return null;
  const frames = decorCFrameNames();
  if (frames.length === 0) return null;

  const prng = new Prng(SEED);
  const cellW = w / GRID_COLS;
  const cellH = h / GRID_ROWS;

  const content = new PIXI.Container();
  let placed = 0;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (frand(prng) < SKIP_PROB) continue;

      const name = frames[prng.nextInt(frames.length)]!;
      const tex = getDecorCTexture(name);
      if (!tex) continue;

      const spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);

      const sizeMul = 1 + (frand(prng) * 2 - 1) * SIZE_JITTER;
      const longest = Math.max(tex.width, tex.height) || SIZE_PX;
      spr.scale.set((SIZE_PX * sizeMul) / longest);
      spr.rotation = (frand(prng) * 2 - 1) * ROT_MAX;
      spr.alpha = ALPHA_MIN + frand(prng) * ALPHA_RANGE;

      // Random position within the cell, keeping the sprite fully inside (w × h).
      const halfW = (tex.width  * spr.scale.x) / 2;
      const halfH = (tex.height * spr.scale.y) / 2;
      const cellX = col * cellW;
      const cellY = row * cellH;
      const safeX0 = Math.max(halfW, cellX + halfW);
      const safeX1 = Math.min(w - halfW, cellX + cellW - halfW);
      const safeY0 = Math.max(halfH, cellY + halfH);
      const safeY1 = Math.min(h - halfH, cellY + cellH - halfH);
      spr.x = safeX0 + frand(prng) * Math.max(0, safeX1 - safeX0);
      spr.y = safeY0 + frand(prng) * Math.max(0, safeY1 - safeY0);

      content.addChild(spr);
      placed++;
    }
  }

  if (placed === 0) { content.destroy(); return null; }

  const root = new PIXI.Container();
  root.interactiveChildren = false;

  const tex = bake(`decorc:${Math.round(w)}x${Math.round(h)}`, content, w, h);
  content.destroy({ children: true });
  if (tex) {
    root.addChild(new PIXI.Sprite(tex));
  }
  // If bake fails (headless) we simply return an empty container — acceptable.

  return root;
}

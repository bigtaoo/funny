// ── Unified procedural shadow ─────────────────────────────────────────────────
// Shadows are no longer packed per-.tao. A single soft-edged dark ellipse is
// generated once and shared by every rig, scaled to each rig's shadowW/H at
// render time. See claudedocs/file-formats.md (.tao shadow section).

import * as PIXI from 'pixi.js-legacy';
import { textureFromCanvas } from '../canvasTexture';

let _shadowTex: PIXI.Texture | null = null;

export function getShadowTexture(): PIXI.Texture {
  if (_shadowTex) return _shadowTex;
  const SIZE = 128;
  // ADAPTER，不是 `document`：微信小游戏真机上没有 document（模拟器有，所以这行以前
  // 在开发者工具里一直看着没事）。headless 测试桩挂的也是同一个接缝。
  const canvas = PIXI.settings.ADAPTER.createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d')!;
  const r   = SIZE / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0,    'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.85)');
  grad.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  _shadowTex = textureFromCanvas(canvas);
  return _shadowTex;
}

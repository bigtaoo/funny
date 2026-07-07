// ── Unified procedural shadow ─────────────────────────────────────────────────
// Shadows are no longer packed per-.tao. A single soft-edged dark ellipse is
// generated once and shared by every rig, scaled to each rig's shadowW/H at
// render time. See claudedocs/file-formats.md (.tao shadow section).

import * as PIXI from 'pixi.js-legacy';

let _shadowTex: PIXI.Texture | null = null;

export function getShadowTexture(): PIXI.Texture {
  if (_shadowTex) return _shadowTex;
  const SIZE = 128;
  const canvas  = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
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
  _shadowTex = PIXI.Texture.from(canvas);
  return _shadowTex;
}

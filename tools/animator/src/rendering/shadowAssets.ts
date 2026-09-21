// Procedural shadow assets — split out of Renderer.ts (2026-09-21) once that file
// crossed the 500-line convention again, same move as skinHandles.ts before it.
// Both values are process-wide caches with no per-Renderer state, so they were
// already module-level functions inside Renderer.ts rather than methods; moving
// them here only changes where they live.
import * as PIXI from 'pixi.js';
import { Skeleton } from '../skeleton/Skeleton';

// Cache default shadow size (computed once from rest pose)
let _defaultShadow: { w: number; h: number } | null = null;
export function defaultShadowSize(): { w: number; h: number } {
  return (_defaultShadow ??= Skeleton.computeDefaultShadowSize());
}

// Unified procedural shadow — a single soft ellipse generated once, scaled to the
// shadow attachment point's shadowW/H. Mirrors the runtime (StickmanRuntime.ts) so
// the editor preview matches the game; shadows are no longer authored as images.
let _shadowTex: PIXI.Texture | null = null;
export function shadowTexture(): PIXI.Texture {
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

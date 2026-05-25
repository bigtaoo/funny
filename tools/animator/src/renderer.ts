/**
 * PixiJS renderer: canvas setup, grid, character drawing.
 * Reads from state + currentDeltas; called every ticker frame.
 */
import * as PIXI from 'pixi.js';
import { BONE_MAP, BONE_DEFS, HEAD_R, DRAW_ORDER, computeFK } from './skeleton';
import { state, currentDeltas } from './state';
import { getCurrentClip, sampleAnimation } from './animation';
import type { WorldPositions } from './types';

// ── PixiJS application + layers ───────────────────────────────────────────────

let app: PIXI.Application;
let gridGfx: PIXI.Graphics;
let onionGfx: PIXI.Graphics;
let charGfx: PIXI.Graphics;
let selGfx: PIXI.Graphics;

export function initRenderer(container: HTMLElement): PIXI.Application {
  const w = container.clientWidth;
  const h = container.clientHeight;

  app = new PIXI.Application({
    width: w,
    height: h,
    backgroundColor: 0xF5F0E8,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  const canvas = app.view as HTMLCanvasElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  gridGfx  = new PIXI.Graphics();
  onionGfx = new PIXI.Graphics();
  charGfx  = new PIXI.Graphics();
  selGfx   = new PIXI.Graphics();
  onionGfx.alpha = 0.2;

  app.stage.addChild(gridGfx, onionGfx, charGfx, selGfx);

  // Set initial root position
  state.rootX = w / 2;
  state.rootY = h / 2 + 30;

  drawGrid();
  return app;
}

/** Resize the renderer and update root position. */
export function resizeRenderer(w: number, h: number): void {
  app.renderer.resize(w, h);
  state.rootX = w / 2 + state.panOffsetX;
  state.rootY = h / 2 + 30 + state.panOffsetY;
  drawGrid();
}

// ── Grid ─────────────────────────────────────────────────────────────────────

export function drawGrid(): void {
  const { width: w, height: h } = app.renderer;
  const CELL = 48;
  gridGfx.clear();
  gridGfx.lineStyle({ width: 1, color: 0xC8D8E8, alpha: 0.5 });
  for (let x = 0; x < w; x += CELL) { gridGfx.moveTo(x, 0); gridGfx.lineTo(x, h); }
  for (let y = 0; y < h; y += CELL) { gridGfx.moveTo(0, y); gridGfx.lineTo(w, y); }
}

// ── Drawing primitives ────────────────────────────────────────────────────────

function drawTubularBone(
  g: PIXI.Graphics,
  sx: number, sy: number,
  ex: number, ey: number,
  outerW: number, innerW: number,
  alpha: number,
): void {
  g.lineStyle({ width: outerW, color: 0x222222, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  g.moveTo(sx, sy); g.lineTo(ex, ey);
  g.lineStyle({ width: innerW, color: 0xFFFFFF, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  g.moveTo(sx, sy); g.lineTo(ex, ey);
}

function drawHead(g: PIXI.Graphics, cx: number, cy: number, alpha: number): void {
  g.lineStyle({ width: 4, color: 0x222222, alpha });
  g.beginFill(0xFFFFFF, alpha);
  g.drawCircle(cx, cy, HEAD_R);
  g.endFill();
  // Eye dot (facing right)
  g.lineStyle(0);
  g.beginFill(0x222222, alpha);
  g.drawCircle(cx + HEAD_R * 0.38, cy - HEAD_R * 0.1, 3);
  g.endFill();
}

function drawJointCircle(
  g: PIXI.Graphics, x: number, y: number,
  r = 6, alpha = 1, color = 0x222222,
): void {
  g.lineStyle({ width: 2.5, color, alpha });
  g.beginFill(0xFFFFFF, alpha);
  g.drawCircle(x, y, r);
  g.endFill();
}

// ── Character render ─────────────────────────────────────────────────────────

interface DrawCharOpts {
  alpha?: number;
  selectedBone?: string | null;
  forceJoints?: boolean;
}

function drawCharacter(g: PIXI.Graphics, wp: WorldPositions, opts: DrawCharOpts = {}): void {
  const { alpha = 1, selectedBone = null, forceJoints = false } = opts;

  // Bones
  for (const boneId of DRAW_ORDER) {
    const bone = BONE_MAP[boneId];
    const pos = wp[boneId];
    if (!pos) continue;

    if (bone.isHead) {
      drawHead(g, pos.ex, pos.ey, alpha);
    } else if (bone.outerW && bone.innerW) {
      drawTubularBone(g, pos.sx, pos.sy, pos.ex, pos.ey, bone.outerW, bone.innerW, alpha);
    }
  }

  // Joints
  if (state.showJoints || forceJoints) {
    const drawn = new Set<string>();
    for (const bone of BONE_DEFS) {
      if (bone.id === 'root' || bone.isHead) continue;
      const pos = wp[bone.id];
      if (!pos) continue;
      const sk = `${pos.sx.toFixed(0)},${pos.sy.toFixed(0)}`;
      if (!drawn.has(sk)) { drawJointCircle(g, pos.sx, pos.sy, 6, alpha); drawn.add(sk); }
      const isLeaf = !BONE_DEFS.some(b => b.parent === bone.id);
      if (isLeaf) {
        const ek = `${pos.ex.toFixed(0)},${pos.ey.toFixed(0)}`;
        if (!drawn.has(ek)) { drawJointCircle(g, pos.ex, pos.ey, 5, alpha); drawn.add(ek); }
      }
    }
  }

  // Selection highlight
  if (selectedBone) {
    const pos = wp[selectedBone];
    const bone = BONE_MAP[selectedBone];
    if (pos && bone) {
      if (bone.isHead) {
        g.lineStyle({ width: 3, color: 0x74c7ec, alpha: 0.9 });
        g.beginFill(0, 0); g.drawCircle(pos.ex, pos.ey, HEAD_R + 5); g.endFill();
      } else {
        g.lineStyle({ width: (bone.outerW ?? 4) + 6, color: 0x74c7ec, alpha: 0.4, cap: PIXI.LINE_CAP.ROUND });
        g.moveTo(pos.sx, pos.sy); g.lineTo(pos.ex, pos.ey);
      }
    }
  }
}

// ── Main render call (called every ticker frame) ──────────────────────────────

export function renderScene(): void {
  const { rootX, rootY, selectedBone, showOnion, showGuide } = state;
  const wp = computeFK(rootX, rootY, currentDeltas);

  // Main character
  charGfx.clear();
  drawCharacter(charGfx, wp, { selectedBone });

  // Pivot indicator for selected bone
  selGfx.clear();
  if (selectedBone && wp[selectedBone] && !BONE_MAP[selectedBone]?.isHead) {
    const pos = wp[selectedBone];
    selGfx.lineStyle({ width: 1.5, color: 0x74c7ec, alpha: 0.7 });
    selGfx.beginFill(0x74c7ec, 0.2);
    selGfx.drawCircle(pos.sx, pos.sy, 8);
    selGfx.endFill();
  }
  if (showGuide) {
    selGfx.lineStyle({ width: 1, color: 0x89b4fa, alpha: 0.3 });
    selGfx.moveTo(rootX, rootY - 200); selGfx.lineTo(rootX, rootY + 50);
  }

  // Onion skin
  onionGfx.clear();
  if (showOnion) {
    const clip = getCurrentClip();
    if (clip) {
      const neighbors = [
        clip.keyframes.filter(k => k.time < state.currentTime - 0.001).slice(-1)[0],
        clip.keyframes.find(k => k.time > state.currentTime + 0.001),
      ];
      for (const kf of neighbors) {
        if (!kf) continue;
        const kwp = computeFK(rootX, rootY, sampleAnimation(clip, kf.time));
        drawCharacter(onionGfx, kwp, { alpha: 0.25, forceJoints: false });
      }
    }
  }
}

/** Expose canvas element so interaction.ts can attach listeners. */
export function getCanvas(): HTMLCanvasElement {
  return app.view as HTMLCanvasElement;
}

/** Expose renderer size. */
export function getRendererSize(): { w: number; h: number } {
  return { w: app.renderer.width, h: app.renderer.height };
}

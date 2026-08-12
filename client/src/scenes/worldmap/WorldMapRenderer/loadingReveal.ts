// Loading-cover reveal: WorldMapRendererBuild used to just `layer.destroy()` the first-paint
// paper sheet the instant the atlases settled (build.ts hideLoading(), pre-2026-08-12) — a hard
// cut from "notebook page" straight to the fully-rendered map, and because the camera opens
// centred on the player's own (giant, already-built) base, the cut read as "a huge city just
// popped into existence" rather than a reveal. This instead hands the sheet off to its own layer
// and rubs it away with a hand-drawn eraser stroke: a jagged boundary sweeping left→right across
// the sheet (per-row jitter so it reads as an uneven hand pass, not a mechanical wipe), trailing a
// few grey "eraser crumb" flecks that fall and fade. Wired from WorldMapRendererBuild.hideLoading()
// (kicks the wipe off — see its call to beginLoadingErase) and WorldMapRendererLifecycle.update()
// (advances it every frame via updateLoadingErase) — see WorldMapContext's loadingErase* fields for
// the animation state this module owns.
import * as PIXI from 'pixi.js-legacy';
import type { WorldMapContext } from '../WorldMapContext';

/** Seconds for the eraser stroke to sweep the whole sheet. */
const ERASE_DURATION = 0.65;
/** Rows the wipe boundary is jittered across — enough to read as an uneven hand stroke without
 *  costing more than a few extra drawRect calls per frame. */
const ERASE_ROWS = 16;
/** Per-row stagger, as a fraction of sheet width, applied through an envelope that's exactly 0 at
 *  both t=0 and t=1 (see drawEraseFrame) — rows visibly lead/lag mid-stroke but always start from
 *  "fully covered" and always converge to "fully erased" together. */
const ROW_JITTER_FRAC = 0.08;
const MAX_CRUMBS = 40;
/** Crumbs spawned per second of wipe while the stroke is actively rubbing (not at its very start/end). */
const CRUMB_SPAWN_RATE = 26;

export interface EraseCrumb {
  x: number; y: number; vx: number; vy: number; age: number; life: number; size: number;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Cheap position-based hash for a per-row offset — not a real PRNG and not meant to be: this
 *  drives a one-shot reveal (never re-rendered mid-flight), so it doesn't need seedFor()'s
 *  render-to-render stability, just *some* row-to-row variation. */
function rowJitter(i: number, w: number): number {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  const frac = s - Math.floor(s);
  return (frac - 0.5) * 2 * w * ROW_JITTER_FRAC;
}

/**
 * Kick off the erase-wipe. Hands the already-built loading sheet to its own layer/mask and resets
 * `ctx.loadingLayer`/`loadingSpinner` to null immediately — callers (and the "hideLoading nulls
 * loadingLayer" contract) only care that the *cover* is gone; how the sheet itself animates away
 * afterwards is this module's business. Idempotent: a null `ctx.loadingLayer` (already hidden, or
 * a wipe already in flight) is a no-op, matching the old hideLoading()'s idempotency.
 */
export function beginLoadingErase(ctx: WorldMapContext): void {
  const layer = ctx.loadingLayer;
  if (!layer) return;
  ctx.loadingLayer = null;
  ctx.loadingSpinner = null;

  const mask = new PIXI.Graphics();
  layer.addChild(mask);
  layer.mask = mask;

  ctx.loadingEraseLayer = layer;
  ctx.loadingEraseMask = mask;
  ctx.loadingEraseCrumbs = new PIXI.Graphics();
  ctx.container.addChild(ctx.loadingEraseCrumbs);
  ctx.loadingEraseT = 0;
  ctx.loadingEraseCrumbSpawnAcc = 0;
  ctx.loadingEraseCrumbData = [];
  drawEraseFrame(ctx, 0);
}

/** Advance the erase-wipe by `dt` seconds; tears everything down once it completes. No-op once
 *  the wipe has already finished (or never started). Called every frame from
 *  WorldMapRendererLifecycle.update() — cheap to call unconditionally. */
export function updateLoadingErase(ctx: WorldMapContext, dt: number): void {
  if (!ctx.loadingEraseLayer) return;
  ctx.loadingEraseT = Math.min(1, ctx.loadingEraseT + dt / ERASE_DURATION);
  drawEraseFrame(ctx, dt);
  if (ctx.loadingEraseT >= 1) teardownEraseLayer(ctx);
}

/** Scene teardown mid-wipe (player backs out of the world map before the stroke finishes) —
 *  same cleanup as a completed wipe, just triggered externally. Called from
 *  WorldMapRendererLifecycle.destroy(). */
export function cancelLoadingErase(ctx: WorldMapContext): void {
  teardownEraseLayer(ctx);
}

function teardownEraseLayer(ctx: WorldMapContext): void {
  if (ctx.loadingEraseLayer) { ctx.loadingEraseLayer.destroy({ children: true }); ctx.loadingEraseLayer = null; }
  ctx.loadingEraseMask = null;
  if (ctx.loadingEraseCrumbs) { ctx.loadingEraseCrumbs.destroy(); ctx.loadingEraseCrumbs = null; }
  ctx.loadingEraseCrumbData = [];
}

function drawEraseFrame(ctx: WorldMapContext, dt: number): void {
  const mask = ctx.loadingEraseMask;
  const crumbs = ctx.loadingEraseCrumbs;
  if (!mask || !crumbs) return;
  const { w, h } = ctx;
  const t = ctx.loadingEraseT;
  const eased = smoothstep(t);
  // Zero at t=0 and t=1, peaking mid-stroke — lets rows visibly lead/lag the average front
  // without ever leaving a gap at the very start or a leftover sliver at the very end.
  const staggerEnvelope = 4 * eased * (1 - eased);

  mask.clear();
  mask.beginFill(0xffffff);
  const rowH = h / ERASE_ROWS;
  for (let i = 0; i < ERASE_ROWS; i++) {
    const wobble = Math.sin(t * 9 + i * 1.7) * w * 0.02 * staggerEnvelope;
    const edge = Math.min(w, Math.max(0, w * eased + rowJitter(i, w) * staggerEnvelope + wobble));
    // Visible (still-covered) strip runs from the row's erase front to the sheet's right edge.
    if (edge < w) mask.drawRect(edge, i * rowH, w - edge, rowH);
  }
  mask.endFill();

  spawnCrumbs(ctx, w, h, eased, dt);
  ageCrumbs(ctx.loadingEraseCrumbData, dt);
  redrawCrumbs(crumbs, ctx.loadingEraseCrumbData);
}

/** Spawns a few grey rubber flecks near the current wipe front while the stroke is actively
 *  rubbing (skipped right at the start/end, where there's no visible front yet/anymore). */
function spawnCrumbs(ctx: WorldMapContext, w: number, h: number, eased: number, dt: number): void {
  if (eased <= 0.02 || eased >= 0.98) return;
  const list = ctx.loadingEraseCrumbData;
  ctx.loadingEraseCrumbSpawnAcc += dt * CRUMB_SPAWN_RATE;
  while (ctx.loadingEraseCrumbSpawnAcc >= 1 && list.length < MAX_CRUMBS) {
    ctx.loadingEraseCrumbSpawnAcc -= 1;
    list.push({
      x: w * eased + (Math.random() - 0.5) * w * 0.05,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 40,
      vy: 30 + Math.random() * 60,
      age: 0,
      life: 0.4 + Math.random() * 0.35,
      size: 2 + Math.random() * 3,
    });
  }
}

function ageCrumbs(list: EraseCrumb[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    c.age += dt;
    if (c.age >= c.life) { list.splice(i, 1); continue; }
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.vy += 90 * dt; // gentle gravity so crumbs visibly settle instead of drifting forever
  }
}

function redrawCrumbs(g: PIXI.Graphics, list: EraseCrumb[]): void {
  g.clear();
  for (const c of list) {
    const fade = 1 - c.age / c.life;
    g.beginFill(0x9a958c, 0.55 * fade); // dusty eraser-rubber grey
    g.drawRect(c.x - c.size / 2, c.y - c.size / 2, c.size, c.size);
    g.endFill();
  }
}

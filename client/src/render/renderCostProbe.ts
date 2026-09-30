/**
 * renderCostProbe.ts — splits one `renderer.render()` call into the three one-off costs that can make
 * a single frame take seconds: texture uploads, shader compile/link, PIXI.Text rasterization, and
 * PIXI.Graphics triangulation (deferred, like Text, to the first render after the shape changes).
 *
 * Why this exists (2026-09-28): prod `render_profile` showed IntroScene `rndMax` of 735–2006 ms, every
 * sample from an iPhone app on its first launch after a fresh install, while the same scene on desktop
 * Chrome never exceeds 19 ms. `rndMax` alone cannot say whether that was a cold Metal shader cache,
 * a first-use CJK font, or an image decode forced by `texImage2D`, and each needs a different fix.
 * The breakdown of the worst render in each profile span is attached to `render_profile` as
 * `rndMaxTex` / `rndMaxSh` / `rndMaxTxt` / `rndMaxGeo` (ms), with `rndMaxScene` and `rndMaxAt` (s since boot).
 *
 * Cost on the fast path: the wrapped GL entry points are called only when something is uploaded or
 * compiled, and the Text / Graphics hooks time only DIRTY objects (a clean one returns before the
 * clock is read).
 */
import * as PIXI from 'pixi.js-legacy';

export interface RenderCostSplit {
  texMs: number;
  shMs: number;
  txtMs: number;
  geoMs: number;
}

const acc: RenderCostSplit = { texMs: 0, shMs: 0, txtMs: 0, geoMs: 0 };

/** Zero the accumulator. Called right before each `renderer.render()`. */
export function beginRenderCost(): void {
  acc.texMs = 0; acc.shMs = 0; acc.txtMs = 0; acc.geoMs = 0;
}

/** What the render that just finished spent on each bucket (a copy; the accumulator keeps running). */
export function readRenderCost(): RenderCostSplit {
  return { texMs: acc.texMs, shMs: acc.shMs, txtMs: acc.txtMs, geoMs: acc.geoMs };
}

type Bucket = keyof RenderCostSplit;

function wrapMethod(target: Record<string, unknown>, name: string, bucket: Bucket): void {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = function (this: unknown, ...args: unknown[]): unknown {
    const t0 = performance.now();
    try {
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    } finally {
      acc[bucket] += performance.now() - t0;
    }
  };
}

let installed = false;

/**
 * Wrap the GL context's upload / compile entry points, `PIXI.Text#updateText` and
 * `PIXI.GraphicsGeometry#updateBatches`.
 * `gl` is absent on the canvas fallback renderer; then only the Text bucket is filled.
 */
export function installRenderCostProbe(gl: unknown): void {
  if (installed) return;
  installed = true;
  if (gl && typeof gl === 'object') {
    const g = gl as Record<string, unknown>;
    // Own-instance properties, not the prototype: the WeChat context is not a WebGLRenderingContext.
    for (const m of ['texImage2D', 'texSubImage2D', 'compressedTexImage2D']) wrapMethod(g, m, 'texMs');
    // With KHR_parallel_shader_compile the wait lands on the first status query, not on compile/link.
    for (const m of ['compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter']) wrapMethod(g, m, 'shMs');
  }
  const proto = PIXI.Text.prototype as unknown as { updateText(respectDirty: boolean): void; dirty: boolean };
  const origUpdate = proto.updateText;
  proto.updateText = function (this: PIXI.Text & { dirty: boolean }, respectDirty: boolean): void {
    // Same early-out PIXI does, checked first so the steady state never reads the clock.
    if (respectDirty && !this.dirty && this.localStyleID === this.style.styleID) return;
    const t0 = performance.now();
    try {
      origUpdate.call(this, respectDirty);
    } finally {
      acc.txtMs += performance.now() - t0;
    }
  };
  const geoProto = PIXI.GraphicsGeometry.prototype as unknown as { updateBatches(): void };
  const origBatches = geoProto.updateBatches;
  geoProto.updateBatches = function (this: PIXI.GraphicsGeometry & { dirty: number; cacheDirty: number }): void {
    // `validateBatching`'s own first test: an unchanged shape is a no-op, so do not time it.
    if (this.dirty === this.cacheDirty) { origBatches.call(this); return; }
    const t0 = performance.now();
    try {
      origBatches.call(this);
    } finally {
      acc.geoMs += performance.now() - t0;
    }
  };
}

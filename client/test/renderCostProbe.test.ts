// renderCostProbe: each wrapped GL entry point lands in its own bucket. The Text hook needs a canvas,
// so it is covered in test/ui/renderCostProbe.ui.ts.
import { describe, it, expect } from 'vitest';
import { installRenderCostProbe, beginRenderCost, readRenderCost } from '../src/render/renderCostProbe';

/** Busy-wait: the probe reads performance.now(), so the fake has to actually spend the time. */
function spin(ms: number): void { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }

describe('renderCostProbe', () => {
  const calls: string[] = [];
  const gl = {
    texImage2D: () => { calls.push('tex'); spin(6); },
    compileShader: () => { calls.push('sh'); spin(6); },
    getProgramParameter: () => { calls.push('pp'); spin(6); return true; },
    drawElements: () => { calls.push('draw'); spin(6); },
  };
  installRenderCostProbe(gl);

  it('attributes uploads and shader work to their buckets and leaves other GL calls out', () => {
    beginRenderCost();
    gl.texImage2D();
    gl.compileShader();
    gl.getProgramParameter();
    gl.drawElements();
    const c = readRenderCost();
    expect(calls).toEqual(['tex', 'sh', 'pp', 'draw']); // the wrappers still call through
    expect(c.texMs).toBeGreaterThanOrEqual(5);
    expect(c.shMs).toBeGreaterThanOrEqual(10);
    expect(c.texMs).toBeLessThan(12); // drawElements is not counted anywhere
  });
});

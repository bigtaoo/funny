// renderCostProbe: each wrapped GL entry point lands in its own bucket. The Text hook needs a canvas,
// so it is covered in test/ui/renderCostProbe.ui.ts.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { installRenderCostProbe, beginRenderCost, readRenderCost } from '../src/render/renderCostProbe';

// Fake clock: each GL fake advances it by a fixed step, so the buckets come out exact instead of
// depending on how long a busy-wait took on a loaded CI runner (a 6 ms spin once measured 12.3 ms).
let now = 0;
const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
afterAll(() => nowSpy.mockRestore());

describe('renderCostProbe', () => {
  const calls: string[] = [];
  const gl = {
    texImage2D: () => { calls.push('tex'); now += 6; },
    compileShader: () => { calls.push('sh'); now += 6; },
    getProgramParameter: () => { calls.push('pp'); now += 6; return true; },
    drawElements: () => { calls.push('draw'); now += 6; },
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
    expect(c.texMs).toBe(6); // drawElements is not counted anywhere
    expect(c.shMs).toBe(12);
    expect(c.txtMs).toBe(0);
    expect(c.geoMs).toBe(0);
  });
});

// Two rules of the layout audit (src/testing/layoutAudit.ts), each once wrong in a way that made
// the sweep report a defect that was not there (2026-09-29, the first sweep to reach these states):
//
//   1. A label's local scale is the LENGTH of its world x axis, not the matrix's `a` term. `a` is
//      scale x cos(rotation), so the shop's "expiring soon" stamp — tilted -0.3 rad, its label drawn
//      exactly at the floor — read as shrunk to 0.96 and under the floor.
//   2. A frame under an opaque full-screen cover is as invisible as the labels under it. The
//      attack-team editor's troop readout was reported as escaping a City HUD panel two layers
//      down, which the editor's own page background hides entirely.
//
// Plain node: `auditLayout` only reads a handful of fields off each node, so a hand-built tree of
// plain objects is the whole stage. Run: npm test
import { describe, it, expect, afterEach } from 'vitest';
import { auditLayout, auditOptionsFor } from '../src/testing/layoutAudit';

interface FakeNode {
  visible: boolean; renderable: boolean; alpha: number; name: string | null;
  text?: string; style?: { fontSize: number }; children?: FakeNode[];
  worldTransform: { a: number; b: number };
  geometry?: { graphicsData: Array<{ shape: { type: number }; fillStyle: { visible: boolean; alpha: number } }> };
  getBounds(): { x: number; y: number; width: number; height: number };
}

const W = 360, H = 640, SCALE = 1 / 3;

function node(x: number, y: number, w: number, h: number, extra: Partial<FakeNode> = {}): FakeNode {
  return {
    visible: true, renderable: true, alpha: 1, name: null,
    worldTransform: { a: SCALE, b: 0 },
    getBounds: () => ({ x, y, width: w, height: h }),
    ...extra,
  };
}
const fill = (x: number, y: number, w: number, h: number): FakeNode =>
  node(x, y, w, h, { geometry: { graphicsData: [{ shape: { type: 1 }, fillStyle: { visible: true, alpha: 1 } }] } });
const label = (text: string, x: number, y: number, w: number, h: number, fontSize: number, wt = { a: SCALE, b: 0 }): FakeNode =>
  node(x, y, w, h, { text, style: { fontSize }, worldTransform: wt });

function audit(children: FakeNode[]) {
  (globalThis as { __nwE2E?: unknown }).__nwE2E = {
    app: { stage: node(0, 0, W, H, { children }), renderer: { screen: { width: W, height: H } } },
  };
  return auditLayout(auditOptionsFor(1080, 1920, SCALE));
}

afterEach(() => { delete (globalThis as { __nwE2E?: unknown }).__nwE2E; });

describe('layout audit rules', () => {
  it('does not read rotation as shrinking', () => {
    const floor = auditOptionsFor(1080, 1920, SCALE).minInkDesignPx;
    const tilt = -0.3;
    const wt = { a: SCALE * Math.cos(tilt), b: SCALE * Math.sin(tilt) };
    const res = audit([label('EXPIRING SOON', 100, 100, 60, 12, floor, wt)]);
    expect(res.findings.filter((f) => f.kind === 'tiny')).toEqual([]);
  });

  it('still reports a label that really is shrunk under the floor', () => {
    const floor = auditOptionsFor(1080, 1920, SCALE).minInkDesignPx;
    const res = audit([label('EXPIRING SOON', 100, 100, 60, 12, floor, { a: SCALE * 0.8, b: 0 })]);
    expect(res.findings.map((f) => f.kind)).toContain('tiny');
  });

  it('does not accuse a frame hidden under a full-screen cover', () => {
    const res = audit([
      fill(10, 82, 341, 25),          // a panel of the scene underneath
      fill(0, 0, W, H),               // the next scene's opaque page background
      label('Heroes 2   Troops 200/900', 2, 76, 273, 14, 20),
    ]);
    expect(res.findings.filter((f) => f.kind === 'overflow')).toEqual([]);
  });

  it('still reports a label escaping a frame that is on screen', () => {
    const res = audit([
      fill(0, 0, W, H),
      fill(10, 82, 341, 25),
      label('Heroes 2   Troops 200/900', 2, 76, 273, 14, 20),
    ]);
    expect(res.findings.map((f) => f.kind)).toContain('overflow');
  });
});

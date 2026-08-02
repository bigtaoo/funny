// EditorSession — which tool is active and what gesture is in flight. Extracted from index.ts's
// module-level `let`s (DESIGN.md §8, 2026-08-02 pass 2). Small surface, but every mouse handler
// reads it, so the invariants (a tool switch drops a stale selection; a pan delta advances its own
// anchor) are worth pinning.
import { beforeEach, describe, expect, it } from 'vitest';
import { cursorForTool, EditorSession, isBrushTool, type Tool } from '../src/state/session';

let s: EditorSession;
beforeEach(() => {
  s = new EditorSession();
});

describe('EditorSession defaults', () => {
  it('opens on the Pan tool with nothing in flight', () => {
    expect(s.tool).toBe('pan');
    expect(s.painting).toBe(false);
    expect(s.panning).toBe(false);
    expect(s.lastPaintPos).toBeNull();
    expect(s.selectedCityId).toBeNull();
    expect(s.draggingCityId).toBeNull();
    expect(s.tileInfoShown).toBe(false);
  });
});

describe('EditorSession.setTool', () => {
  it('leaving the City tool drops the selection (its ring is only drawn in City mode)', () => {
    s.setTool('city');
    s.selectedCityId = 'capital-3';
    expect(s.setTool('river')).toBe(true);
    expect(s.selectedCityId).toBeNull();
  });

  it('staying on the City tool keeps the selection', () => {
    s.setTool('city');
    s.selectedCityId = 'capital-3';
    expect(s.setTool('city')).toBe(false);
    expect(s.selectedCityId).toBe('capital-3');
  });

  it('reports no change when there was nothing selected to clear', () => {
    expect(s.setTool('mountain')).toBe(false);
    expect(s.tool).toBe('mountain');
  });
});

describe('EditorSession stroke lifecycle', () => {
  it('begin records the anchor tile, end clears it', () => {
    s.beginStroke({ x: 4, y: 9 });
    expect(s.painting).toBe(true);
    expect(s.lastPaintPos).toEqual({ x: 4, y: 9 });
    s.endStroke();
    expect(s.painting).toBe(false);
    expect(s.lastPaintPos).toBeNull();
  });
});

describe('EditorSession pan lifecycle', () => {
  it('panDelta returns the move since the last sample and advances the anchor', () => {
    s.beginPan(100, 100);
    expect(s.panDelta(110, 90)).toEqual({ dx: 10, dy: -10 });
    // Second sample is relative to the first, not to the gesture start — otherwise a drag
    // accelerates as it goes.
    expect(s.panDelta(115, 90)).toEqual({ dx: 5, dy: 0 });
  });

  it('panDelta is null when no pan is in flight (the window listener fires constantly)', () => {
    expect(s.panDelta(10, 10)).toBeNull();
    s.beginPan(0, 0);
    s.endPan();
    expect(s.panDelta(10, 10)).toBeNull();
  });

  it('endPan clears the anchor', () => {
    s.beginPan(5, 5);
    s.endPan();
    expect(s.panning).toBe(false);
    expect(s.panLast).toBeNull();
  });
});

describe('isBrushTool', () => {
  it('is true for every tool that stamps the terrain grid', () => {
    for (const tool of ['river', 'mountain', 'neutral', 'bridge', 'plankway', 'eraser'] as Tool[]) {
      expect(isBrushTool(tool)).toBe(true);
    }
  });

  it('is false for the non-painting tools (no brush ring is drawn for them)', () => {
    expect(isBrushTool('city')).toBe(false);
    expect(isBrushTool('pan')).toBe(false);
  });
});

describe('cursorForTool', () => {
  it('shows a grab hand for Pan, closing while dragging', () => {
    expect(cursorForTool('pan')).toBe('grab');
    expect(cursorForTool('pan', true)).toBe('grabbing');
  });

  it('shows a crosshair for brush tools and the default arrow for City', () => {
    expect(cursorForTool('river')).toBe('crosshair');
    expect(cursorForTool('eraser')).toBe('crosshair');
    expect(cursorForTool('city')).toBe('default');
  });

  it('shows grabbing under every tool while a pan is in flight — middle-drag pans from any tool', () => {
    expect(cursorForTool('river', true)).toBe('grabbing');
    expect(cursorForTool('city', true)).toBe('grabbing');
    expect(cursorForTool('eraser', true)).toBe('grabbing');
  });
});

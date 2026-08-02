// Interaction state for one editing session — which tool is active and what gesture (brush stroke,
// city drag, camera pan) is currently in flight. Split out of index.ts (2026-08-02), where these
// were eight module-level `let`s read and written from every event handler.
//
// No PIXI, no DOM: handlers mutate this and then ask the render layer to redraw, rather than the
// state and the drawing being tangled in the same closure.
import type { TerrainKind, TilePoint } from './terrainGrid';

export type Tool = TerrainKind | 'eraser' | 'city' | 'pan';

/** Tools that stamp the terrain grid (i.e. draw a brush cursor and paint on drag). */
export type BrushTool = TerrainKind | 'eraser';

export function isBrushTool(tool: Tool): tool is BrushTool {
  return tool !== 'city' && tool !== 'pan';
}

/**
 * Canvas CSS cursor for a tool. Was duplicated at three call sites in the old index.ts.
 * `dragging` means a camera pan is in flight — which middle-mouse-drag can start under ANY tool,
 * so it wins over the tool's own cursor.
 */
export function cursorForTool(tool: Tool, dragging = false): string {
  if (dragging) return 'grabbing';
  if (tool === 'pan') return 'grab';
  return tool === 'city' ? 'default' : 'crosshair';
}

export class EditorSession {
  tool: Tool = 'pan';

  /** True while a brush stroke is being dragged (mousedown → mouseup). */
  painting = false;
  /** Last tile the brush stamped — mousemove strokes a line from here to the new cursor tile so a
   * fast drag between two mousemove samples doesn't leave gaps (TerrainGridStore.strokeCircle). */
  lastPaintPos: TilePoint | null = null;

  selectedCityId: string | null = null;
  draggingCityId: string | null = null;

  panning = false;
  panLast: { x: number; y: number } | null = null;

  /** Whether the Tile inspector has shown real hover data yet (vs. its initial hint text) — a
   * locale toggle must not overwrite live hover data with the hint. */
  tileInfoShown = false;

  /**
   * Switches tools. Leaving the City tool drops the selection: the selection ring is only drawn in
   * City mode, so keeping it would leave an invisible selection that Reset/Export still act on.
   * Returns true when the selection was cleared, so the caller can refresh the inspector panel.
   */
  setTool(next: Tool): boolean {
    this.tool = next;
    if (next !== 'city' && this.selectedCityId !== null) {
      this.selectedCityId = null;
      return true;
    }
    return false;
  }

  beginStroke(at: TilePoint): void {
    this.painting = true;
    this.lastPaintPos = at;
  }

  endStroke(): void {
    this.painting = false;
    this.lastPaintPos = null;
  }

  beginPan(clientX: number, clientY: number): void {
    this.panning = true;
    this.panLast = { x: clientX, y: clientY };
  }

  /** Screen-space delta since the last pan sample, advancing the anchor. Null when not panning. */
  panDelta(clientX: number, clientY: number): { dx: number; dy: number } | null {
    if (!this.panning || !this.panLast) return null;
    const d = { dx: clientX - this.panLast.x, dy: clientY - this.panLast.y };
    this.panLast = { x: clientX, y: clientY };
    return d;
  }

  endPan(): void {
    this.panning = false;
    this.panLast = null;
  }
}

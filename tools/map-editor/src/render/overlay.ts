// Vector chrome drawn over the atlas tiles: the brush-size cursor and, in City mode, the draggable
// city footprints. Not atlas art — this layer is editor affordance only, nothing here corresponds
// to something a player sees. Split out of index.ts (2026-08-02 pass 2).
import * as PIXI from 'pixi.js-legacy';
import { CITY_COLORS, TERRAIN_COLORS } from '../constants';
import { brushDiameter, camera, cityStore, session } from '../editor';
import { isBrushTool } from '../state/session';
import type { TilePoint } from '../state/terrainGrid';
import { overlayLayer } from '../stage';

/**
 * Projects a tile-space circle (the brush footprint) into screen space, sampling points around its
 * circumference — the iso transform is linear, so this yields the correct ellipse outline.
 */
function brushOutlinePoints(cx: number, cy: number, r: number): number[] {
  const SEGMENTS = 28;
  const pts: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    const s = camera.layerOf(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    pts.push(s.x, s.y);
  }
  return pts;
}

function drawBrushCursor(hoverTile?: TilePoint): void {
  if (!hoverTile || !isBrushTool(session.tool)) return;
  const g = new PIXI.Graphics();
  const pts = brushOutlinePoints(hoverTile.x, hoverTile.y, brushDiameter() / 2);
  if (session.tool === 'eraser') {
    g.lineStyle(1.5, 0xffffff, 0.9);
  } else {
    const color = TERRAIN_COLORS[session.tool];
    g.lineStyle(1.5, color, 0.9);
    g.beginFill(color, 0.18);
  }
  g.drawPolygon(pts);
  if (session.tool !== 'eraser') g.endFill();
  overlayLayer.addChild(g);
}

// Only shown while the City tool is active: the per-level city sprites (citySprites.ts) now carry
// the visual, so overlaying a translucent box on every city under every tool would just clutter the
// map. In City mode the boxes mark the draggable footprints + selection.
function drawCityMarkers(): void {
  if (session.tool !== 'city') return;
  const g = new PIXI.Graphics();
  for (const node of cityStore.nodes) {
    const color = CITY_COLORS[node.kind];
    const half = node.footprint / 2;
    // Footprint corners project to a parallelogram under the iso transform, not an axis-aligned box.
    const corners = [
      camera.layerOf(node.x - half, node.y - half),
      camera.layerOf(node.x + half, node.y - half),
      camera.layerOf(node.x + half, node.y + half),
      camera.layerOf(node.x - half, node.y + half),
    ];
    if (node.id === session.selectedCityId) {
      g.lineStyle(2, 0xffffff, 0.9);
      g.drawPolygon(corners.flatMap((c) => [c.x, c.y]));
    }
    g.lineStyle(1.4, color, 0.85);
    g.beginFill(color, 0.22);
    g.drawPolygon(corners.flatMap((c) => [c.x, c.y]));
    g.endFill();
  }
  overlayLayer.addChild(g);
}

/** Rebuilds the whole overlay layer. Cheap — at most two Graphics, both re-issued from scratch. */
export function redrawOverlay(hoverTile?: TilePoint): void {
  overlayLayer.removeChildren().forEach((c) => c.destroy());
  drawBrushCursor(hoverTile);
  drawCityMarkers();
}

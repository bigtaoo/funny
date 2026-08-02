// Pointer handling on the map canvas: brush strokes, city drag, and camera pan. Reads and writes
// the shared EditorSession/Camera rather than module-local `let`s (DESIGN.md §8, 2026-08-02 pass 2)
// — which is what makes this file separable from the render layer at all.
import { VIEW_H, VIEW_W } from '../constants';
import { brushDiameter, camera, cityStore, hitRadiusTiles, session, terrainStore, worldId } from '../editor';
import { effectiveTile } from '../render/baseMap';
import { redrawOverlay } from '../render/overlay';
import { renderAll, renderTerrain, scheduleRender } from '../render/refresh';
import { app } from '../stage';
import { clampCityPos } from '../state/cities';
import { cursorForTool } from '../state/session';
import type { TerrainKind, TilePoint } from '../state/terrainGrid';
import { refreshSelectedCity, selectCity, showTileInfo } from '../ui/panels';
import { setStatus } from '../ui/status';
import { t } from '../i18n';

export function canvasEl(): HTMLCanvasElement {
  return app.view as HTMLCanvasElement;
}

export function setCanvasCursor(dragging = false): void {
  canvasEl().style.cursor = cursorForTool(session.tool, dragging);
}

/** Client (page) coordinates → viewport coordinates, undoing any CSS scaling of the canvas. */
function screenFromClientXY(clientX: number, clientY: number): { sx: number; sy: number } {
  const rect = canvasEl().getBoundingClientRect();
  return { sx: ((clientX - rect.left) / rect.width) * VIEW_W, sy: ((clientY - rect.top) / rect.height) * VIEW_H };
}

function tileFromClientXY(clientX: number, clientY: number): TilePoint {
  const { sx, sy } = screenFromClientXY(clientX, clientY);
  return camera.tileAt(sx, sy);
}

function stamp(at: TilePoint): void {
  if (session.tool === 'eraser') terrainStore.eraseCircle(at.x, at.y, brushDiameter());
  else terrainStore.paintCircle(at.x, at.y, session.tool as TerrainKind, brushDiameter());
}

export function wireCanvasInput(): void {
  const canvas = canvasEl();

  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button === 1 || session.tool === 'pan') {
      session.beginPan(ev.clientX, ev.clientY);
      setCanvasCursor(true);
      return;
    }
    if (ev.button !== 0) return;
    const at = tileFromClientXY(ev.clientX, ev.clientY);

    if (session.tool === 'city') {
      const id = cityStore.findNearest(at, hitRadiusTiles());
      selectCity(id);
      if (id) session.draggingCityId = id;
      return;
    }

    // Start a brush stroke: stamp immediately at the click point, then mousemove strokes the grid as the
    // cursor moves — a plain click already paints (no drag required), matching an image-editor brush.
    stamp(at);
    session.beginStroke(at);
    renderTerrain();
    redrawOverlay(at); // synchronous, not scheduled — a click must paint within its own frame
  });

  // Pan tracks on `window`, not the canvas: a drag that leaves the canvas should keep panning.
  window.addEventListener('mousemove', (ev) => {
    const d = session.panDelta(ev.clientX, ev.clientY);
    if (d) camera.panBy(d.dx, d.dy);
  });

  canvas.addEventListener('mousemove', (ev) => {
    if (session.panning) return;
    const pos = tileFromClientXY(ev.clientX, ev.clientY);
    showTileInfo(pos, effectiveTile(worldId(), pos.x, pos.y));

    if (session.draggingCityId) {
      const node = cityStore.get(session.draggingCityId);
      if (node) {
        const clamped = clampCityPos(node, pos);
        node.x = clamped.x;
        node.y = clamped.y;
        refreshSelectedCity();
      }
      scheduleRender({ base: false, hover: pos });
      return;
    }

    if (session.painting && session.lastPaintPos) {
      const kind = session.tool === 'eraser' ? null : (session.tool as TerrainKind);
      terrainStore.strokeCircle(session.lastPaintPos, pos, kind, brushDiameter());
      session.lastPaintPos = pos;
      scheduleRender({ base: true, hover: pos });
      return;
    }

    // Keep the brush-size cursor tracking the hover tile even when not actively painting.
    scheduleRender({ base: false, hover: pos });
  });

  window.addEventListener('mouseup', () => {
    if (session.panning) {
      session.endPan();
      setCanvasCursor();
      renderAll();
      return;
    }
    if (session.draggingCityId) {
      session.draggingCityId = null;
      setStatus(() => t('status.cityMoved', { id: session.selectedCityId ?? '' }));
      renderAll();
    }
    if (session.painting) {
      session.endStroke();
      renderTerrain();
    }
  });

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

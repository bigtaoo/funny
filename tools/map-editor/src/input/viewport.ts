// Camera controls: the zoom slider, the wheel gesture, and the Center View button. The math lives
// on the Camera (state/camera.ts); this module only turns events into camera calls and asks for a
// redraw. Split out of index.ts (2026-08-02 pass 2).
import { ZOOM_MAX, ZOOM_MIN } from '../constants';
import { centerBtn, zoomInput } from '../dom';
import { camera } from '../editor';
import { renderAll } from '../render/refresh';
import { app, worldLayer } from '../stage';
import type { ScreenPoint } from '../state/camera';

function zoomTo(nextTp: number, anchor?: ScreenPoint): void {
  if (camera.setZoom(nextTp, anchor)) renderAll();
}

export function wireViewport(): void {
  // The camera is DOM/PIXI-free by design, so the stage sync is installed here rather than baked
  // into clampPan().
  camera.onChange = () => worldLayer.position.set(camera.panX, camera.panY);

  zoomInput.min = String(ZOOM_MIN);
  zoomInput.max = String(ZOOM_MAX);
  zoomInput.step = '2';
  zoomInput.value = String(camera.tp);
  zoomInput.addEventListener('input', () => zoomTo(Number(zoomInput.value)));

  // A single wheel gesture fires dozens of 'wheel' events (far above frame rate), and each one would
  // otherwise trigger a synchronous full-viewport tile rebuild. Coalesce them down to one rebuild per
  // animation frame — same pattern as scheduleRender() — so a sustained scroll (e.g. dragging from
  // default zoom to ZOOM_MAX) does at most ~60 rebuilds/sec instead of one per wheel tick.
  let pendingZoomDelta = 0;
  let pendingZoomAnchor: ScreenPoint | undefined;
  let zoomRafScheduled = false;
  app.view.addEventListener?.('wheel', (ev: Event) => {
    const we = ev as WheelEvent;
    we.preventDefault();
    const rect = (app.view as HTMLCanvasElement).getBoundingClientRect();
    pendingZoomDelta += -Math.sign(we.deltaY) * 4;
    pendingZoomAnchor = { sx: we.clientX - rect.left, sy: we.clientY - rect.top };
    if (zoomRafScheduled) return;
    zoomRafScheduled = true;
    requestAnimationFrame(() => {
      zoomRafScheduled = false;
      zoomTo(camera.tp + pendingZoomDelta, pendingZoomAnchor);
      pendingZoomDelta = 0;
      zoomInput.value = String(camera.tp);
    });
  }, { passive: false });

  centerBtn.addEventListener('click', () => {
    camera.centerOnMap();
    renderAll();
  });
}

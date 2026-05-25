/**
 * Mouse and keyboard interaction on the PixiJS canvas.
 * Mutates state + currentDeltas; rendering is picked up by the ticker.
 */
import { BONE_MAP, SELECTABLE_BONES, computeFK, HEAD_R } from './skeleton';
import { state, currentDeltas } from './state';
import { emit, BONE_SELECT, STATUS } from './events';
import { getCanvas, getRendererSize } from './renderer';

// ── Hit detection ─────────────────────────────────────────────────────────────

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function findBoneAt(mx: number, my: number): string | null {
  const wp = computeFK(state.rootX, state.rootY, currentDeltas);
  let bestId: string | null = null;
  let bestDist = 18;

  for (const boneId of SELECTABLE_BONES) {
    const bone = BONE_MAP[boneId];
    const pos = wp[boneId];
    if (!pos) continue;

    let d: number;
    if (bone.isHead) {
      d = Math.max(0, Math.hypot(mx - pos.ex, my - pos.ey) - HEAD_R);
    } else {
      d = distToSegment(mx, my, pos.sx, pos.sy, pos.ex, pos.ey);
    }
    if (d < bestDist) { bestDist = d; bestId = boneId; }
  }
  return bestId;
}

// ── Coordinate transform ──────────────────────────────────────────────────────

function getMousePos(e: MouseEvent): { x: number; y: number } {
  const canvas = getCanvas();
  const rect = canvas.getBoundingClientRect();
  const { w, h } = getRendererSize();
  return {
    x: (e.clientX - rect.left) * (w / rect.width),
    y: (e.clientY - rect.top)  * (h / rect.height),
  };
}

// ── Event handlers ────────────────────────────────────────────────────────────

function onMouseDown(e: MouseEvent): void {
  const { x, y } = getMousePos(e);

  if (e.button === 2) {
    // Right-click: pan
    state.isDragging = true;
    state.dragType = 'pan';
    state.dragPanRefX = x - state.panOffsetX;
    state.dragPanRefY = y - state.panOffsetY;
    return;
  }

  // Left-click: try to select a bone
  const boneId = findBoneAt(x, y);

  if (boneId) {
    state.selectedBone = boneId;
    state.isDragging = true;
    state.dragType = 'bone';
    state.dragBoneId = boneId;

    // Cache pivot and parent angle for drag computation
    const wp = computeFK(state.rootX, state.rootY, currentDeltas);
    const pos = wp[boneId]!;
    const bone = BONE_MAP[boneId];
    const parentWa = bone.parent ? wp[bone.parent]!.wa : 0;

    state.dragPivotX     = pos.sx;
    state.dragPivotY     = pos.sy;
    state.dragParentAngle = parentWa;

    emit(BONE_SELECT, boneId);
  } else {
    state.selectedBone = null;
    emit(BONE_SELECT, null);
  }
}

function onMouseMove(e: MouseEvent): void {
  if (!state.isDragging) return;
  const { x, y } = getMousePos(e);

  if (state.dragType === 'pan') {
    state.panOffsetX = x - state.dragPanRefX;
    state.panOffsetY = y - state.dragPanRefY;
    const { w, h } = getRendererSize();
    state.rootX = w / 2 + state.panOffsetX;
    state.rootY = h / 2 + 30 + state.panOffsetY;
    return;
  }

  if (state.dragType === 'bone' && state.dragBoneId) {
    const boneId = state.dragBoneId;
    const bone = BONE_MAP[boneId];
    const sx = state.dragPivotX;
    const sy = state.dragPivotY;

    // World angle from pivot to mouse
    const newWorldAngle = Math.atan2(y - sy, x - sx) * (180 / Math.PI);
    // Local delta = desired world angle − parent world angle − rest local angle
    currentDeltas[boneId] = newWorldAngle - state.dragParentAngle - bone.rla;
  }
}

function onMouseUp(): void {
  state.isDragging = false;
  state.dragType = null;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  // Ignore if focus is in an input field
  if ((e.target as HTMLElement).tagName === 'INPUT') return;

  // These actions are wired in index.ts via the exported keybindings map.
  // Re-emit as a custom DOM event so index.ts can handle them.
  const key = [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.code].filter(Boolean).join('+');
  document.dispatchEvent(new CustomEvent('animator:key', { detail: key }));
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initInteraction(): void {
  const canvas = getCanvas();
  canvas.addEventListener('mousedown',  onMouseDown);
  canvas.addEventListener('mousemove',  onMouseMove);
  canvas.addEventListener('mouseup',    onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', onKeyDown);
  emit(STATUS, 'Ready — click a bone to select, drag to rotate');
}

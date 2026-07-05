// Map Editor entry point (DESIGN.md §6): full procedural map render + river/mountain path brush (§6.1).
// The brush is a pure client-side editing overlay for now — paths are not yet rasterized back into
// proceduralTile() or persisted server-side (§6.2/§5 open questions); Export/Import JSON round-trips
// the in-memory path list so the data shape can be validated ahead of the persistence work.
import { proceduralTile, SLG_MAP_H, SLG_MAP_W, type ResourceType, type TileType } from '@nw/shared/slg';
import { distToPath, distToSegment, PathStore, randomDefaultWidth, type PathKind, type TilePoint } from './state/paths';

const TILE_COLORS: Record<TileType, string> = {
  neutral: '#2a2a3e',
  resource: '#4a6a3a',
  territory: '#3a4e6a',
  familyKeep: '#c9a24a',
  center: '#e05a5a',
  base: '#3a4e6a',
  obstacle: '#5a4a3a',
  gate: '#e0c85a',
  stronghold: '#8a3a8a',
};

const RESOURCE_LABELS: Record<ResourceType, string> = {
  ink: '墨(ink)',
  paper: '纸(paper)',
  graphite: '碳(graphite)',
  metal: '铁(metal)',
  sticker: '贴纸(sticker)',
};

const PATH_COLORS: Record<PathKind, string> = { river: '#4fa8e0', mountain: '#a0785a' };

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const TILE_COLOR_RGB: Record<TileType, [number, number, number]> = Object.fromEntries(
  (Object.keys(TILE_COLORS) as TileType[]).map((k) => [k, hexToRgb(TILE_COLORS[k])]),
) as Record<TileType, [number, number, number]>;

const mapCanvas = document.getElementById('map-canvas') as HTMLCanvasElement;
const mapCtx = mapCanvas.getContext('2d')!;
const overlayCanvas = document.getElementById('overlay-canvas') as HTMLCanvasElement;
const overlayCtx = overlayCanvas.getContext('2d')!;
const canvasStack = document.getElementById('canvas-stack')!;
const seedInput = document.getElementById('world-seed') as HTMLInputElement;
const regenBtn = document.getElementById('btn-regen') as HTMLButtonElement;
const zoomInput = document.getElementById('zoom') as HTMLInputElement;
const statusEl = document.getElementById('status')!;
const tileInfoEl = document.getElementById('tile-info')!;
const legendEl = document.getElementById('legend')!;
const widthInput = document.getElementById('brush-width') as HTMLInputElement;
const undoPointBtn = document.getElementById('btn-undo-point') as HTMLButtonElement;
const deletePathBtn = document.getElementById('btn-delete-path') as HTMLButtonElement;
const clearPathsBtn = document.getElementById('btn-clear-paths') as HTMLButtonElement;
const pathListEl = document.getElementById('path-list')!;
const pathCountEl = document.getElementById('path-count')!;
const jsonEl = document.getElementById('json') as HTMLTextAreaElement;
const exportBtn = document.getElementById('btn-export') as HTMLButtonElement;
const importBtn = document.getElementById('btn-import') as HTMLButtonElement;
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.toolbar .tool'));

for (const c of [mapCanvas, overlayCanvas]) {
  c.width = SLG_MAP_W;
  c.height = SLG_MAP_H;
}

// ── Editor state ─────────────────────────────────────────────────────────
type Tool = 'select' | PathKind;
let tool: Tool = 'select';
const store = new PathStore();
let draft: TilePoint[] | null = null;
let selectedPathId: string | null = null;
let dragging: { pathId: string; pointIdx: number } | null = null;
/** Point/segment hit-test radius, in on-screen px (converted to tile units per current zoom). */
const HIT_RADIUS_PX = 8;

function currentZoom(): number {
  return Number(zoomInput.value) || 1;
}

function hitRadiusTiles(): number {
  return HIT_RADIUS_PX / currentZoom();
}

// ── Base map render ──────────────────────────────────────────────────────
function renderLegend(): void {
  legendEl.innerHTML = (Object.keys(TILE_COLORS) as TileType[])
    .map((t) => `<div class="row"><i style="background:${TILE_COLORS[t]}"></i>${t}</div>`)
    .join('');
}

function renderBaseMap(worldId: string): void {
  const t0 = performance.now();
  const img = mapCtx.createImageData(SLG_MAP_W, SLG_MAP_H);
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      const tile = proceduralTile(worldId, x, y);
      const [r, g, b] = TILE_COLOR_RGB[tile.type];
      // Level shades brightness within a type so equal-type tiles aren't visually flat.
      const shade = 0.55 + 0.045 * tile.level;
      const i = (y * SLG_MAP_W + x) * 4;
      img.data[i] = Math.min(255, r * shade);
      img.data[i + 1] = Math.min(255, g * shade);
      img.data[i + 2] = Math.min(255, b * shade);
      img.data[i + 3] = 255;
    }
  }
  mapCtx.putImageData(img, 0, 0);
  const ms = (performance.now() - t0).toFixed(0);
  statusEl.textContent = `world="${worldId}" — ${SLG_MAP_W}×${SLG_MAP_H} rendered in ${ms}ms — ${store.paths.length} path(s)`;
}

// ── Overlay (paths) render ───────────────────────────────────────────────
function strokePolyline(points: readonly TilePoint[], width: number, color: string, alpha: number): void {
  if (points.length < 2) return;
  overlayCtx.save();
  overlayCtx.globalAlpha = alpha;
  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = width;
  overlayCtx.lineCap = 'round';
  overlayCtx.lineJoin = 'round';
  overlayCtx.beginPath();
  overlayCtx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) overlayCtx.lineTo(points[i]!.x, points[i]!.y);
  overlayCtx.stroke();
  overlayCtx.restore();
}

function drawPointHandles(points: readonly TilePoint[], color: string): void {
  const r = Math.max(1.5, 3 / currentZoom());
  overlayCtx.save();
  overlayCtx.fillStyle = color;
  for (const p of points) {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    overlayCtx.fill();
  }
  overlayCtx.restore();
}

function redrawOverlay(hoverTile?: TilePoint): void {
  overlayCtx.clearRect(0, 0, SLG_MAP_W, SLG_MAP_H);
  for (const path of store.paths) {
    const isSelected = path.id === selectedPathId;
    if (isSelected) strokePolyline(path.points, path.width + 3, '#ffffff', 0.25);
    strokePolyline(path.points, path.width, PATH_COLORS[path.type], 0.55);
    if (tool === 'select') drawPointHandles(path.points, isSelected ? '#ffffff' : PATH_COLORS[path.type]);
  }
  if (draft) {
    const kind = tool as PathKind;
    const preview = hoverTile ? [...draft, hoverTile] : draft;
    strokePolyline(preview, Number(widthInput.value) || 1, PATH_COLORS[kind], 0.35);
    drawPointHandles(draft, PATH_COLORS[kind]);
  }
}

// ── Zoom / layout ────────────────────────────────────────────────────────
function applyZoom(): void {
  const z = currentZoom();
  canvasStack.style.width = `${SLG_MAP_W * z}px`;
  canvasStack.style.height = `${SLG_MAP_H * z}px`;
  for (const c of [mapCanvas, overlayCanvas]) {
    c.style.width = `${SLG_MAP_W * z}px`;
    c.style.height = `${SLG_MAP_H * z}px`;
  }
  redrawOverlay();
}

// ── Tool switching ───────────────────────────────────────────────────────
function cancelDraft(): void {
  draft = null;
  redrawOverlay();
}

function setTool(next: Tool): void {
  if (tool !== next) cancelDraft();
  tool = next;
  for (const btn of toolButtons) btn.classList.toggle('active', btn.dataset.tool === tool);
  canvasStack.classList.toggle('tool-select', tool === 'select');
  if (tool !== 'select') {
    selectedPathId = null;
    deletePathBtn.disabled = true;
    renderPathList();
  }
  redrawOverlay();
}

for (const btn of toolButtons) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool as Tool));
}

// ── Path list / inspector ───────────────────────────────────────────────
function renderPathList(): void {
  pathCountEl.textContent = String(store.paths.length);
  pathListEl.innerHTML = store.paths
    .map(
      (p, i) =>
        `<div class="path-row${p.id === selectedPathId ? ' selected' : ''}" data-id="${p.id}">` +
        `<i style="background:${PATH_COLORS[p.type]}"></i>${p.type} #${i + 1} — w${p.width}, ${p.points.length}pt</div>`,
    )
    .join('');
  for (const row of Array.from(pathListEl.querySelectorAll<HTMLDivElement>('.path-row'))) {
    row.addEventListener('click', () => selectPath(row.dataset.id!));
  }
}

function selectPath(id: string | null): void {
  selectedPathId = id;
  deletePathBtn.disabled = id === null;
  const path = id ? store.get(id) : undefined;
  if (path) widthInput.value = String(path.width);
  renderPathList();
  redrawOverlay();
}

function deleteSelectedPath(): void {
  if (!selectedPathId) return;
  store.remove(selectedPathId);
  selectPath(null);
  renderBaseMap(seedInput.value || 'preview');
}

deletePathBtn.addEventListener('click', deleteSelectedPath);
clearPathsBtn.addEventListener('click', () => {
  store.clear();
  selectPath(null);
  renderBaseMap(seedInput.value || 'preview');
});

widthInput.addEventListener('change', () => {
  const w = Math.max(1, Math.round(Number(widthInput.value) || 1));
  widthInput.value = String(w);
  const path = selectedPathId ? store.get(selectedPathId) : undefined;
  if (path) {
    path.width = w;
    renderPathList();
    redrawOverlay();
  }
});

function undoDraftPoint(): void {
  if (!draft) return;
  draft.pop();
  if (draft.length === 0) draft = null;
  redrawOverlay();
}
undoPointBtn.addEventListener('click', undoDraftPoint);

function finishDraft(): void {
  if (!draft || draft.length < 2) return;
  store.add(tool as PathKind, draft, Math.max(1, Math.round(Number(widthInput.value) || 1)));
  draft = null;
  renderBaseMap(seedInput.value || 'preview');
  renderPathList();
}

// ── Export / Import ──────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  jsonEl.value = store.toJSON();
  statusEl.textContent = `Exported ${store.paths.length} path(s).`;
});
importBtn.addEventListener('click', () => {
  try {
    store.loadFromJSON(jsonEl.value);
    selectPath(null);
    renderBaseMap(seedInput.value || 'preview');
    statusEl.textContent = `Imported ${store.paths.length} path(s).`;
  } catch (err) {
    statusEl.textContent = `Import failed: ${(err as Error).message}`;
  }
});

// ── Canvas input ─────────────────────────────────────────────────────────
function tileFromEvent(ev: MouseEvent): TilePoint {
  const rect = overlayCanvas.getBoundingClientRect();
  const scaleX = SLG_MAP_W / rect.width;
  const scaleY = SLG_MAP_H / rect.height;
  const x = Math.round((ev.clientX - rect.left) * scaleX);
  const y = Math.round((ev.clientY - rect.top) * scaleY);
  return { x: Math.max(0, Math.min(SLG_MAP_W - 1, x)), y: Math.max(0, Math.min(SLG_MAP_H - 1, y)) };
}

function findNearestPoint(tp: TilePoint): { pathId: string; pointIdx: number } | null {
  const rTiles = hitRadiusTiles();
  let best: { pathId: string; pointIdx: number; dist: number } | null = null;
  for (const path of store.paths) {
    for (let idx = 0; idx < path.points.length; idx++) {
      const p = path.points[idx]!;
      const dist = Math.hypot(p.x - tp.x, p.y - tp.y);
      if (dist <= rTiles && (!best || dist < best.dist)) best = { pathId: path.id, pointIdx: idx, dist };
    }
  }
  return best ? { pathId: best.pathId, pointIdx: best.pointIdx } : null;
}

function findNearestPath(tp: TilePoint): string | null {
  const rTiles = hitRadiusTiles();
  let best: { id: string; dist: number } | null = null;
  for (const path of store.paths) {
    const dist = distToPath(tp.x, tp.y, path) - path.width / 2;
    if (dist <= rTiles && (!best || dist < best.dist)) best = { id: path.id, dist };
  }
  return best ? best.id : null;
}

overlayCanvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  const tp = tileFromEvent(ev);
  if (tool === 'select') {
    const hit = findNearestPoint(tp);
    if (hit) {
      dragging = hit;
      selectPath(hit.pathId);
      return;
    }
    selectPath(findNearestPath(tp));
    return;
  }
  if (!draft) draft = [tp];
  else draft.push(tp);
  redrawOverlay(tp);
});

overlayCanvas.addEventListener('mousemove', (ev) => {
  const tp = tileFromEvent(ev);
  const tile = proceduralTile(seedInput.value || 'preview', tp.x, tp.y);
  const resLine = tile.resType ? `\nresource: ${RESOURCE_LABELS[tile.resType]}` : '';
  tileInfoEl.textContent = `(${tp.x}, ${tp.y})\ntype: ${tile.type}\nlevel: ${tile.level}${resLine}`;

  if (dragging) {
    const path = store.get(dragging.pathId);
    if (path) path.points[dragging.pointIdx] = tp;
    redrawOverlay();
    return;
  }
  if (draft) redrawOverlay(tp);
});

window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = null;
    renderBaseMap(seedInput.value || 'preview');
  }
});

overlayCanvas.addEventListener('dblclick', (ev) => {
  if (tool === 'select' || !draft) return;
  ev.preventDefault();
  // The second click of the dblclick already pushed a duplicate point via mousedown; drop it.
  if (draft.length >= 2) {
    const [a, b] = draft.slice(-2);
    if (a && b && a.x === b.x && a.y === b.y) draft.pop();
  }
  finishDraft();
});

overlayCanvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (tool === 'select') {
    const tp = tileFromEvent(ev);
    const id = findNearestPath(tp);
    if (id) {
      store.remove(id);
      selectPath(null);
      renderBaseMap(seedInput.value || 'preview');
    }
    return;
  }
  undoDraftPoint();
});

document.addEventListener('keydown', (ev) => {
  const target = ev.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
  if (ev.key === 'Escape') cancelDraft();
  else if (ev.key === 'Enter') finishDraft();
  else if (ev.key === 'Backspace') {
    ev.preventDefault();
    if (draft) undoDraftPoint();
    else deleteSelectedPath();
  } else if (ev.key === 'Delete') deleteSelectedPath();
});

// ── Boot ─────────────────────────────────────────────────────────────────
regenBtn.addEventListener('click', () => renderBaseMap(seedInput.value || 'preview'));
zoomInput.addEventListener('input', applyZoom);
widthInput.value = String(randomDefaultWidth());

renderLegend();
applyZoom();
renderBaseMap(seedInput.value);
renderPathList();

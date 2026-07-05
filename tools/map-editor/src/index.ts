// Map Editor entry point (DESIGN.md §6): full procedural map render + river/mountain path brush (§6.1)
// + city drag (§6.1 third bullet) + publish-to-server (§8, §24 admin map-template API). River/mountain
// paths and city positions are rasterized (mapEdit.ts's rasterizeMapEdits) into a tile diff and pushed via
// the existing admin map-template endpoints — a one-way bake, not a live sync (see api.ts/publish section below).
import { MAP_TEMPLATE_SAVE_MAX_TILES, proceduralTile, rasterizeMapEdits, SLG_MAP_H, SLG_MAP_W, type MapTemplateSummary, type MapTemplateTile, type ResourceType, type TileType } from '@nw/shared/slg';
import { distToPath, PathStore, randomDefaultWidth, type PathKind, type TilePoint } from './state/paths';
import { CityStore, type MapEditorCityNode } from './state/cities';
import { Api, ApiError } from './api';

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
const CITY_COLORS: Record<MapEditorCityNode['kind'], string> = {
  worldCenter: '#ff5c8a',
  capital: '#ffd166',
  gateCity: '#ef6c53',
  garrison: '#4ce0c0',
};

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
const cityCanvas = document.getElementById('city-canvas') as HTMLCanvasElement;
const cityCtx = cityCanvas.getContext('2d')!;
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
const resetCitiesBtn = document.getElementById('btn-reset-cities') as HTMLButtonElement;
const pathListEl = document.getElementById('path-list')!;
const pathCountEl = document.getElementById('path-count')!;
const jsonEl = document.getElementById('json') as HTMLTextAreaElement;
const exportBtn = document.getElementById('btn-export') as HTMLButtonElement;
const importBtn = document.getElementById('btn-import') as HTMLButtonElement;
const cityLegendEl = document.getElementById('city-legend')!;
const cityInfoEl = document.getElementById('city-info')!;
const cityJsonEl = document.getElementById('city-json') as HTMLTextAreaElement;
const cityExportBtn = document.getElementById('btn-city-export') as HTMLButtonElement;
const cityImportBtn = document.getElementById('btn-city-import') as HTMLButtonElement;
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.toolbar .tool'));
const publishLoginEl = document.getElementById('publish-login')!;
const publishPanelEl = document.getElementById('publish-panel')!;
const publishWhoamiEl = document.getElementById('publish-whoami')!;
const adminBaseInput = document.getElementById('admin-base') as HTMLInputElement;
const adminUserInput = document.getElementById('admin-user') as HTMLInputElement;
const adminPassInput = document.getElementById('admin-pass') as HTMLInputElement;
const adminLoginBtn = document.getElementById('btn-admin-login') as HTMLButtonElement;
const adminLogoutBtn = document.getElementById('btn-admin-logout') as HTMLButtonElement;
const templateIdInput = document.getElementById('template-id') as HTMLInputElement;
const templateGenerateBtn = document.getElementById('btn-template-generate') as HTMLButtonElement;
const publishBtn = document.getElementById('btn-publish') as HTMLButtonElement;
const templateListEl = document.getElementById('template-list')!;
const templateCountEl = document.getElementById('template-count')!;
const templateRefreshBtn = document.getElementById('btn-template-refresh') as HTMLButtonElement;
const templateActivateBtn = document.getElementById('btn-template-activate') as HTMLButtonElement;
const templateDeleteBtn = document.getElementById('btn-template-delete') as HTMLButtonElement;

for (const c of [mapCanvas, overlayCanvas, cityCanvas]) {
  c.width = SLG_MAP_W;
  c.height = SLG_MAP_H;
}

// ── Editor state ─────────────────────────────────────────────────────────
type Tool = 'select' | PathKind | 'city';
let tool: Tool = 'select';
const store = new PathStore();
const cityStore = new CityStore();
let draft: TilePoint[] | null = null;
let selectedPathId: string | null = null;
let dragging: { pathId: string; pointIdx: number } | null = null;
let selectedCityId: string | null = null;
let draggingCityId: string | null = null;
/** Point/segment/city hit-test radius, in on-screen px (converted to tile units per current zoom). */
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
  cityLegendEl.innerHTML = (Object.keys(CITY_COLORS) as MapEditorCityNode['kind'][])
    .map((k) => `<div class="row"><i style="background:${CITY_COLORS[k]}"></i>${k}</div>`)
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
  statusEl.textContent = `world="${worldId}" — ${SLG_MAP_W}×${SLG_MAP_H} rendered in ${ms}ms — ${store.paths.length} path(s), ${cityStore.nodes.length} cit${cityStore.nodes.length === 1 ? 'y' : 'ies'}`;
}

function loadCitiesAndRedraw(worldId: string): void {
  cityStore.loadFromSeed(worldId);
  selectedCityId = null;
  cityInfoEl.textContent = 'City 工具下拖动地图上的城池标记即可移动坐标（世界中心 9×9 占地拖拽时保持形状）；点击标记查看详情。';
  redrawCities();
}

// ── Overlay (paths) render ───────────────────────────────────────────────
function strokePolyline(ctx: CanvasRenderingContext2D, points: readonly TilePoint[], width: number, color: string, alpha: number): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.stroke();
  ctx.restore();
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
    if (isSelected) strokePolyline(overlayCtx, path.points, path.width + 3, '#ffffff', 0.25);
    strokePolyline(overlayCtx, path.points, path.width, PATH_COLORS[path.type], 0.55);
    if (tool === 'select') drawPointHandles(path.points, isSelected ? '#ffffff' : PATH_COLORS[path.type]);
  }
  if (draft) {
    const kind = tool as PathKind;
    const preview = hoverTile ? [...draft, hoverTile] : draft;
    strokePolyline(overlayCtx, preview, Number(widthInput.value) || 1, PATH_COLORS[kind], 0.35);
    drawPointHandles(draft, PATH_COLORS[kind]);
  }
}

// ── City markers render ──────────────────────────────────────────────────
function drawCityMarker(node: MapEditorCityNode, isSelected: boolean): void {
  const color = CITY_COLORS[node.kind];
  const half = node.footprint / 2;
  cityCtx.save();
  if (isSelected) {
    cityCtx.strokeStyle = '#ffffff';
    cityCtx.lineWidth = Math.max(1, 2 / currentZoom());
    if (node.footprint > 1) {
      cityCtx.strokeRect(node.x - half - 1, node.y - half - 1, node.footprint + 2, node.footprint + 2);
    } else {
      const r = Math.max(2.5, 5 / currentZoom());
      cityCtx.beginPath();
      cityCtx.arc(node.x, node.y, r, 0, Math.PI * 2);
      cityCtx.stroke();
    }
  }
  cityCtx.fillStyle = color;
  cityCtx.globalAlpha = 0.9;
  if (node.footprint > 1) {
    cityCtx.fillRect(node.x - half, node.y - half, node.footprint, node.footprint);
  } else {
    const r = Math.max(1.8, 3.5 / currentZoom());
    cityCtx.beginPath();
    cityCtx.arc(node.x, node.y, r, 0, Math.PI * 2);
    cityCtx.fill();
  }
  cityCtx.restore();
}

function redrawCities(): void {
  cityCtx.clearRect(0, 0, SLG_MAP_W, SLG_MAP_H);
  for (const node of cityStore.nodes) drawCityMarker(node, node.id === selectedCityId);
}

// ── Zoom / layout ────────────────────────────────────────────────────────
function applyZoom(): void {
  const z = currentZoom();
  canvasStack.style.width = `${SLG_MAP_W * z}px`;
  canvasStack.style.height = `${SLG_MAP_H * z}px`;
  for (const c of [mapCanvas, overlayCanvas, cityCanvas]) {
    c.style.width = `${SLG_MAP_W * z}px`;
    c.style.height = `${SLG_MAP_H * z}px`;
  }
  redrawOverlay();
  redrawCities();
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
  canvasStack.classList.toggle('tool-city', tool === 'city');
  if (tool !== 'select') {
    selectedPathId = null;
    deletePathBtn.disabled = true;
    renderPathList();
  }
  if (tool !== 'city') selectCity(null);
  redrawOverlay();
  redrawCities();
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

// ── City inspector ───────────────────────────────────────────────────────
function cityLabel(node: MapEditorCityNode): string {
  const provLine = node.provinceIdx !== undefined ? `\nprovince: ${node.provinceIdx}` : '';
  return `id: ${node.id}\nkind: ${node.kind}\nlevel: ${node.level}\nfootprint: ${node.footprint}×${node.footprint}${provLine}\nx: ${node.x}, y: ${node.y}`;
}

function selectCity(id: string | null): void {
  selectedCityId = id;
  const node = id ? cityStore.get(id) : undefined;
  cityInfoEl.textContent = node
    ? cityLabel(node)
    : 'City 工具下拖动地图上的城池标记即可移动坐标（世界中心 9×9 占地拖拽时保持形状）；点击标记查看详情。';
  redrawCities();
}

resetCitiesBtn.addEventListener('click', () => loadCitiesAndRedraw(seedInput.value || 'preview'));

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

cityExportBtn.addEventListener('click', () => {
  cityJsonEl.value = cityStore.toJSON();
  statusEl.textContent = `Exported ${cityStore.nodes.length} cit${cityStore.nodes.length === 1 ? 'y' : 'ies'}.`;
});
cityImportBtn.addEventListener('click', () => {
  try {
    cityStore.loadFromJSON(cityJsonEl.value);
    selectCity(null);
    statusEl.textContent = `Imported ${cityStore.nodes.length} cit${cityStore.nodes.length === 1 ? 'y' : 'ies'}.`;
  } catch (err) {
    statusEl.textContent = `Import failed: ${(err as Error).message}`;
  }
});

// ── Publish to server (§24 admin map-template API) ───────────────────────
const api = new Api();
adminBaseInput.value = api.baseUrl;
api.onUnauthorized = () => showLoggedOut();

function showLoggedIn(whoami: string): void {
  publishLoginEl.style.display = 'none';
  publishPanelEl.style.display = 'flex';
  publishWhoamiEl.textContent = whoami;
  void refreshTemplates();
}
function showLoggedOut(): void {
  publishLoginEl.style.display = 'flex';
  publishPanelEl.style.display = 'none';
  templates = [];
  selectedTemplateId = null;
  renderTemplateList();
}

// ── Template picker (list / activate / delete, §24) ─────────────────────
let templates: MapTemplateSummary[] = [];
let selectedTemplateId: string | null = null;

function renderTemplateList(): void {
  templateCountEl.textContent = String(templates.length);
  templateListEl.innerHTML = templates
    .map(
      (t) =>
        `<div class="path-row${t.templateId === selectedTemplateId ? ' selected' : ''}" data-id="${t.templateId}">` +
        `<i style="background:${t.active ? 'var(--ok)' : 'var(--text-dim)'}"></i>${t.templateId}${t.active ? ' (active)' : ''} — ${t.width}×${t.height}, ${t.tileCount} tiles, v${t.version}</div>`,
    )
    .join('');
  for (const row of Array.from(templateListEl.querySelectorAll<HTMLDivElement>('.path-row'))) {
    row.addEventListener('click', () => {
      selectedTemplateId = row.dataset.id!;
      templateIdInput.value = selectedTemplateId;
      renderTemplateList();
    });
  }
}

async function refreshTemplates(): Promise<void> {
  if (!api.hasToken) return;
  try {
    templates = await api.listMapTemplates();
    renderTemplateList();
  } catch (err) {
    statusEl.textContent = `Failed to list templates: ${err instanceof ApiError ? err.message : (err as Error).message}`;
  }
}

templateRefreshBtn.addEventListener('click', () => void refreshTemplates());

templateActivateBtn.addEventListener('click', async () => {
  const templateId = (selectedTemplateId || templateIdInput.value.trim());
  if (!templateId) {
    statusEl.textContent = 'Pick or type a template ID first.';
    return;
  }
  templateActivateBtn.disabled = true;
  try {
    await api.activateMapTemplate(templateId);
    statusEl.textContent = `Activated template "${templateId}" — new worlds will clone it from now on.`;
    await refreshTemplates();
  } catch (err) {
    statusEl.textContent = `Activate failed: ${err instanceof ApiError ? err.message : (err as Error).message}`;
  } finally {
    templateActivateBtn.disabled = false;
  }
});

templateDeleteBtn.addEventListener('click', async () => {
  const templateId = (selectedTemplateId || templateIdInput.value.trim());
  if (!templateId) {
    statusEl.textContent = 'Pick or type a template ID first.';
    return;
  }
  if (!window.confirm(`Delete template "${templateId}"? This cannot be undone.`)) return;
  templateDeleteBtn.disabled = true;
  try {
    await api.deleteMapTemplate(templateId);
    if (selectedTemplateId === templateId) selectedTemplateId = null;
    statusEl.textContent = `Deleted template "${templateId}".`;
    await refreshTemplates();
  } catch (err) {
    statusEl.textContent = `Delete failed: ${err instanceof ApiError ? err.message : (err as Error).message}`;
  } finally {
    templateDeleteBtn.disabled = false;
  }
});

adminLoginBtn.addEventListener('click', async () => {
  api.setBaseUrl(adminBaseInput.value.trim());
  adminLoginBtn.disabled = true;
  try {
    const session = await api.login(adminUserInput.value.trim(), adminPassInput.value);
    adminPassInput.value = '';
    showLoggedIn(`${session.admin.displayName} (${session.admin.role})`);
    statusEl.textContent = 'Logged in.';
  } catch (err) {
    statusEl.textContent = `Login failed: ${err instanceof ApiError ? err.message : (err as Error).message}`;
  } finally {
    adminLoginBtn.disabled = false;
  }
});

adminLogoutBtn.addEventListener('click', async () => {
  await api.logout();
  showLoggedOut();
  statusEl.textContent = 'Logged out.';
});

templateGenerateBtn.addEventListener('click', async () => {
  const templateId = templateIdInput.value.trim() || seedInput.value || 'preview';
  templateGenerateBtn.disabled = true;
  statusEl.textContent = `Generating template "${templateId}" (${SLG_MAP_W}×${SLG_MAP_H})…`;
  try {
    const summary = await api.generateMapTemplate(templateId, SLG_MAP_W, SLG_MAP_H);
    statusEl.textContent = `Generated template "${summary.templateId}" — ${summary.tileCount} tiles (v${summary.version}).`;
    selectedTemplateId = summary.templateId;
    await refreshTemplates();
  } catch (err) {
    statusEl.textContent = `Generate failed: ${err instanceof ApiError ? err.message : (err as Error).message}`;
  } finally {
    templateGenerateBtn.disabled = false;
  }
});

publishBtn.addEventListener('click', async () => {
  const templateId = templateIdInput.value.trim() || seedInput.value || 'preview';
  const worldId = seedInput.value || 'preview';
  publishBtn.disabled = true;
  statusEl.textContent = 'Rasterizing edits…';
  try {
    const diffs: MapTemplateTile[] = rasterizeMapEdits(worldId, store.paths, cityStore.nodes);
    if (diffs.length === 0) {
      statusEl.textContent = 'Nothing to publish — no tiles differ from the procedural baseline.';
      return;
    }
    statusEl.textContent = `Publishing ${diffs.length} tile(s) to template "${templateId}"…`;
    let updated = 0;
    for (let i = 0; i < diffs.length; i += MAP_TEMPLATE_SAVE_MAX_TILES) {
      const chunk = diffs.slice(i, i + MAP_TEMPLATE_SAVE_MAX_TILES);
      const r = await api.saveMapTemplateTiles(templateId, chunk);
      updated += r.updated;
    }
    statusEl.textContent = `Published ${updated} tile(s) to template "${templateId}".`;
    await refreshTemplates();
  } catch (err) {
    statusEl.textContent = `Publish failed: ${err instanceof ApiError ? err.message : (err as Error).message}`;
  } finally {
    publishBtn.disabled = false;
  }
});

if (api.hasToken) {
  api.me().then(
    (r) => showLoggedIn(`${r.admin.displayName} (${r.admin.role})`),
    () => showLoggedOut(),
  );
} else {
  showLoggedOut();
}

// ── Canvas input (single input surface: city-canvas, topmost layer) ──────
function tileFromEvent(ev: MouseEvent): TilePoint {
  const rect = cityCanvas.getBoundingClientRect();
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

/** Nearest city whose footprint box (or hit radius, for 1×1 nodes) contains/is near (x,y). */
function findNearestCity(tp: TilePoint): string | null {
  const rTiles = hitRadiusTiles();
  let best: { id: string; dist: number } | null = null;
  for (const node of cityStore.nodes) {
    const half = node.footprint / 2;
    const dx = Math.max(0, Math.abs(tp.x - node.x) - half);
    const dy = Math.max(0, Math.abs(tp.y - node.y) - half);
    const dist = Math.hypot(dx, dy);
    if (dist <= rTiles && (!best || dist < best.dist)) best = { id: node.id, dist };
  }
  return best ? best.id : null;
}

function clampCityPos(node: MapEditorCityNode, tp: TilePoint): TilePoint {
  const half = Math.floor(node.footprint / 2);
  return {
    x: Math.max(half, Math.min(SLG_MAP_W - 1 - half, tp.x)),
    y: Math.max(half, Math.min(SLG_MAP_H - 1 - half, tp.y)),
  };
}

cityCanvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  const tp = tileFromEvent(ev);

  if (tool === 'city') {
    const id = findNearestCity(tp);
    selectCity(id);
    if (id) draggingCityId = id;
    return;
  }

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

cityCanvas.addEventListener('mousemove', (ev) => {
  const tp = tileFromEvent(ev);
  const tile = proceduralTile(seedInput.value || 'preview', tp.x, tp.y);
  const resLine = tile.resType ? `\nresource: ${RESOURCE_LABELS[tile.resType]}` : '';
  tileInfoEl.textContent = `(${tp.x}, ${tp.y})\ntype: ${tile.type}\nlevel: ${tile.level}${resLine}`;

  if (draggingCityId) {
    const node = cityStore.get(draggingCityId);
    if (node) {
      const clamped = clampCityPos(node, tp);
      node.x = clamped.x;
      node.y = clamped.y;
      cityInfoEl.textContent = cityLabel(node);
    }
    redrawCities();
    return;
  }
  if (dragging) {
    const path = store.get(dragging.pathId);
    if (path) path.points[dragging.pointIdx] = tp;
    redrawOverlay();
    return;
  }
  if (draft) redrawOverlay(tp);
});

window.addEventListener('mouseup', () => {
  if (draggingCityId) {
    draggingCityId = null;
    statusEl.textContent = `Moved city "${selectedCityId}".`;
  }
  if (dragging) {
    dragging = null;
    renderBaseMap(seedInput.value || 'preview');
  }
});

cityCanvas.addEventListener('dblclick', (ev) => {
  if (tool !== 'river' && tool !== 'mountain') return;
  if (!draft) return;
  ev.preventDefault();
  // The second click of the dblclick already pushed a duplicate point via mousedown; drop it.
  if (draft.length >= 2) {
    const [a, b] = draft.slice(-2);
    if (a && b && a.x === b.x && a.y === b.y) draft.pop();
  }
  finishDraft();
});

cityCanvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (tool === 'city') return; // no delete-by-right-click for generated city nodes
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
regenBtn.addEventListener('click', () => {
  renderBaseMap(seedInput.value || 'preview');
  loadCitiesAndRedraw(seedInput.value || 'preview');
});
zoomInput.addEventListener('input', applyZoom);
widthInput.value = String(randomDefaultWidth());

renderLegend();
applyZoom();
renderBaseMap(seedInput.value);
loadCitiesAndRedraw(seedInput.value);
renderPathList();

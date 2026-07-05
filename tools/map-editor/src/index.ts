// Map Editor entry point (DESIGN.md §6): PixiJS isometric viewport render (same atlases/projection
// as the game client's WorldMapRenderer — DESIGN.md §6.3 art-parity requirement) + river/mountain
// path brush + city drag + publish-to-server (§8, §24 admin map-template API). River/mountain paths
// and city positions are rasterized (mapEdit.ts's rasterizeMapEdits) into a tile diff both for the
// live WYSIWYG preview (baked into the base layer on every commit) and for publishing — the exact
// same function drives both, so "what you see" and "what gets published" can never drift apart.
import * as PIXI from 'pixi.js-legacy';
import { MAP_TEMPLATE_SAVE_MAX_TILES, proceduralTile, rasterizeMapEdits, SLG_MAP_H, SLG_MAP_W, type MapTemplateSummary, type MapTemplateTile, type ResourceType, type TileType } from '@nw/shared/slg';
import { distToPath, PathStore, randomDefaultWidth, type PathKind, type TilePoint } from './state/paths';
import { CityStore, type MapEditorCityNode } from './state/cities';
import { Api, ApiError } from './api';
import { screenToTile, tileToScreen, visibleTileBounds } from './render/isoGrid';
import { drawEditorTile } from './render/tileGraphics';
import { terrainTextureName } from './render/tileStyle';
import { loadTerrainAtlas } from './render/terrainAtlasLoader';
import { loadResAtlas } from './render/resAtlasLoader';
import { loadBuildingAtlas } from './render/buildingAtlasLoader';
import { getLocale, t, toggleLocale } from './i18n';

const RESOURCE_LABELS: Record<ResourceType, string> = {
  ink: '墨(ink)',
  paper: '纸(paper)',
  graphite: '碳(graphite)',
  metal: '铁(metal)',
  sticker: '贴纸(sticker)',
};

const PATH_COLORS: Record<PathKind, number> = { river: 0x4fa8e0, mountain: 0xa0785a };
const PATH_COLORS_CSS: Record<PathKind, string> = { river: '#4fa8e0', mountain: '#a0785a' };
const CITY_COLORS: Record<MapEditorCityNode['kind'], number> = {
  worldCenter: 0xff5c8a,
  capital: 0xffd166,
  gateCity: 0xef6c53,
  garrison: 0x4ce0c0,
};
const CITY_COLORS_CSS: Record<MapEditorCityNode['kind'], string> = {
  worldCenter: '#ff5c8a',
  capital: '#ffd166',
  gateCity: '#ef6c53',
  garrison: '#4ce0c0',
};
const TERRAIN_LEGEND: TileType[] = ['neutral', 'resource', 'territory', 'familyKeep', 'center', 'obstacle', 'gate', 'stronghold'];
const TERRAIN_LEGEND_CSS: Record<TileType, string> = {
  neutral: '#f5f0e8', resource: '#f0ece0', territory: '#f5f0e8', familyKeep: '#e8d29a',
  center: '#f0dfa0', base: '#f5f0e8', obstacle: '#c4bdb0', gate: '#d8c2a0', stronghold: '#9a7a6a',
};

// ── Viewport (camera into the up-to-500×500 world; see DESIGN.md §6.3) ────────────
const VIEW_W = 900;
const VIEW_H = 620;
/** Rendered tiles extend this far past the visible edge so short pans don't reveal blank space (§ live-drag tradeoff below). */
const VIEW_PAD_FACTOR = 1.5;
const ZOOM_MIN = 10;
const ZOOM_MAX = 56;

const pixiRoot = document.getElementById('pixi-root')!;
const app = new PIXI.Application({ width: VIEW_W, height: VIEW_H, backgroundColor: 0x11111b, antialias: true });
pixiRoot.appendChild(app.view as HTMLCanvasElement);

const worldLayer = new PIXI.Container();
app.stage.addChild(worldLayer);
const baseLayer = new PIXI.Container();
baseLayer.sortableChildren = true;
const overlayLayer = new PIXI.Container();
worldLayer.addChild(baseLayer, overlayLayer);

const seedInput = document.getElementById('world-seed') as HTMLInputElement;
const regenBtn = document.getElementById('btn-regen') as HTMLButtonElement;
const centerBtn = document.getElementById('btn-center') as HTMLButtonElement;
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
const pathsTitleEl = document.getElementById('paths-title')!;
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
const templatesTitleEl = document.getElementById('templates-title')!;
const templateRefreshBtn = document.getElementById('btn-template-refresh') as HTMLButtonElement;
const templateActivateBtn = document.getElementById('btn-template-activate') as HTMLButtonElement;
const templateDeleteBtn = document.getElementById('btn-template-delete') as HTMLButtonElement;
const langBtn = document.getElementById('btn-lang') as HTMLButtonElement;

// ── Editor state ─────────────────────────────────────────────────────────
type Tool = 'select' | PathKind | 'city' | 'pan';
let tool: Tool = 'select';
const store = new PathStore();
const cityStore = new CityStore();
let draft: TilePoint[] | null = null;
let selectedPathId: string | null = null;
let dragging: { pathId: string; pointIdx: number } | null = null;
let selectedCityId: string | null = null;
let draggingCityId: string | null = null;
let panning = false;
let panLast: { x: number; y: number } | null = null;
/** Whether the Tile inspector panel has shown real hover data yet (vs. its initial hint text). */
let tileInfoShown = false;

let tp = 28; // on-screen tile width in px — the sole "zoom" knob (replaces the old CSS-scale slider)
let panX = 0;
let panY = 0;
/** worldId → tile diff Map ("x:y" → override), refreshed by renderBaseMap(); reused by hover info. */
let diffCache = new Map<string, MapTemplateTile>();

/** Point/segment/city hit-test radius, in on-screen px, converted to tile units at the current zoom. */
const HIT_RADIUS_PX = 8;
function hitRadiusTiles(): number {
  return HIT_RADIUS_PX / tp;
}

/** "{n} tile(s)"/"{n} 个格子" — composed so both locales pluralize (or don't) correctly. */
function tileCountLabel(n: number): string {
  return `${n} ${t(n === 1 ? 'unit.tile' : 'unit.tiles')}`;
}
function pathCountLabel(n: number): string {
  return `${n} ${t(n === 1 ? 'unit.path' : 'unit.paths')}`;
}
function cityCountLabel(n: number): string {
  return `${n} ${t(n === 1 ? 'unit.city' : 'unit.cities')}`;
}

/**
 * Stores a render thunk (not a pre-formatted string) so a locale toggle can re-run it and pick up
 * the new language — this matters for messages built from count-label helpers like tileCountLabel(),
 * whose singular/plural wording is locale-dependent and would otherwise go stale after a toggle.
 */
let lastStatusRender: (() => string) | null = null;
function setStatus(render: () => string): void {
  lastStatusRender = render;
  statusEl.textContent = render();
}

function clampPan(): void {
  const corners = [
    tileToScreen(0, 0, tp), tileToScreen(SLG_MAP_W, 0, tp),
    tileToScreen(0, SLG_MAP_H, tp), tileToScreen(SLG_MAP_W, SLG_MAP_H, tp),
  ];
  const minSx = Math.min(...corners.map((c) => c.x));
  const maxSx = Math.max(...corners.map((c) => c.x));
  const minSy = Math.min(...corners.map((c) => c.y));
  const maxSy = Math.max(...corners.map((c) => c.y));
  panX = maxSx - minSx <= VIEW_W ? VIEW_W / 2 - (minSx + maxSx) / 2 : Math.min(-minSx, Math.max(VIEW_W - maxSx, panX));
  panY = maxSy - minSy <= VIEW_H ? VIEW_H / 2 - (minSy + maxSy) / 2 : Math.min(-minSy, Math.max(VIEW_H - maxSy, panY));
  worldLayer.position.set(panX, panY);
}

function centerView(): void {
  const s = tileToScreen(SLG_MAP_W / 2, SLG_MAP_H / 2, tp);
  panX = VIEW_W / 2 - s.x;
  panY = VIEW_H / 2 - s.y;
  clampPan();
}

// ── Base map render (real atlas textures — DESIGN.md §6.3 art-parity) ─────
function effectiveTile(worldId: string, x: number, y: number): { type: TileType; level: number; resType?: ResourceType } {
  return diffCache.get(`${x}:${y}`) ?? proceduralTile(worldId, x, y);
}

function renderBaseMap(worldId: string): void {
  const t0 = performance.now();
  const diffs = rasterizeMapEdits(worldId, store.paths, cityStore.nodes);
  diffCache = new Map(diffs.map((d) => [`${d.x}:${d.y}`, d]));

  baseLayer.removeChildren().forEach((c) => c.destroy({ children: true }));

  const padW = VIEW_W * VIEW_PAD_FACTOR;
  const padH = VIEW_H * VIEW_PAD_FACTOR;
  const b = visibleTileBounds(padW, padH, panX + (padW - VIEW_W) / 2, panY + (padH - VIEW_H) / 2, tp);
  const x0 = Math.max(0, b.minTx);
  const x1 = Math.min(SLG_MAP_W - 1, b.maxTx);
  const y0 = Math.max(0, b.minTy);
  const y1 = Math.min(SLG_MAP_H - 1, b.maxTy);

  let count = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const tile = effectiveTile(worldId, tx, ty);
      const g = new PIXI.Graphics();
      const s = tileToScreen(tx, ty, tp);
      g.x = s.x;
      g.y = s.y;
      g.zIndex = tx + ty;
      drawEditorTile(g, tile, terrainTextureName(tile.type, tx, ty), tp);
      baseLayer.addChild(g);
      count++;
    }
  }
  const ms = (performance.now() - t0).toFixed(0);
  setStatus(() =>
    t('status.rendered', {
      worldId,
      tiles: tileCountLabel(count),
      ms,
      paths: pathCountLabel(store.paths.length),
      cities: cityCountLabel(cityStore.nodes.length),
    }),
  );
}

function loadCitiesAndRedraw(worldId: string): void {
  cityStore.loadFromSeed(worldId);
  selectedCityId = null;
  cityInfoEl.textContent = t('city.hint');
  renderBaseMap(worldId);
  redrawAll();
}

// ── Overlay (draft/selection chrome — vector, not atlas art; see module header) ────
function strokePolylineScreen(g: PIXI.Graphics, points: readonly TilePoint[], width: number, color: number, alpha: number): void {
  if (points.length < 2) return;
  g.lineStyle(Math.max(1, width * tp * 0.5), color, alpha);
  const p0 = tileToScreen(points[0]!.x, points[0]!.y, tp);
  g.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i++) {
    const p = tileToScreen(points[i]!.x, points[i]!.y, tp);
    g.lineTo(p.x, p.y);
  }
}

function drawPointHandlesScreen(g: PIXI.Graphics, points: readonly TilePoint[], color: number): void {
  const r = 4;
  g.lineStyle(0);
  g.beginFill(color);
  for (const p of points) {
    const s = tileToScreen(p.x, p.y, tp);
    g.drawCircle(s.x, s.y, r);
  }
  g.endFill();
}

function redrawOverlay(hoverTile?: TilePoint): void {
  const g = new PIXI.Graphics();
  for (const path of store.paths) {
    const isSelected = path.id === selectedPathId;
    if (isSelected) strokePolylineScreen(g, path.points, path.width + 3, 0xffffff, 0.25);
    strokePolylineScreen(g, path.points, path.width, PATH_COLORS[path.type], 0.55);
    if (tool === 'select') drawPointHandlesScreen(g, path.points, isSelected ? 0xffffff : PATH_COLORS[path.type]);
  }
  if (draft) {
    const kind = tool as PathKind;
    const preview = hoverTile ? [...draft, hoverTile] : draft;
    strokePolylineScreen(g, preview, Number(widthInput.value) || 1, PATH_COLORS[kind], 0.35);
    drawPointHandlesScreen(g, draft, PATH_COLORS[kind]);
  }
  overlayLayer.addChild(g);
}

// ── City markers (footprint outline + selection ring — see module header) ─────────
function drawCityMarkers(): void {
  const g = new PIXI.Graphics();
  for (const node of cityStore.nodes) {
    const isSelected = node.id === selectedCityId;
    const color = CITY_COLORS[node.kind];
    const half = node.footprint / 2;
    // Footprint corners project to a parallelogram under the iso transform, not an axis-aligned box.
    const corners = [
      tileToScreen(node.x - half, node.y - half, tp),
      tileToScreen(node.x + half, node.y - half, tp),
      tileToScreen(node.x + half, node.y + half, tp),
      tileToScreen(node.x - half, node.y + half, tp),
    ];
    if (isSelected) {
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

function redrawAll(hoverTile?: TilePoint): void {
  overlayLayer.removeChildren().forEach((c) => c.destroy());
  redrawOverlay(hoverTile);
  drawCityMarkers();
}

// ── Zoom (tile px width; keeps the tile under the anchor point fixed) ─────────────
function setZoom(nextTp: number, anchor?: { sx: number; sy: number }): void {
  nextTp = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(nextTp)));
  if (nextTp === tp) return;
  const ax = anchor?.sx ?? VIEW_W / 2;
  const ay = anchor?.sy ?? VIEW_H / 2;
  const frac = screenToTile(ax - panX, ay - panY, tp);
  tp = nextTp;
  const s = tileToScreen(frac.x, frac.y, tp);
  panX = ax - s.x;
  panY = ay - s.y;
  clampPan();
  renderBaseMap(seedInput.value || 'preview');
  redrawAll();
}

zoomInput.min = String(ZOOM_MIN);
zoomInput.max = String(ZOOM_MAX);
zoomInput.step = '2';
zoomInput.value = String(tp);
zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));

app.view.addEventListener?.('wheel', (ev: Event) => {
  const we = ev as WheelEvent;
  we.preventDefault();
  const rect = (app.view as HTMLCanvasElement).getBoundingClientRect();
  setZoom(tp - Math.sign(we.deltaY) * 4, { sx: we.clientX - rect.left, sy: we.clientY - rect.top });
  zoomInput.value = String(tp);
}, { passive: false });

centerBtn.addEventListener('click', () => { centerView(); renderBaseMap(seedInput.value || 'preview'); redrawAll(); });

// ── Tool switching ───────────────────────────────────────────────────────
function cancelDraft(): void {
  draft = null;
  redrawAll();
}

function setTool(next: Tool): void {
  if (tool !== next) cancelDraft();
  tool = next;
  for (const btn of toolButtons) btn.classList.toggle('active', btn.dataset.tool === tool);
  canvasEl().style.cursor = tool === 'pan' ? 'grab' : tool === 'select' || tool === 'city' ? 'default' : 'crosshair';
  if (tool !== 'select') {
    selectedPathId = null;
    deletePathBtn.disabled = true;
    renderPathList();
  }
  if (tool !== 'city') selectCity(null);
  redrawAll();
}

for (const btn of toolButtons) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool as Tool));
}

// ── Path list / inspector ───────────────────────────────────────────────
function renderPathList(): void {
  pathsTitleEl.textContent = t('insp.pathsTitle', { count: store.paths.length });
  pathListEl.innerHTML = store.paths
    .map(
      (p, i) =>
        `<div class="path-row${p.id === selectedPathId ? ' selected' : ''}" data-id="${p.id}">` +
        `<i style="background:${PATH_COLORS_CSS[p.type]}"></i>${p.type} #${i + 1} — w${p.width}, ${p.points.length}pt</div>`,
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
  redrawAll();
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
    renderBaseMap(seedInput.value || 'preview');
  }
});

function undoDraftPoint(): void {
  if (!draft) return;
  draft.pop();
  if (draft.length === 0) draft = null;
  redrawAll();
}
undoPointBtn.addEventListener('click', undoDraftPoint);

function finishDraft(): void {
  if (!draft || draft.length < 2) return;
  store.add(tool as PathKind, draft, Math.max(1, Math.round(Number(widthInput.value) || 1)));
  draft = null;
  renderBaseMap(seedInput.value || 'preview');
  renderPathList();
  redrawAll();
}

// ── City inspector ───────────────────────────────────────────────────────
function cityLabel(node: MapEditorCityNode): string {
  const provLine = node.provinceIdx !== undefined ? `\n${t('city.province')}: ${node.provinceIdx}` : '';
  return (
    `${t('city.id')}: ${node.id}\n${t('city.kind')}: ${node.kind}\n${t('city.level')}: ${node.level}\n` +
    `${t('city.footprint')}: ${node.footprint}×${node.footprint}${provLine}\n${t('city.coords', { x: node.x, y: node.y })}`
  );
}

function selectCity(id: string | null): void {
  selectedCityId = id;
  const node = id ? cityStore.get(id) : undefined;
  cityInfoEl.textContent = node ? cityLabel(node) : t('city.hint');
  redrawAll();
}

resetCitiesBtn.addEventListener('click', () => loadCitiesAndRedraw(seedInput.value || 'preview'));

// ── Export / Import ──────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  jsonEl.value = store.toJSON();
  setStatus(() => t('status.pathsExported', { paths: pathCountLabel(store.paths.length) }));
});
importBtn.addEventListener('click', () => {
  try {
    store.loadFromJSON(jsonEl.value);
    selectPath(null);
    renderBaseMap(seedInput.value || 'preview');
    setStatus(() => t('status.pathsImported', { paths: pathCountLabel(store.paths.length) }));
  } catch (err) {
    setStatus(() => t('status.importFailed', { msg: (err as Error).message }));
  }
});

cityExportBtn.addEventListener('click', () => {
  cityJsonEl.value = cityStore.toJSON();
  setStatus(() => t('status.citiesExported', { cities: cityCountLabel(cityStore.nodes.length) }));
});
cityImportBtn.addEventListener('click', () => {
  try {
    cityStore.loadFromJSON(cityJsonEl.value);
    selectCity(null);
    renderBaseMap(seedInput.value || 'preview');
    setStatus(() => t('status.citiesImported', { cities: cityCountLabel(cityStore.nodes.length) }));
  } catch (err) {
    setStatus(() => t('status.importFailed', { msg: (err as Error).message }));
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
  templatesTitleEl.textContent = t('publish.templatesTitle', { count: templates.length });
  templateListEl.innerHTML = templates
    .map(
      (tpl) =>
        `<div class="path-row${tpl.templateId === selectedTemplateId ? ' selected' : ''}" data-id="${tpl.templateId}">` +
        `<i style="background:${tpl.active ? 'var(--ok)' : 'var(--text-dim)'}"></i>${tpl.templateId}${tpl.active ? t('publish.template.active') : ''} — ${tpl.width}×${tpl.height}, ${tileCountLabel(tpl.tileCount)}, v${tpl.version}</div>`,
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
    setStatus(() => t('status.listFailed', { msg: err instanceof ApiError ? err.message : (err as Error).message }));
  }
}

templateRefreshBtn.addEventListener('click', () => void refreshTemplates());

templateActivateBtn.addEventListener('click', async () => {
  const templateId = (selectedTemplateId || templateIdInput.value.trim());
  if (!templateId) {
    setStatus(() => t('status.pickTemplate'));
    return;
  }
  templateActivateBtn.disabled = true;
  try {
    await api.activateMapTemplate(templateId);
    setStatus(() => t('status.activated', { id: templateId }));
    await refreshTemplates();
  } catch (err) {
    setStatus(() => t('status.activateFailed', { msg: err instanceof ApiError ? err.message : (err as Error).message }));
  } finally {
    templateActivateBtn.disabled = false;
  }
});

templateDeleteBtn.addEventListener('click', async () => {
  const templateId = (selectedTemplateId || templateIdInput.value.trim());
  if (!templateId) {
    setStatus(() => t('status.pickTemplate'));
    return;
  }
  if (!window.confirm(t('status.deleteConfirm', { id: templateId }))) return;
  templateDeleteBtn.disabled = true;
  try {
    await api.deleteMapTemplate(templateId);
    if (selectedTemplateId === templateId) selectedTemplateId = null;
    setStatus(() => t('status.deleted', { id: templateId }));
    await refreshTemplates();
  } catch (err) {
    setStatus(() => t('status.deleteFailed', { msg: err instanceof ApiError ? err.message : (err as Error).message }));
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
    setStatus(() => t('status.loggedIn'));
  } catch (err) {
    setStatus(() => t('status.loginFailed', { msg: err instanceof ApiError ? err.message : (err as Error).message }));
  } finally {
    adminLoginBtn.disabled = false;
  }
});

adminLogoutBtn.addEventListener('click', async () => {
  await api.logout();
  showLoggedOut();
  setStatus(() => t('status.loggedOut'));
});

templateGenerateBtn.addEventListener('click', async () => {
  const templateId = templateIdInput.value.trim() || seedInput.value || 'preview';
  templateGenerateBtn.disabled = true;
  setStatus(() => t('status.generating', { id: templateId, w: SLG_MAP_W, h: SLG_MAP_H }));
  try {
    const summary = await api.generateMapTemplate(templateId, SLG_MAP_W, SLG_MAP_H);
    setStatus(() => t('status.generated', { id: summary.templateId, tileCount: summary.tileCount, version: summary.version }));
    selectedTemplateId = summary.templateId;
    await refreshTemplates();
  } catch (err) {
    setStatus(() => t('status.generateFailed', { msg: err instanceof ApiError ? err.message : (err as Error).message }));
  } finally {
    templateGenerateBtn.disabled = false;
  }
});

publishBtn.addEventListener('click', async () => {
  const templateId = templateIdInput.value.trim() || seedInput.value || 'preview';
  const worldId = seedInput.value || 'preview';
  publishBtn.disabled = true;
  setStatus(() => t('status.rasterizing'));
  try {
    const diffs: MapTemplateTile[] = rasterizeMapEdits(worldId, store.paths, cityStore.nodes);
    if (diffs.length === 0) {
      setStatus(() => t('status.nothingToPublish'));
      return;
    }
    setStatus(() => t('status.publishing', { n: diffs.length, id: templateId }));
    let updated = 0;
    for (let i = 0; i < diffs.length; i += MAP_TEMPLATE_SAVE_MAX_TILES) {
      const chunk = diffs.slice(i, i + MAP_TEMPLATE_SAVE_MAX_TILES);
      const r = await api.saveMapTemplateTiles(templateId, chunk);
      updated += r.updated;
    }
    setStatus(() => t('status.published', { n: updated, id: templateId }));
    await refreshTemplates();
  } catch (err) {
    setStatus(() => t('status.publishFailed', { msg: err instanceof ApiError ? err.message : (err as Error).message }));
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

// ── Canvas input (isometric screen↔tile via isoGrid, pan-relative — see module header) ──
function canvasEl(): HTMLCanvasElement {
  return app.view as HTMLCanvasElement;
}

function screenFromClientXY(clientX: number, clientY: number): { sx: number; sy: number } {
  const rect = canvasEl().getBoundingClientRect();
  return { sx: ((clientX - rect.left) / rect.width) * VIEW_W, sy: ((clientY - rect.top) / rect.height) * VIEW_H };
}

function tileFromClientXY(clientX: number, clientY: number): TilePoint {
  const { sx, sy } = screenFromClientXY(clientX, clientY);
  const t = screenToTile(sx - panX, sy - panY, tp);
  return { x: Math.max(0, Math.min(SLG_MAP_W - 1, t.x)), y: Math.max(0, Math.min(SLG_MAP_H - 1, t.y)) };
}

function findNearestPoint(t: TilePoint): { pathId: string; pointIdx: number } | null {
  const rTiles = hitRadiusTiles();
  let best: { pathId: string; pointIdx: number; dist: number } | null = null;
  for (const path of store.paths) {
    for (let idx = 0; idx < path.points.length; idx++) {
      const p = path.points[idx]!;
      const dist = Math.hypot(p.x - t.x, p.y - t.y);
      if (dist <= rTiles && (!best || dist < best.dist)) best = { pathId: path.id, pointIdx: idx, dist };
    }
  }
  return best ? { pathId: best.pathId, pointIdx: best.pointIdx } : null;
}

function findNearestPath(t: TilePoint): string | null {
  const rTiles = hitRadiusTiles();
  let best: { id: string; dist: number } | null = null;
  for (const path of store.paths) {
    const dist = distToPath(t.x, t.y, path) - path.width / 2;
    if (dist <= rTiles && (!best || dist < best.dist)) best = { id: path.id, dist };
  }
  return best ? best.id : null;
}

/** Nearest city whose footprint box (or hit radius, for 1×1 nodes) contains/is near (x,y). */
function findNearestCity(t: TilePoint): string | null {
  const rTiles = hitRadiusTiles();
  let best: { id: string; dist: number } | null = null;
  for (const node of cityStore.nodes) {
    const half = node.footprint / 2;
    const dx = Math.max(0, Math.abs(t.x - node.x) - half);
    const dy = Math.max(0, Math.abs(t.y - node.y) - half);
    const dist = Math.hypot(dx, dy);
    if (dist <= rTiles && (!best || dist < best.dist)) best = { id: node.id, dist };
  }
  return best ? best.id : null;
}

function clampCityPos(node: MapEditorCityNode, t: TilePoint): TilePoint {
  const half = Math.floor(node.footprint / 2);
  return {
    x: Math.max(half, Math.min(SLG_MAP_W - 1 - half, t.x)),
    y: Math.max(half, Math.min(SLG_MAP_H - 1 - half, t.y)),
  };
}

canvasEl().addEventListener('mousedown', (ev) => {
  if (ev.button === 1 || tool === 'pan') {
    panning = true;
    panLast = { x: ev.clientX, y: ev.clientY };
    canvasEl().style.cursor = 'grabbing';
    return;
  }
  if (ev.button !== 0) return;
  const t = tileFromClientXY(ev.clientX, ev.clientY);

  if (tool === 'city') {
    const id = findNearestCity(t);
    selectCity(id);
    if (id) draggingCityId = id;
    return;
  }

  if (tool === 'select') {
    const hit = findNearestPoint(t);
    if (hit) {
      dragging = hit;
      selectPath(hit.pathId);
      return;
    }
    selectPath(findNearestPath(t));
    return;
  }

  if (!draft) draft = [t];
  else draft.push(t);
  redrawAll(t);
});

window.addEventListener('mousemove', (ev) => {
  if (panning && panLast) {
    panX += ev.clientX - panLast.x;
    panY += ev.clientY - panLast.y;
    panLast = { x: ev.clientX, y: ev.clientY };
    clampPan();
  }
});

canvasEl().addEventListener('mousemove', (ev) => {
  if (panning) return;
  const pos = tileFromClientXY(ev.clientX, ev.clientY);
  const tile = effectiveTile(seedInput.value || 'preview', pos.x, pos.y);
  const resLine = tile.resType ? `\n${t('tile.resource')}: ${RESOURCE_LABELS[tile.resType]}` : '';
  tileInfoEl.textContent = `(${pos.x}, ${pos.y})\n${t('tile.type')}: ${tile.type}\n${t('tile.level')}: ${tile.level}${resLine}`;
  tileInfoShown = true;

  if (draggingCityId) {
    const node = cityStore.get(draggingCityId);
    if (node) {
      const clamped = clampCityPos(node, pos);
      node.x = clamped.x;
      node.y = clamped.y;
      cityInfoEl.textContent = cityLabel(node);
    }
    redrawAll();
    return;
  }
  if (dragging) {
    const path = store.get(dragging.pathId);
    if (path) path.points[dragging.pointIdx] = pos;
    redrawAll();
    return;
  }
  if (draft) redrawAll(pos);
});

window.addEventListener('mouseup', () => {
  if (panning) {
    panning = false;
    panLast = null;
    canvasEl().style.cursor = tool === 'pan' ? 'grab' : tool === 'select' || tool === 'city' ? 'default' : 'crosshair';
    renderBaseMap(seedInput.value || 'preview');
    redrawAll();
    return;
  }
  if (draggingCityId) {
    draggingCityId = null;
    setStatus(() => t('status.cityMoved', { id: selectedCityId ?? '' }));
    renderBaseMap(seedInput.value || 'preview');
    redrawAll();
  }
  if (dragging) {
    dragging = null;
    renderBaseMap(seedInput.value || 'preview');
    redrawAll();
  }
});

canvasEl().addEventListener('dblclick', (ev) => {
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

canvasEl().addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (tool === 'pan' || tool === 'city') return; // no delete-by-right-click for generated city nodes
  if (tool === 'select') {
    const t = tileFromClientXY(ev.clientX, ev.clientY);
    const id = findNearestPath(t);
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
function renderLegend(): void {
  legendEl.innerHTML = TERRAIN_LEGEND
    .map((kind) => `<div class="row"><i style="background:${TERRAIN_LEGEND_CSS[kind]}"></i>${kind}</div>`)
    .join('');
  cityLegendEl.innerHTML = (Object.keys(CITY_COLORS_CSS) as MapEditorCityNode['kind'][])
    .map((k) => `<div class="row"><i style="background:${CITY_COLORS_CSS[k]}"></i>${k}</div>`)
    .join('');
}

// ── i18n wiring — static chrome via data-i18n attributes, dynamic parts via re-render ──
function applyStaticI18n(): void {
  document.title = t('app.title');
  document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';
  langBtn.textContent = t('toolbar.lang');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    el.textContent = t(el.dataset.i18n!);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n-title]'))) {
    el.title = t(el.dataset.i18nTitle!);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]'))) {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  }
}

function applyDynamicI18n(): void {
  renderPathList();
  renderTemplateList();
  selectCity(selectedCityId);
  if (!tileInfoShown) tileInfoEl.textContent = t('tile.hoverHint');
  statusEl.textContent = lastStatusRender ? lastStatusRender() : t('status.ready');
}

langBtn.addEventListener('click', () => {
  toggleLocale();
  applyStaticI18n();
  applyDynamicI18n();
});

regenBtn.addEventListener('click', () => {
  renderBaseMap(seedInput.value || 'preview');
  loadCitiesAndRedraw(seedInput.value || 'preview');
});
widthInput.value = String(randomDefaultWidth());

applyStaticI18n();
applyDynamicI18n();
renderLegend();
centerView();
Promise.allSettled([loadTerrainAtlas(), loadResAtlas(), loadBuildingAtlas()]).then(() => {
  renderBaseMap(seedInput.value);
  loadCitiesAndRedraw(seedInput.value);
  redrawAll();
});
renderPathList();

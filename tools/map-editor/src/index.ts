// Map Editor entry point (DESIGN.md §6): PixiJS isometric viewport render (same atlases/projection
// as the game client's WorldMapRenderer — DESIGN.md §6.3 art-parity requirement) + river/mountain
// grid brush + city drag + publish-to-server (§8, §24 admin map-template API). Painting stamps tiles
// directly into a persistent terrain grid (state/terrainGrid.ts) — no vector layer to reconstruct.
// River/mountain tiles and city positions are rasterized (mapEdit.ts's rasterizeMapEdits) into a tile
// diff both for the live WYSIWYG preview (baked into the base layer on every commit) and for
// publishing — the exact same function drives both, so "what you see" and "what gets published" can
// never drift apart.
import * as PIXI from 'pixi.js-legacy';
import { BASE_FOOTPRINT, MAP_TEMPLATE_SAVE_MAX_TILES, proceduralTile, rasterizeMapEdits, SLG_MAP_H, SLG_MAP_MAX_LEVEL, SLG_MAP_W, type MapTemplateSummary, type MapTemplateTile, type ObstacleKind, type ResourceType, type TileType } from '@nw/shared/slg';
import { randomDefaultWidth, TerrainGridStore, type TerrainKind, type TilePoint } from './state/terrainGrid';
import { CityStore, type MapEditorCityNode } from './state/cities';
import { Api, ApiError } from './api';
import { screenToTile, tileToScreen, visibleTileBounds, ISO_RATIO } from './render/isoGrid';
import { drawEditorTile } from './render/tileGraphics';
import { terrainTextureName } from './render/tileStyle';
import { loadTerrainAtlas } from './render/terrainAtlasLoader';
import { loadResAtlas } from './render/resAtlasLoader';
import { loadBuildingAtlas } from './render/buildingAtlasLoader';
import { loadCityAtlas, getCityTextureForLevel, isCityAtlasReady } from './render/cityAtlasLoader';
import { getLocale, t, toggleLocale } from './i18n';

const TERRAIN_COLORS: Record<TerrainKind, number> = {
  river: 0x4fa8e0, mountain: 0xa0785a,
  neutral: 0x9ccf7a, // carve: open a band back to passable land
  bridge: 0x5c9fd6, // river crossing (bridge)
  plankway: 0xc08a52, // mountain crossing (plankway)
};
const CITY_COLORS: Record<MapEditorCityNode['kind'], number> = {
  worldCenter: 0xff5c8a,
  capital: 0xffd166,
  garrison: 0x4ce0c0,
};
const CITY_COLORS_CSS: Record<MapEditorCityNode['kind'], string> = {
  worldCenter: '#ff5c8a',
  capital: '#ffd166',
  garrison: '#4ce0c0',
};
const TERRAIN_LEGEND: TileType[] = ['neutral', 'resource', 'territory', 'familyKeep', 'center', 'obstacle', 'bridge', 'plankway', 'stronghold'];
const TERRAIN_LEGEND_CSS: Record<TileType, string> = {
  neutral: '#f5f0e8', resource: '#f0ece0', territory: '#f5f0e8', familyKeep: '#e8d29a',
  center: '#f0dfa0', base: '#f5f0e8', obstacle: '#c4bdb0', bridge: '#b9c6d2', plankway: '#b2967a', stronghold: '#9a7a6a',
};

// ── Viewport (camera into the up-to-500×500 world; see DESIGN.md §6.3) ────────────
const VIEW_W = 900;
const VIEW_H = 620;
/** Rendered tiles extend this far past the visible edge so short pans don't reveal blank space (§ live-drag tradeoff below). */
const VIEW_PAD_FACTOR = 1.5;
const ZOOM_MIN = 10;
const ZOOM_MAX = 130; // raised 84→130: DEFAULT_TP (900/11≈81) sits near the old cap, so leave real zoom-in headroom
/** Default on-screen tile px = the game client's L1 (detail) density: it sizes tiles as
 * floor(viewportWidth / 11) (client/src/scenes/worldmap/zoom.ts). Matching that divisor here
 * makes the editor open with the SAME on-screen tile count the player sees at full zoom-in.
 * (Divisor 16→13→11: the map read as an over-dense carpet at higher divisors.) */
const DEFAULT_TP = Math.floor(VIEW_W / 11);
/** On-screen width of a base's city sprite in tile-widths — mirrors the game client's BASE_SPRITE_TILES
 * (client/src/scenes/worldmap/constants.ts) so a 3×3 base's art lines up identically; larger cities scale
 * proportionally by footprint (see refreshCitySprites). */
const BASE_SPRITE_TILES = 3.2;

const pixiRoot = document.getElementById('pixi-root')!;
// Aged-paper page background (0xf5f0e8) — the SAME PIXI.Application backgroundColor the game client uses
// (client/src/render/theme.ts palette.paper). This is load-bearing for art parity, NOT cosmetic: the
// terrain atlas is grey pencil on pale paper and impassable tiles (mountain/river) draw at 0.5 alpha so
// they "recede into the paper" (tileStyle.ts TERRAIN_TEX_ALPHA). Over the old dark 0x11111b canvas that
// half-transparency let the dark background bleed through, collapsing the hand-drawn rock/wave art into a
// flat dark blob — which read as "the mountain/river assets aren't showing". A cream page makes them
// render identically to the game (DESIGN.md §6.3 art-parity).
const app = new PIXI.Application({ width: VIEW_W, height: VIEW_H, backgroundColor: 0xf5f0e8, antialias: true });
pixiRoot.appendChild(app.view as HTMLCanvasElement);

// Screen-fixed ruled-paper backdrop, mirroring the game client's buildPaperBackground('worldmap', …,
// { marginLine: false }) (client/src/scenes/worldmap/WorldMapRenderer/build.ts): faint blue notebook rule
// lines (palette.ruleLine 0xb9cfe4) every ~h/28 px, no red left margin line on the SLG overworld. Added to
// the stage BEFORE worldLayer so it stays fixed while the map pans over it, exactly like the game.
const paperBg = new PIXI.Graphics();
{
  const lineGap = Math.round(VIEW_H / 28);
  paperBg.lineStyle(1.1, 0xb9cfe4, 1);
  for (let y = lineGap; y < VIEW_H; y += lineGap) {
    paperBg.moveTo(0, y);
    paperBg.lineTo(VIEW_W, y);
  }
}
app.stage.addChild(paperBg);

const worldLayer = new PIXI.Container();
app.stage.addChild(worldLayer);
const baseLayer = new PIXI.Container();
baseLayer.sortableChildren = true;
// City building sprites (per-level city_atlas art), between the ground tiles and the vector overlay chrome.
// A child of worldLayer so pans translate it for free; only rebuilt when zoom/seed/city positions change
// (NOT on every terrain-brush tick — cities don't move while painting), see refreshCitySprites().
const citySpriteLayer = new PIXI.Container();
citySpriteLayer.sortableChildren = true;
const overlayLayer = new PIXI.Container();
worldLayer.addChild(baseLayer, citySpriteLayer, overlayLayer);

const seedInput = document.getElementById('world-seed') as HTMLInputElement;
const regenBtn = document.getElementById('btn-regen') as HTMLButtonElement;
const centerBtn = document.getElementById('btn-center') as HTMLButtonElement;
const zoomInput = document.getElementById('zoom') as HTMLInputElement;
const statusEl = document.getElementById('status')!;
const tileInfoEl = document.getElementById('tile-info')!;
const legendEl = document.getElementById('legend')!;
const widthInput = document.getElementById('brush-width') as HTMLInputElement;
const clearTerrainBtn = document.getElementById('btn-clear-paths') as HTMLButtonElement;
const resetCitiesBtn = document.getElementById('btn-reset-cities') as HTMLButtonElement;
const terrainTitleEl = document.getElementById('paths-title')!;
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
type Tool = TerrainKind | 'eraser' | 'city' | 'pan';
let tool: Tool = 'pan';
const store = new TerrainGridStore();
const cityStore = new CityStore();
/** True while a river/mountain/eraser brush stroke is being dragged (mousedown → mouseup). */
let painting = false;
/** Last tile the brush stamped — mousemove strokes a line from here to the new cursor tile so a fast
 * drag between two mousemove samples doesn't leave gaps (see TerrainGridStore.strokeCircle). */
let lastPaintPos: TilePoint | null = null;
let selectedCityId: string | null = null;
let draggingCityId: string | null = null;
let panning = false;
let panLast: { x: number; y: number } | null = null;
/** Whether the Tile inspector panel has shown real hover data yet (vs. its initial hint text). */
let tileInfoShown = false;

let tp = DEFAULT_TP; // on-screen tile width in px — the sole "zoom" knob (replaces the old CSS-scale slider).
             // Visible cell count ∝ tp⁻²; default synced to the game client's L1 detail density
             // (VIEW_W/11) so the editor's tile count matches what players see, not ~2× more.
let panX = 0;
let panY = 0;
/** worldId → tile diff Map ("x:y" → override), refreshed by renderBaseMap(); reused by hover info. */
let diffCache = new Map<string, MapTemplateTile>();
/** tx:ty → last-drawn Graphics + a signature of the tile state it reflects; lets renderBaseMap() skip
 * destroying/recreating tiles whose effective terrain hasn't actually changed since the last render. */
const tileGraphicsCache = new Map<string, { g: PIXI.Graphics; sig: string }>();

/** City hit-test radius, in on-screen px, converted to tile units at the current zoom. */
const HIT_RADIUS_PX = 8;
function hitRadiusTiles(): number {
  return HIT_RADIUS_PX / tp;
}

function brushDiameter(): number {
  return Math.max(1, Math.round(Number(widthInput.value) || 1));
}

/** "{n} tile(s)" — composed so both locales pluralize (or don't) correctly. */
function tileCountLabel(n: number): string {
  return `${n} ${t(n === 1 ? 'unit.tile' : 'unit.tiles')}`;
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

function renderTerrainTitle(): void {
  terrainTitleEl.textContent = t('insp.terrainTitle', { count: tileCountLabel(store.size) });
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
function effectiveTile(worldId: string, x: number, y: number): { type: TileType; level: number; resType?: ResourceType; obstacleKind?: ObstacleKind } {
  return diffCache.get(`${x}:${y}`) ?? proceduralTile(worldId, x, y);
}

function renderBaseMap(worldId: string): void {
  const t0 = performance.now();
  // City footprints always win over painted terrain (DESIGN.md §6.2) — rasterize just the cities
  // (cheap: bounded by total city footprint area, not the whole painted grid), then overlay the
  // painted terrain grid directly (no distance/segment math needed — the grid already IS the tile
  // state, so this is a straight Map copy rather than a re-rasterization).
  const cityDiffs = rasterizeMapEdits(worldId, [], cityStore.nodes);
  diffCache = new Map(cityDiffs.map((d) => [`${d.x}:${d.y}`, d]));
  const CROSSING_LEVEL = Math.max(2, SLG_MAP_MAX_LEVEL - 1);
  for (const [key, kind] of store.cells) {
    if (diffCache.has(key)) continue;
    const [xs, ys] = key.split(':');
    const x = Number(xs);
    const y = Number(ys);
    // Preview the painted cell as its baked tile: river/mountain keep their art kind; neutral carves the band
    // open; bridge/plankway show the capturable crossing building over the spanned terrain.
    const preview: MapTemplateTile =
      kind === 'river' ? { x, y, type: 'obstacle', level: 1, obstacleKind: 'river' }
      : kind === 'mountain' ? { x, y, type: 'obstacle', level: 1, obstacleKind: 'mountain' }
      : kind === 'neutral' ? { x, y, type: 'neutral', level: 1 }
      : { x, y, type: kind, level: CROSSING_LEVEL }; // bridge | plankway
    diffCache.set(key, preview);
  }

  const padW = VIEW_W * VIEW_PAD_FACTOR;
  const padH = VIEW_H * VIEW_PAD_FACTOR;
  const b = visibleTileBounds(padW, padH, panX + (padW - VIEW_W) / 2, panY + (padH - VIEW_H) / 2, tp);
  const x0 = Math.max(0, b.minTx);
  const x1 = Math.min(SLG_MAP_W - 1, b.maxTx);
  const y0 = Math.max(0, b.minTy);
  const y1 = Math.min(SLG_MAP_H - 1, b.maxTy);

  // Only (re)create Graphics for tiles whose effective terrain actually changed since the last render —
  // reusing everything else turns a brush tick's cost into O(tiles the stroke touched) instead of
  // O(entire padded viewport), which is what made painting laggy (destroy+recreate every visible tile
  // on every mousemove).
  const nextKeys = new Set<string>();
  let count = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const key = `${tx}:${ty}`;
      nextKeys.add(key);
      const tile = effectiveTile(worldId, tx, ty);
      const texName = terrainTextureName(tile.type, tx, ty, tile.obstacleKind);
      const sig = `${tile.type}|${tile.level}|${tile.resType ?? ''}|${tile.obstacleKind ?? ''}|${texName}|${tp}`;
      const cached = tileGraphicsCache.get(key);
      if (cached && cached.sig === sig) {
        count++;
        continue;
      }
      if (cached) {
        baseLayer.removeChild(cached.g);
        cached.g.destroy({ children: true });
      }
      const g = new PIXI.Graphics();
      const s = tileToScreen(tx, ty, tp);
      g.x = s.x;
      g.y = s.y;
      g.zIndex = tx + ty;
      drawEditorTile(g, tile, texName, tp);
      baseLayer.addChild(g);
      tileGraphicsCache.set(key, { g, sig });
      count++;
    }
  }
  for (const [key, entry] of tileGraphicsCache) {
    if (!nextKeys.has(key)) {
      baseLayer.removeChild(entry.g);
      entry.g.destroy({ children: true });
      tileGraphicsCache.delete(key);
    }
  }
  const ms = (performance.now() - t0).toFixed(0);
  renderTerrainTitle();
  setStatus(() =>
    t('status.rendered', {
      worldId,
      tiles: tileCountLabel(count),
      ms,
      painted: tileCountLabel(store.size),
      cities: cityCountLabel(cityStore.nodes.length),
    }),
  );
}

function loadCitiesAndRedraw(worldId: string): void {
  cityStore.loadFromSeed(worldId);
  selectedCityId = null;
  cityInfoEl.textContent = t('city.hint');
  renderBaseMap(worldId);
  refreshCitySprites();
  redrawAll();
}

/**
 * Rebuilds the per-level city building sprites (city_atlas art) from cityStore.nodes — the same visuals the
 * game renders (DESIGN.md §6.3 art-parity). Cheap (~70 nodes) and deliberately NOT called on every
 * terrain-brush tick: cities don't move while painting, so this only runs on seed/zoom/city-position changes.
 * Sprite width = (footprint/BASE_FOOTPRINT) × BASE_SPRITE_TILES tiles — LINEAR in footprint so every city
 * fills its own plot the same way a player base fills its 3×3 (footprint 3 → 3.2 tiles, unchanged). Mirrors
 * the game client's WorldMapRenderer city layer. (Was √-scaled, which under-filled big plots — a 9×9 world
 * center reached only ~5.5 tiles and left most of its ground exposed.)
 */
function refreshCitySprites(): void {
  citySpriteLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  if (!isCityAtlasReady()) return;
  for (const node of cityStore.nodes) {
    const tex = getCityTextureForLevel(node.level);
    if (!tex) continue;
    const sp = new PIXI.Sprite(tex);
    // Bottom-center anchor between the plot CENTER and its front vertex (matches the game client's
    // WorldMapRenderer city layer): the atlas art is now bottom-aligned (pack_city_atlas.js sits every
    // building's foot on the cell's bottom edge), so the anchor lands the foot on the plot uniformly.
    // groundFwd nudges it 55% toward the front vertex so it reads as planted with only a small
    // forecourt apron, while staying back far enough that the wide base never covers front resource
    // tiles (the tall body rises up-and-back, occluding only back tiles — correct isometric depth).
    sp.anchor.set(0.5, 1);
    const s = tileToScreen(node.x, node.y, tp);
    const groundFwd = (node.footprint * tp * ISO_RATIO) / 2 * 0.55;
    sp.x = s.x;
    sp.y = s.y + groundFwd;
    sp.zIndex = node.x + node.y;
    const spriteTiles = (node.footprint / BASE_FOOTPRINT) * BASE_SPRITE_TILES;
    sp.width = spriteTiles * tp;
    sp.height = spriteTiles * tp;
    citySpriteLayer.addChild(sp);
  }
}

// ── Overlay (brush cursor / city markers — vector, not atlas art; see module header) ────
/** Projects a tile-space circle (the brush footprint) into screen space, sampling points around its
 * circumference — the iso transform is linear, so this yields the correct ellipse outline. */
function brushOutlinePoints(cx: number, cy: number, r: number): number[] {
  const SEGMENTS = 28;
  const pts: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    const s = tileToScreen(cx + Math.cos(a) * r, cy + Math.sin(a) * r, tp);
    pts.push(s.x, s.y);
  }
  return pts;
}

function drawBrushCursor(hoverTile?: TilePoint): void {
  if (!hoverTile || tool === 'city' || tool === 'pan') return;
  const g = new PIXI.Graphics();
  const r = brushDiameter() / 2;
  const pts = brushOutlinePoints(hoverTile.x, hoverTile.y, r);
  if (tool === 'eraser') {
    g.lineStyle(1.5, 0xffffff, 0.9);
  } else {
    const color = TERRAIN_COLORS[tool];
    g.lineStyle(1.5, color, 0.9);
    g.beginFill(color, 0.18);
  }
  g.drawPolygon(pts);
  if (tool !== 'eraser') g.endFill();
  overlayLayer.addChild(g);
}

// ── City markers (footprint outline + selection ring — see module header) ─────────
// Only shown while the City tool is active: the per-level city sprites (refreshCitySprites) now carry the
// visual, so overlaying a translucent box on every city under every tool would just clutter the map. In
// City mode the boxes mark the draggable footprints + selection.
function drawCityMarkers(): void {
  if (tool !== 'city') return;
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
  drawBrushCursor(hoverTile);
  drawCityMarkers();
}

/**
 * Coalesces render requests fired from high-frequency events (mousemove during a drag) down to at most
 * one render per animation frame — without this, a stroke's cost scaled with raw mouse-event rate
 * (which can far exceed the display's refresh rate) instead of frame rate.
 */
let renderScheduled = false;
let pendingBaseRender = false;
let pendingHoverTile: TilePoint | undefined;
function scheduleRender(opts: { base: boolean; hover?: TilePoint }): void {
  if (opts.base) pendingBaseRender = true;
  pendingHoverTile = opts.hover;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (pendingBaseRender) {
      renderBaseMap(seedInput.value || 'preview');
      pendingBaseRender = false;
    }
    redrawAll(pendingHoverTile);
  });
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
  refreshCitySprites();
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
function setTool(next: Tool): void {
  tool = next;
  for (const btn of toolButtons) btn.classList.toggle('active', btn.dataset.tool === tool);
  canvasEl().style.cursor = tool === 'pan' ? 'grab' : tool === 'city' ? 'default' : 'crosshair';
  if (tool !== 'city') selectCity(null);
  redrawAll();
}

for (const btn of toolButtons) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool as Tool));
}

clearTerrainBtn.addEventListener('click', () => {
  store.clear();
  renderBaseMap(seedInput.value || 'preview');
});

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
  setStatus(() => t('status.terrainExported', { tiles: tileCountLabel(store.size) }));
});
importBtn.addEventListener('click', () => {
  try {
    store.loadFromJSON(jsonEl.value);
    renderBaseMap(seedInput.value || 'preview');
    setStatus(() => t('status.terrainImported', { tiles: tileCountLabel(store.size) }));
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
    refreshCitySprites();
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
    const diffs: MapTemplateTile[] = rasterizeMapEdits(worldId, store.toTileInputs(), cityStore.nodes);
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

  // Start a brush stroke: stamp immediately at the click point, then mousemove strokes the grid as the
  // cursor moves — a plain click already paints (no drag required), matching an image-editor brush.
  if (tool === 'eraser') store.eraseCircle(t.x, t.y, brushDiameter());
  else store.paintCircle(t.x, t.y, tool, brushDiameter());
  painting = true;
  lastPaintPos = t;
  renderBaseMap(seedInput.value || 'preview');
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
  const resLine = tile.resType ? `\n${t('tile.resource')}: ${t(`resource.${tile.resType}`)}` : '';
  const typeLabel = tile.obstacleKind ? `${tile.type} (${tile.obstacleKind})` : tile.type;
  tileInfoEl.textContent = `(${pos.x}, ${pos.y})\n${t('tile.type')}: ${typeLabel}\n${t('tile.level')}: ${tile.level}${resLine}`;
  tileInfoShown = true;

  if (draggingCityId) {
    const node = cityStore.get(draggingCityId);
    if (node) {
      const clamped = clampCityPos(node, pos);
      node.x = clamped.x;
      node.y = clamped.y;
      cityInfoEl.textContent = cityLabel(node);
    }
    scheduleRender({ base: false, hover: pos });
    return;
  }

  if (painting && lastPaintPos) {
    const kind = tool === 'eraser' ? null : (tool as TerrainKind);
    store.strokeCircle(lastPaintPos, pos, kind, brushDiameter());
    lastPaintPos = pos;
    scheduleRender({ base: true, hover: pos });
    return;
  }

  // Keep the brush-size cursor tracking the hover tile even when not actively painting.
  scheduleRender({ base: false, hover: pos });
});

window.addEventListener('mouseup', () => {
  if (panning) {
    panning = false;
    panLast = null;
    canvasEl().style.cursor = tool === 'pan' ? 'grab' : tool === 'city' ? 'default' : 'crosshair';
    renderBaseMap(seedInput.value || 'preview');
    redrawAll();
    return;
  }
  if (draggingCityId) {
    draggingCityId = null;
    setStatus(() => t('status.cityMoved', { id: selectedCityId ?? '' }));
    renderBaseMap(seedInput.value || 'preview');
    refreshCitySprites();
    redrawAll();
  }
  if (painting) {
    painting = false;
    lastPaintPos = null;
    renderBaseMap(seedInput.value || 'preview');
  }
});

canvasEl().addEventListener('contextmenu', (ev) => ev.preventDefault());

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
  renderTerrainTitle();
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
canvasEl().style.cursor = 'grab'; // matches the default 'pan' tool
centerView();
Promise.allSettled([loadTerrainAtlas(), loadResAtlas(), loadBuildingAtlas(), loadCityAtlas()]).then(() => {
  renderBaseMap(seedInput.value);
  loadCitiesAndRedraw(seedInput.value);
  redrawAll();
});
renderTerrainTitle();

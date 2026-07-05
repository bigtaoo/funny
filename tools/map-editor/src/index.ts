// Map Editor entry point — MVP scaffold (DESIGN.md §6): renders the full procedural map for a given
// world seed on a single Canvas so the terrain skeleton (ADR-034) can be eyeballed. Editing interactions
// (river/mountain brush, city drag) are not implemented yet — this step is scaffold + read-only render.
import { proceduralTile, SLG_MAP_H, SLG_MAP_W, type ResourceType, type TileType } from '@nw/shared/slg';

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

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const TILE_COLOR_RGB: Record<TileType, [number, number, number]> = Object.fromEntries(
  (Object.keys(TILE_COLORS) as TileType[]).map((k) => [k, hexToRgb(TILE_COLORS[k])]),
) as Record<TileType, [number, number, number]>;

const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const seedInput = document.getElementById('world-seed') as HTMLInputElement;
const regenBtn = document.getElementById('btn-regen') as HTMLButtonElement;
const zoomInput = document.getElementById('zoom') as HTMLInputElement;
const statusEl = document.getElementById('status')!;
const tileInfoEl = document.getElementById('tile-info')!;
const legendEl = document.getElementById('legend')!;

canvas.width = SLG_MAP_W;
canvas.height = SLG_MAP_H;

function renderLegend(): void {
  legendEl.innerHTML = (Object.keys(TILE_COLORS) as TileType[])
    .map((t) => `<div class="row"><i style="background:${TILE_COLORS[t]}"></i>${t}</div>`)
    .join('');
}

function renderMap(worldId: string): void {
  const t0 = performance.now();
  const img = ctx.createImageData(SLG_MAP_W, SLG_MAP_H);
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
  ctx.putImageData(img, 0, 0);
  const ms = (performance.now() - t0).toFixed(0);
  statusEl.textContent = `world="${worldId}" — ${SLG_MAP_W}×${SLG_MAP_H} rendered in ${ms}ms`;
}

function applyZoom(): void {
  const z = Number(zoomInput.value);
  canvas.style.width = `${SLG_MAP_W * z}px`;
  canvas.style.height = `${SLG_MAP_H * z}px`;
}

canvas.addEventListener('mousemove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = SLG_MAP_W / rect.width;
  const scaleY = SLG_MAP_H / rect.height;
  const x = Math.floor((ev.clientX - rect.left) * scaleX);
  const y = Math.floor((ev.clientY - rect.top) * scaleY);
  if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) return;
  const tile = proceduralTile(seedInput.value || 'preview', x, y);
  const resLine = tile.resType ? `\nresource: ${RESOURCE_LABELS[tile.resType]}` : '';
  tileInfoEl.textContent = `(${x}, ${y})\ntype: ${tile.type}\nlevel: ${tile.level}${resLine}`;
});

regenBtn.addEventListener('click', () => renderMap(seedInput.value || 'preview'));
zoomInput.addEventListener('input', applyZoom);

renderLegend();
applyZoom();
renderMap(seedInput.value);

// Pure PIXI drawing for one terrain tile — trimmed from the game client's
// client/src/scenes/worldmap/tileGraphics.ts down to what a map TEMPLATE ever shows: ground
// texture + resource motif + familyKeep/stronghold landmark sprite. Dropped entirely (only
// meaningful for a live, player-owned world, never for proceduralTile()/rasterizeMapEdits()
// template output): ownership wash, fog-of-war, base-tile city sprite, HP bars, watchtower,
// ally-sect border, level dot.
import * as PIXI from 'pixi.js-legacy';
import { ISO_RATIO, diamondPath } from './isoGrid';
import { getResLevelTexture, getResTexture, isResAtlasReady } from './resAtlasLoader';
import { getTerrainTexture, isTerrainAtlasReady } from './terrainAtlasLoader';
import { getBuildingTexture, isBuildingAtlasReady } from './buildingAtlasLoader';
import { terrainFill, TERRAIN_TEX_ALPHA, TERRAIN_TEX_ALPHA_DEFAULT, TERRAIN_TEX_TINT, TERRAIN_TEX_TINT_DEFAULT, biomeGroundTint, obstacleTextureName } from './tileStyle';
import type { TerrainTextureName } from './terrainAtlasLoader';
import { worldSeed, obstacleShoreAt, type ProceduralTile } from '@nw/shared/slg';

/** Ground + motif + landmark for one tile. `g`'s local origin is the tile's diamond center. */
export function drawEditorTile(g: PIXI.Graphics, tile: ProceduralTile, texName: TerrainTextureName, tp: number, tx = 0, ty = 0, worldId = ''): void {
  const hh = (tp * ISO_RATIO) / 2;

  g.lineStyle(0.7, 0xccbbaa, 0.08); // 0.18→0.08 (2026-07-11 legibility pass). Mirrors the game client (parity).
  const tex = isTerrainAtlasReady() ? getTerrainTexture(texName) : null;
  if (tex) {
    const w = tp - 1;
    const h = w * ISO_RATIO;
    const m = new PIXI.Matrix(w / tex.width, 0, 0, h / tex.height, -w / 2, -h / 2);
    const texAlpha = TERRAIN_TEX_ALPHA[texName] ?? TERRAIN_TEX_ALPHA_DEFAULT;
    // Resource tiles wash the ground toward their PURE biome hue, blended across zone boundaries
    // (ignoring the level-gated copper/sticker override, which is a scattered per-tile special, not
    // a zone) so same-biome zones read as one continuous gradiented region even where scattered
    // copper tiles poke through as icons — mirrors the game client's drawTileL1 (SLG map render
    // parity, 2026-07-11 continuity pass + 10-tile blend follow-up).
    const groundTint = tile.type === 'resource' && tile.resType ? biomeGroundTint(tx, ty, worldSeed(worldId)) : undefined;
    const texTint = groundTint ?? TERRAIN_TEX_TINT[texName] ?? TERRAIN_TEX_TINT_DEFAULT;
    g.beginTextureFill({ texture: tex, matrix: m, alpha: texAlpha, color: texTint });
  } else {
    g.beginFill(terrainFill(tile.type, tile.resType), 0.7);
  }
  g.drawPolygon(diamondPath(tp - 1));
  g.endFill();

  // Obstacle-edge "shore" wash (2026-07-12) — mirrors the game client's drawTileL1 (SLG map
  // render parity). See obstacleShoreAt for why: the band shapes rasterize as a hard per-tile
  // boolean, so a faded second texture pass on bordering tiles softens the cut into a ~1-tile
  // "bank" fringe instead of an abrupt art swap.
  if (tex && tile.type !== 'obstacle' && tile.type !== 'bridge' && tile.type !== 'plankway') {
    const shore = obstacleShoreAt(worldId, tx, ty);
    if (shore) {
      const shoreTexName = obstacleTextureName(shore.kind);
      const shoreTex = isTerrainAtlasReady() ? getTerrainTexture(shoreTexName) : null;
      if (shoreTex) {
        const w = tp - 1;
        const h = w * ISO_RATIO;
        const m = new PIXI.Matrix(w / shoreTex.width, 0, 0, h / shoreTex.height, -w / 2, -h / 2);
        g.beginTextureFill({ texture: shoreTex, matrix: m, alpha: shore.alpha, color: TERRAIN_TEX_TINT[shoreTexName] ?? TERRAIN_TEX_TINT_DEFAULT });
        g.drawPolygon(diamondPath(tp - 1));
        g.endFill();
      }
    }
  }

  // Resource motif overlay: with resourceDensity=1.0 (ADR-032) every open tile is a resource
  // tile, so this paints a per-level heap on every one of them — dense by design, so the freshly
  // baked l1–l10 graded art (taller/denser = higher level) actually reads on the map. Must stay in
  // lockstep with the game client's drawTileL1 (SLG map render parity).
  if (tile.type === 'resource' && tile.resType) {
    drawResMotif(g, tile.resType, tile.level, tp, tx, ty);
  }

  const featBuilding = tile.type === 'familyKeep' ? 'building_keep'
    : tile.type === 'stronghold' ? 'building_stronghold'
    : tile.type === 'bridge' ? 'building_bridge'
    : tile.type === 'plankway' ? 'building_plankway'
    : null;
  if (featBuilding) {
    placeBuildingSprite(g, featBuilding, hh, tp * 1.3);
  }
}

/** Landmark building sprite, anchored bottom-center on the tile's lower diamond vertex. */
export function placeBuildingSprite(g: PIXI.Graphics, name: string, hh: number, targetH: number): boolean {
  if (!isBuildingAtlasReady()) return false;
  const tex = getBuildingTexture(name);
  if (!tex) return false;
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 1);
  sp.scale.set(targetH / tex.height);
  sp.x = 0;
  sp.y = hh * 0.72;
  g.addChild(sp);
  return true;
}

/**
 * Single resource-motif sprite (real per-level art when available, else one generic placeholder) —
 * mirrors the game client's simplified drawResMotif (commit 2a85a917: the per-level art already
 * encodes abundance/defense, so the old count-copy + lv4+/lv7+ defense frames are gone — they just
 * flooded the paper with confetti). No fog path: templates are always fully revealed.
 */
export function drawResMotif(g: PIXI.Graphics, resType: string, level: number, tp: number, tx = 0, ty = 0): void {
  const lv = Math.max(1, Math.min(10, level));
  const toLocal = (fx: number, fy: number): [number, number] => [(fx - 0.5) * tp, (fy - 0.5) * tp * 0.6];
  const jitter = motifJitter(tx, ty);

  if (!isResAtlasReady()) { drawResMotifFallback(g, resType, tp); return; }

  const levelTex = getResLevelTexture(resType, lv);
  const tex = levelTex ?? getResTexture(resType);
  if (!tex) return;
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 0.5);
  // Per-level frames all share the same 128px WIDTH and encode the level in HEIGHT (higher
  // level = taller/denser), so scale them by width — this keeps the per-level height
  // difference instead of normalizing it away via max(w,h). The generic fallback frame
  // (types without per-level art) is TALLER than wide, so it stays on max(w,h) to stay
  // bounded. 0.40: shrunk 0.55→0.48→0.40 for clear gaps between adjacent tiles' motifs
  // (resourceDensity=1.0 puts one on every tile); mirrors the game client (parity).
  const denom = levelTex ? tex.width : Math.max(tex.width, tex.height);
  // Per-tile jitter (2026-07-12, resource-carpet pass) — mirrors the game client's
  // drawResMotif/motifJitter (SLG map render parity): breaks the perfectly uniform grid look of
  // identical same-biome frames repeating at real play zoom, without touching density/alpha tuning.
  sp.scale.set((tp * 0.40) / denom * jitter.scale);
  sp.rotation = jitter.rot;
  // Value hierarchy by opacity: resourceDensity=1.0 puts a heap on EVERY tile, so full-strength
  // everywhere reads as uniform confetti. Fade low-level heaps and keep high-level ones solid so
  // the eye picks out valuable tiles — lv1≈0.65 → lv10=1.0. Floor raised 0.4→0.65 (2026-07-11
  // legibility pass). Mirrors the game client (parity).
  sp.alpha = 0.65 + 0.35 * ((lv - 1) / 9);
  [sp.x, sp.y] = toLocal(0.5, 0.52);
  sp.x += jitter.dx * tp; sp.y += jitter.dy * tp;
  g.addChild(sp);
}

/** Deterministic per-tile placement jitter — mirrors the game client's motifJitter (SLG map
 * render parity). See the game client's tileGraphics.ts for the full rationale. */
export function motifJitter(tx: number, ty: number): { dx: number; dy: number; rot: number; scale: number } {
  const h1raw = Math.sin(tx * 12.9898 + ty * 78.233) * 43758.5453;
  const h2raw = Math.sin(tx * 39.346 + ty * 11.135) * 24634.6345;
  const h1 = h1raw - Math.floor(h1raw);
  const h2 = h2raw - Math.floor(h2raw);
  return { dx: (h1 - 0.5) * 0.26, dy: (h2 - 0.5) * 0.18, rot: (h1 - 0.5) * 0.7, scale: 0.85 + h2 * 0.3 };
}

/** Single programmatic fallback icon when res_atlas hasn't decoded yet — mirrors the game client. */
export function drawResMotifFallback(g: PIXI.Graphics, resType: string, tp: number): void {
  const alpha = 0.6;
  const r = tp * 0.12;
  {
    const cx = 0, cy = 0.02 * tp * 0.6;
    g.lineStyle(0);
    if (resType === 'ink') {
      g.beginFill(0x3355aa, alpha);
      g.drawEllipse(cx, cy + r * 0.2, r * 0.65, r * 0.85);
      g.endFill();
      g.beginFill(0x3355aa, alpha);
      g.moveTo(cx, cy - r * 0.9);
      g.lineTo(cx - r * 0.45, cy - r * 0.05);
      g.lineTo(cx + r * 0.45, cy - r * 0.05);
      g.closePath();
      g.endFill();
    } else if (resType === 'paper') {
      g.lineStyle(0.8, 0x4477bb, alpha);
      g.beginFill(0xf0ecdd, alpha * 0.9);
      g.drawRect(cx - r * 0.7, cy - r * 0.85, r * 1.4, r * 1.7);
      g.endFill();
      g.lineStyle(0.6, 0x4477bb, alpha * 0.7);
      g.moveTo(cx - r * 0.3, cy - r * 0.85);
      g.lineTo(cx - r * 0.3, cy - r * 0.35);
      g.moveTo(cx - r * 0.3, cy - r * 0.15);
      g.lineTo(cx - r * 0.3, cy + r * 0.55);
      g.lineStyle(0);
    } else if (resType === 'graphite') {
      g.beginFill(0x778899, alpha);
      g.moveTo(cx, cy - r);
      g.lineTo(cx + r * 0.5, cy - r * 0.5);
      g.lineTo(cx + r * 0.5, cy + r * 0.6);
      g.lineTo(cx, cy + r);
      g.lineTo(cx - r * 0.5, cy + r * 0.6);
      g.lineTo(cx - r * 0.5, cy - r * 0.5);
      g.closePath();
      g.endFill();
      g.beginFill(0xccaa44, alpha);
      g.moveTo(cx - r * 0.5, cy + r * 0.6);
      g.lineTo(cx + r * 0.5, cy + r * 0.6);
      g.lineTo(cx, cy + r);
      g.closePath();
      g.endFill();
    } else if (resType === 'metal') {
      g.beginFill(0x889966, alpha);
      g.drawCircle(cx, cy - r * 0.3, r * 0.6);
      g.endFill();
      g.beginFill(0x778855, alpha);
      g.drawRect(cx - r * 0.22, cy + r * 0.2, r * 0.44, r * 0.8);
      g.endFill();
    } else {
      g.beginFill(0xcc9922, alpha);
      const pts = 5;
      const outer = r * 0.9, inner = r * 0.4;
      const startAngle = -Math.PI / 2;
      for (let i = 0; i < pts * 2; i++) {
        const angle = startAngle + (i * Math.PI) / pts;
        const rad = i % 2 === 0 ? outer : inner;
        if (i === 0) g.moveTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
        else g.lineTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
      }
      g.closePath();
      g.endFill();
    }
  }
}

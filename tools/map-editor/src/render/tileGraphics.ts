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
import { terrainFill, TERRAIN_TEX_ALPHA, TERRAIN_TEX_ALPHA_DEFAULT, TERRAIN_TEX_TINT, TERRAIN_TEX_TINT_DEFAULT } from './tileStyle';
import type { TerrainTextureName } from './terrainAtlasLoader';
import type { ProceduralTile } from '@nw/shared/slg';

/** Ground + motif + landmark for one tile. `g`'s local origin is the tile's diamond center. */
export function drawEditorTile(g: PIXI.Graphics, tile: ProceduralTile, texName: TerrainTextureName, tp: number): void {
  const hh = (tp * ISO_RATIO) / 2;

  g.lineStyle(0.7, 0xccbbaa, 0.18);
  const tex = isTerrainAtlasReady() ? getTerrainTexture(texName) : null;
  if (tex) {
    const w = tp - 1;
    const h = w * ISO_RATIO;
    const m = new PIXI.Matrix(w / tex.width, 0, 0, h / tex.height, -w / 2, -h / 2);
    const texAlpha = TERRAIN_TEX_ALPHA[texName] ?? TERRAIN_TEX_ALPHA_DEFAULT;
    const texTint = TERRAIN_TEX_TINT[texName] ?? TERRAIN_TEX_TINT_DEFAULT;
    g.beginTextureFill({ texture: tex, matrix: m, alpha: texAlpha, color: texTint });
  } else {
    g.beginFill(terrainFill(tile.type, tile.resType), 0.7);
  }
  g.drawPolygon(diamondPath(tp - 1));
  g.endFill();

  if ((tile.type === 'resource' || tile.type === 'familyKeep' || tile.type === 'stronghold') && tile.resType) {
    drawResMotif(g, tile.resType, tile.level, tp);
  }

  if (tile.type === 'familyKeep' || tile.type === 'stronghold') {
    placeBuildingSprite(g, tile.type === 'familyKeep' ? 'building_keep' : 'building_stronghold', hh, tp * 1.3);
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
export function drawResMotif(g: PIXI.Graphics, resType: string, level: number, tp: number): void {
  const lv = Math.max(1, Math.min(10, level));
  const toLocal = (fx: number, fy: number): [number, number] => [(fx - 0.5) * tp, (fy - 0.5) * tp * 0.6];

  if (!isResAtlasReady()) { drawResMotifFallback(g, resType, tp); return; }

  const tex = getResLevelTexture(resType, lv) ?? getResTexture(resType);
  if (!tex) return;
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 0.5);
  sp.scale.set((tp * 0.34) / Math.max(tex.width, tex.height));
  [sp.x, sp.y] = toLocal(0.5, 0.52);
  g.addChild(sp);
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

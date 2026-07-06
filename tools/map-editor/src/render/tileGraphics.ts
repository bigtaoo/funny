// Pure PIXI drawing for one terrain tile — trimmed from the game client's
// client/src/scenes/worldmap/tileGraphics.ts down to what a map TEMPLATE ever shows: ground
// texture + resource motif + familyKeep/stronghold landmark sprite. Dropped entirely (only
// meaningful for a live, player-owned world, never for proceduralTile()/rasterizeMapEdits()
// template output): ownership wash, fog-of-war, base-tile city sprite, HP bars, watchtower,
// ally-sect border, level dot.
import * as PIXI from 'pixi.js-legacy';
import { ISO_RATIO, diamondPath, diamondVertices } from './isoGrid';
import { getResLevelTexture, getResTexture, isResAtlasReady } from './resAtlasLoader';
import { getTerrainTexture, isTerrainAtlasReady } from './terrainAtlasLoader';
import { getBuildingTexture, isBuildingAtlasReady } from './buildingAtlasLoader';
import { terrainFill } from './tileStyle';
import type { TerrainTextureName } from './terrainAtlasLoader';
import type { ProceduralTile } from '@nw/shared/slg';

/** Ground + motif + landmark for one tile. `g`'s local origin is the tile's diamond center. */
export function drawEditorTile(g: PIXI.Graphics, tile: ProceduralTile, texName: TerrainTextureName, tp: number): void {
  const hh = (tp * ISO_RATIO) / 2;

  g.lineStyle(0.7, 0xccbbaa, 0.32);
  const tex = isTerrainAtlasReady() ? getTerrainTexture(texName) : null;
  if (tex) {
    const w = tp - 1;
    const h = w * ISO_RATIO;
    const m = new PIXI.Matrix(w / tex.width, 0, 0, h / tex.height, -w / 2, -h / 2);
    g.beginTextureFill({ texture: tex, matrix: m, alpha: 0.9 });
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

/** Resource-motif sprites (real per-level art when available, else count/alpha sim) + hand-drawn defense frames (lv4+/lv7+), identical to the game client. */
export function drawResMotif(g: PIXI.Graphics, resType: string, level: number, tp: number): void {
  const lv = Math.max(1, Math.min(10, level));
  const toLocal = (fx: number, fy: number): [number, number] => [(fx - 0.5) * tp, (fy - 0.5) * tp * 0.6];
  const v = diamondVertices(tp - 1);
  const edgeMid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  if (lv >= 4) {
    const heavy = lv >= 7;
    g.lineStyle(heavy ? 1.5 : 0.9, 0x3a2a18, heavy ? 0.7 : 0.45);
    g.beginFill(0, 0);
    g.drawPolygon(diamondPath(tp - 1, { inset: Math.min(0.35, 6 / tp) }));
    g.endFill();
    if (heavy) {
      const tk = 4;
      g.lineStyle(1.2, 0x3a2a18, 0.65);
      const edges: [[number, number], [number, number]][] = [
        [v.top, v.right], [v.right, v.bottom], [v.bottom, v.left], [v.left, v.top],
      ];
      for (const [a, b] of edges) {
        const mid = edgeMid(a, b);
        const len = Math.hypot(mid[0], mid[1]) || 1;
        g.moveTo(mid[0], mid[1]);
        g.lineTo(mid[0] + (mid[0] / len) * tk, mid[1] + (mid[1] / len) * tk);
      }
    }
  }

  if (!isResAtlasReady()) { drawResMotifFallback(g, resType, lv, tp); return; }

  const levelTex = getResLevelTexture(resType, lv);
  if (levelTex) {
    const sp = new PIXI.Sprite(levelTex);
    sp.anchor.set(0.5, 0.5);
    sp.scale.set((tp * 0.34) / Math.max(levelTex.width, levelTex.height));
    [sp.x, sp.y] = toLocal(0.5, 0.52);
    g.addChild(sp);
    return;
  }

  const tex = getResTexture(resType);
  if (!tex) return;

  const count = lv <= 3 ? 1 : lv <= 6 ? 2 : lv <= 9 ? 3 : 4;
  const POSITIONS: [number, number][] = [
    [0.5, 0.52],
    [0.32, 0.38], [0.65, 0.6],
    [0.32, 0.35], [0.65, 0.35], [0.48, 0.65],
    [0.28, 0.33], [0.62, 0.33], [0.28, 0.65], [0.65, 0.65],
  ];
  const offsets = POSITIONS.slice(
    count === 1 ? 0 : count === 2 ? 1 : count === 3 ? 3 : 6,
    count === 1 ? 1 : count === 2 ? 3 : count === 3 ? 6 : 10,
  );
  const targetPx = tp * (count <= 1 ? 0.34 : count === 2 ? 0.29 : 0.26);
  const scale = targetPx / Math.max(tex.width, tex.height);
  const alpha = lv <= 3 ? 0.6 : lv <= 6 ? 0.72 : lv <= 9 ? 0.82 : 0.92;

  for (const [fx, fy] of offsets) {
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5, 0.5);
    sp.scale.set(scale);
    sp.alpha = alpha;
    [sp.x, sp.y] = toLocal(fx, fy);
    g.addChild(sp);
  }
}

/** Programmatic fallback icon when res_atlas hasn't decoded yet — identical to the game client. */
export function drawResMotifFallback(g: PIXI.Graphics, resType: string, lv: number, tp: number): void {
  const count = lv <= 3 ? 1 : lv <= 6 ? 2 : lv <= 9 ? 3 : 4;
  const alpha = lv <= 3 ? 0.55 : lv <= 6 ? 0.68 : lv <= 9 ? 0.80 : 0.90;
  const POSITIONS: [number, number][] = [
    [0.50, 0.52],
    [0.32, 0.38], [0.65, 0.60],
    [0.32, 0.35], [0.65, 0.35], [0.48, 0.65],
    [0.28, 0.33], [0.62, 0.33], [0.28, 0.65], [0.65, 0.65],
  ];
  const offsets = POSITIONS.slice(
    count === 1 ? 0 : count === 2 ? 1 : count === 3 ? 3 : 6,
    count === 1 ? 1 : count === 2 ? 3 : count === 3 ? 6 : 10,
  );
  const r = tp * (count <= 1 ? 0.12 : 0.10);
  for (const [fx, fy] of offsets) {
    const cx = (fx - 0.5) * tp, cy = (fy - 0.5) * tp * 0.6;
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

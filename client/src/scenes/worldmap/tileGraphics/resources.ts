// tileGraphics/resources — resource motif rendering (per-level art + programmatic fallback).
// Pure PIXI Graphics functions; hold no scene state.
//
// This file is a thin PIXI adapter: every number it draws with comes from @nw/shared's
// resMotifPlacement (size/alpha/rotation/offset) and from the atlas's own baked `nw` block (the level
// read). It deliberately contains NO level->size and NO level->alpha logic — see
// design/product/slg-resource-art.md §6.3 for why that solving moved into the packer, and
// server/shared/src/slg/core.ts for why the math is shared with the map editor rather than copied
// into it (both had a hand-written copy until 2026-08-19, kept in step only by a comment).
import * as PIXI from 'pixi.js-legacy';
import { resLevelLabelText, resMotifPlacement } from '@nw/shared';
import { getResFrameRead, getResLevelTexture, getResTexture, isResAtlasReady } from '../../../render/atlas/resAtlasLoader';

/**
 * Render a resource motif sprite onto a tile Graphics.
 *
 * When a hand-drawn `res_{resType}_l{level}` frame exists, draw that real per-level art: the artwork
 * plus its baked level read carry level/abundance entirely — no programmatic count-replication and no
 * pencil defense frames are layered on. All map resTypes have per-level frames (paper/ink/graphite/metal
 * l1–l10, sticker l6–l10 — sticker only spawns at level ≥6, so it never needs l1–5). Any missing level
 * falls back to the generic `res_{resType}` sprite — deliberately one sprite, no abundance scatter, so
 * the map stays calm.
 *
 * Falls back to a single programmatic shape if the atlas hasn't decoded yet.
 *
 * `g`'s local origin is the tile diamond's centre (see drawTileL1), which is the origin
 * resMotifPlacement returns offsets against.
 */
export function drawResMotif(g: PIXI.Graphics, resType: string, level: number, tp: number, fogged = false, tx = 0, ty = 0): void {
  // Programmatic fallback while the atlas is still decoding.
  if (!isResAtlasReady()) { drawResMotifFallback(g, resType, tp); return; }

  // Outside vision: reveal the resource TYPE only — the generic frame, dimmed, with no level detail
  // (§18 keeps level hidden under fog, same as the level dot).
  const lv = Math.max(1, Math.min(10, level));
  const levelTex = fogged ? null : getResLevelTexture(resType, lv);
  const frameName = levelTex ? `res_${resType}_l${lv}` : `res_${resType}`;
  const tex = levelTex ?? getResTexture(resType);
  if (!tex) return;

  const p = resMotifPlacement({
    tp, tx, ty,
    read: getResFrameRead(frameName),
    texW: tex.width, texH: tex.height,
    fogged,
  });
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5, 0.5);
  sp.scale.set(p.scale);
  sp.rotation = p.rotation;
  sp.alpha = p.alpha;
  sp.x = p.x;
  sp.y = p.y;
  g.addChild(sp);
}

// ── Lv.N label (slg-resource-art.md §6.2 #7) ──────────────────────────────────────────────────────
// Which tiles get one and what it says is resLevelLabelText's call (@nw/shared); everything below is
// how it gets on screen without leaking textures.
//
// A BitmapFont, NOT `new PIXI.Text` per tile. `SLG_GEN.resourceDensity` is 1.0, so every tile on
// screen is a resource tile and a naive implementation would allocate hundreds of Text objects —
// each with its OWN canvas-backed texture — and re-allocate them on every pan. That runs straight
// into the known Text-texture teardown leak (claudedocs/client-memory-leak.md). BitmapText instead
// draws from ONE shared font page, and the instances are pooled per tile slot (see below), so a
// full screen of labels costs one texture and no per-pan allocation.
const LABEL_FONT = 'nw-res-lv';
const LABEL_NAME = 'resLv';
/** Baked glyph size. Rendered small (~tp*0.13) and only ever scaled DOWN, so it never softens. */
const LABEL_FONT_SIZE = 48;
let labelFont: 'ready' | 'unavailable' | null = null;

/** Build the shared font page once. Returns false where there is no canvas to rasterise it (tests). */
function ensureLabelFont(): boolean {
  if (labelFont === null) {
    try {
      PIXI.BitmapFont.from(LABEL_FONT, {
        fontFamily: 'monospace', fontSize: LABEL_FONT_SIZE, fontWeight: 'bold',
        fill: 0x33302b, stroke: 0xfff8f0, strokeThickness: 5,
      }, { chars: 'Lv.0123456789' });
      labelFont = 'ready';
    } catch {
      labelFont = 'unavailable';
    }
  }
  return labelFont === 'ready';
}

/**
 * Draw (or hide) the `Lv.N` label on a tile. Pass level 0 to hide — callers do that for tiles whose
 * motif is suppressed, and pool.ts hides every non-Sprite child before a redraw so a slot reused for
 * a labelless tile, or for a zoom level that draws no motifs at all, cannot keep a stale one.
 *
 * The BitmapText is a NAMED, REUSED child of the tile Graphics rather than a fresh object per draw:
 * pool slots are recycled constantly while panning, and reusing one instance per slot keeps the
 * steady state at zero allocations and zero destroys.
 */
export function drawResLevelLabel(g: PIXI.Graphics, level: number, tp: number): void {
  const existing = g.getChildByName(LABEL_NAME) as PIXI.BitmapText | null;
  const text = resLevelLabelText(level, tp);
  if (!text || !ensureLabelFont()) {
    if (existing) existing.visible = false;
    return;
  }
  let label = existing;
  if (!label) {
    label = new PIXI.BitmapText('', { fontName: LABEL_FONT });
    label.name = LABEL_NAME;
    label.anchor.set(0.5, 0.5);
    g.addChild(label);
  }
  label.visible = true;
  if (label.text !== text) label.text = text;
  label.fontSize = Math.max(9, Math.round(tp * 0.13));
  // Below the motif, inside the diamond: half-height is tp*ISO_RATIO/2 = tp*0.25, and the motif is
  // centred near the middle, so tp*0.15 sits under the art without crossing the lower edge.
  label.x = 0;
  label.y = tp * 0.15;
}

/** Single programmatic fallback icon when res_atlas is not yet loaded. Draws one small stationery-themed shape. */

export function drawResMotifFallback(g: PIXI.Graphics, resType: string, tp: number): void {
  const alpha = 0.6;
  const r = tp * 0.12;
  // Center-relative, y flattened to match drawResMotif's diamond-safe placement (`g`'s
  // local origin is the tile's diamond center, not the old square's top-left corner).
  {
    const cx = 0, cy = 0.02 * tp * 0.6;
    g.lineStyle(0);
    if (resType === 'ink') {
      // Ink drop: teardrop shape
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
      // Paper: small rectangle with folded corner
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
      // Graphite/pencil: elongated hexagon
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
      // Metal: bolt head (circle) + shaft
      g.beginFill(0x889966, alpha);
      g.drawCircle(cx, cy - r * 0.3, r * 0.6);
      g.endFill();
      g.beginFill(0x778855, alpha);
      g.drawRect(cx - r * 0.22, cy + r * 0.2, r * 0.44, r * 0.8);
      g.endFill();
    } else {
      // sticker / default: 5-point star
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

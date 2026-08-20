// SLG tile-render helpers: which building-atlas frame a tile type stamps + whether a tile is city
// ground, and resource-motif sprite placement/level-label sizing — single source of truth for client +
// map-editor. Split out of core.ts (god-file split, [[project_godfile_split_pattern]]) on 2026-08-20 once
// the 2026-08-19 additions below pushed core.ts past the 500-line convention: both sections are pure,
// self-contained render-geometry functions with no dependency on core.ts's IDs/enums/economic constants,
// so they were the natural independent-module seam (see claudedocs/server.md's split-priority order).
import type { TileType } from './core';

// ── Per-tile feature art: which building a tile type stamps, and which types are city ground ──
// Single source of truth for client + map-editor, for the same reason the sprite geometry in core.ts is:
// design/tools/map-editor/DESIGN.md §6.3 makes SLG map render parity a hard requirement, and this
// mapping is exactly what drifted on 2026-08-19 — `familyKeep` kept stamping a gatehouse per tile long
// after it stopped meaning anything but "city ground". Two hand-copied ternaries in two packages cannot
// be tested for agreement; these two functions can (server/shared/test/core.test.ts).

/** Building-atlas frame names a TILE TYPE can stamp (see client render/atlas/buildingAtlasLoader.ts). */
export type TileFeatureBuilding = 'building_stronghold' | 'building_bridge' | 'building_plankway';

/**
 * True for the tile types that are a CITY's ground: `familyKeep` (province capital / graded city) and
 * `center` (world center). Such a tile draws no per-tile feature art of its own — the city's art is one
 * footprint-sized sprite on the city layer (client WorldMapRenderer/city.ts, editor render/citySprites.ts),
 * masked to the plot — and it suppresses the resource-motif heap, which city ground would otherwise show
 * (it keeps a biome `resType`; see mapgen/tileGen.ts + mapEdit.ts).
 *
 * Why this is a named predicate rather than an inline `=== 'familyKeep'`: before 2026-08-19 `familyKeep`
 * stamped `building_keep` per tile, which was invisible on a procedural city (only the single anchor tile
 * is classified) but drew a wall of overlapping gatehouses across a PUBLISHED city's whole N×N footprint.
 * `center` never had the stamp; the two now behave identically by construction.
 */
export function isCityGroundTile(type: TileType | undefined): boolean {
  return type === 'familyKeep' || type === 'center';
}

/**
 * The building-atlas frame a tile of this type stamps on itself, or null for none. Only the three
 * one-per-region landmarks qualify: an NPC stronghold and the two capturable crossings. City ground
 * returns null on purpose (see {@link isCityGroundTile}); so does every ordinary resource/neutral/
 * obstacle/territory/base tile. Player-built structures (`tile.watchtower` / `tile.structure`) are a
 * separate, live-state layer and are NOT covered here — this function is about tile TYPE alone, which is
 * why the map editor (which knows nothing of live player state) can share it.
 */
export function tileFeatureBuilding(type: TileType | undefined): TileFeatureBuilding | null {
  switch (type) {
    case 'stronghold': return 'building_stronghold';
    case 'bridge':     return 'building_bridge';
    case 'plankway':   return 'building_plankway';
    default:           return null;
  }
}

// ── Resource-motif placement — single source of truth for client + map-editor ──────────────────
// Same reason as the city-sprite geometry in core.ts: design/tools/map-editor/DESIGN.md §6.3 makes SLG
// map render parity a hard requirement, and until 2026-08-19 this was two hand-copied bodies (client
// scenes/worldmap/tileGraphics/resources.ts vs tools/map-editor/src/render/tileGraphics.ts) held
// together by a "must stay in lockstep" comment — the exact arrangement that let the familyKeep stamp
// drift. Neither package can test a copy against the other; these functions can
// (server/shared/test/core.test.ts), and each renderer keeps only a thin PIXI adapter.

/**
 * The level read the resource packer bakes into every `res_*` frame of the atlas JSON, under the
 * frame entry's `nw` key (art/slg/slg-map/pack_resources.cjs; design/product/slg-resource-art.md §6.3).
 *
 * It lives in the atlas rather than in renderer code because solving it needs a measurement only the
 * packer has — how much ink a drawing actually contains. The retired contract ("render width-normalised,
 * so taller art reads as a higher tier") punished the sideways growth high tiers use to show abundance:
 * the more the artist drew, the smaller it landed. Now the packer normalises on equivalent edge
 * sqrt(w*h), puts footprint on an explicit 0.80→1.30 curve, and fails the build when a tier is drawn
 * sparser than one below it. Consequence for renderers: they carry NO level→size/alpha logic at all.
 */
export interface ResMotifFrameRead {
  /** Multiply into the on-screen scale; already folded the frame's own size in, so no /width or /max(w,h). */
  sizeMul: number;
  /** Final sprite alpha. Stays within [0.85, 1] — a trim for art mismatches, never a level channel. */
  alphaMul: number;
}

/** Resolved sprite transform for one resource motif on one tile. Pure numbers; no PIXI types. */
export interface ResMotifPlacement {
  scale: number;
  alpha: number;
  rotation: number;
  /** Offset from the tile diamond's centre, in screen px. */
  x: number;
  y: number;
}

/**
 * Resource motif size as a fraction of tile pitch `tp`, before the frame's own `sizeMul`. Shrunk
 * 0.55→0.48→0.40→0.30 (2026-07-17): with `SLG_GEN.resourceDensity` at 1.0 a motif sits on EVERY tile, so
 * 0.40 filled each tile edge to edge and the map read as one uniform carpet with no visual hierarchy.
 * 0.30 opens real gaps between neighbours so ownership, terrain and the high-value tiles can lead the eye.
 */
export const RES_MOTIF_SIZE_FRAC = 0.30;

/** Alpha for a motif drawn outside vision: type only, no level detail (§18 keeps level fogged). */
export const RES_MOTIF_FOG_ALPHA = 0.35;

/**
 * Deterministic per-tile placement jitter — same 2D-hash-of-coordinates trick as drawStar's per-vertex
 * wobble, so identical (tx,ty) always jitters identically (no shimmer on redraw/pan) with no stored seed.
 *
 * Why any jitter: `resourceDensity` 1.0 puts the SAME frame on every tile of a biome region, so at real
 * play zoom identical icons tile in a perfectly uniform grid and read as a printed stamp pattern rather
 * than hand placement (confirmed on a real-client screenshot of a plain resource patch, 2026-07-12).
 *
 * Why `scale` is nearly flat: it used to be [0.85, 1.15], which made neighbouring tiles of the SAME level
 * differ by up to 1.31× — read as different land, and it was half of what the player was seeing when they
 * circled three level-4 ink tiles as "obviously not the same kind of tile" (slg-resource-art.md §6.1).
 * Size now belongs entirely to the level curve, so jitter keeps only enough scale variance to soften the
 * grid: [0.96, 1.04]. `dx`/`dy` are fractions of `tp`, `rot` is radians (±~20°).
 */
export function resMotifJitter(tx: number, ty: number): { dx: number; dy: number; rot: number; scale: number } {
  const h1raw = Math.sin(tx * 12.9898 + ty * 78.233) * 43758.5453;
  const h2raw = Math.sin(tx * 39.346 + ty * 11.135) * 24634.6345;
  const h1 = h1raw - Math.floor(h1raw);
  const h2 = h2raw - Math.floor(h2raw);
  return { dx: (h1 - 0.5) * 0.26, dy: (h2 - 0.5) * 0.18, rot: (h1 - 0.5) * 0.7, scale: 0.96 + h2 * 0.08 };
}

/**
 * Where and how big to draw one resource motif sprite, relative to the tile diamond's centre.
 *
 * `read` is the frame's baked `nw` block; pass null for a frame that has none (an atlas built before
 * §6.3, or a non-`res_*` frame), which falls back to the old bounded normalisation on max(w,h) at full
 * alpha — visible but with no level read, which is the honest rendering of an atlas that carries none.
 *
 * The y offset is flattened (×0.6) so the motif never pokes past the shallower diamond edges near the
 * tile's left/right tips.
 */
export function resMotifPlacement(opts: {
  tp: number;
  tx: number;
  ty: number;
  read: ResMotifFrameRead | null;
  texW: number;
  texH: number;
  fogged?: boolean;
}): ResMotifPlacement {
  const { tp, tx, ty, read, texW, texH, fogged = false } = opts;
  const j = resMotifJitter(tx, ty);
  const sizeMul = read ? read.sizeMul : 1 / Math.max(texW, texH);
  return {
    scale: tp * RES_MOTIF_SIZE_FRAC * sizeMul * j.scale,
    alpha: fogged ? RES_MOTIF_FOG_ALPHA : (read ? read.alphaMul : 1),
    rotation: j.rot,
    x: j.dx * tp,
    y: 0.02 * tp * 0.6 + j.dy * tp,
  };
}

/**
 * Lowest resource level that shows an explicit `Lv.N` label on its tile.
 *
 * The exact level was an explicit channel in the original design, dropped in the 2026-07-17 rebuild
 * ("read the tier off the artwork") and restored on 2026-08-19 once measurement showed the artwork
 * alone cannot separate ten tiers — see slg-resource-art.md §6.7: ink mass and object count pull
 * against each other, so a drawing can carry "roughly how rich" but not "exactly which level".
 *
 * From 6 up, not everywhere: the mistake worth preventing is marching into a garrison you cannot
 * beat, which only happens at the high tiers; the low tiers just need the three-band volume read they
 * already have.
 *
 * This threshold does NOT bound how many labels land on screen, and it was written as if it did.
 * `SLG_GEN.resourceDensity` is 1.0, and scanning `proceduralTile` over the whole 1500x1500 map puts
 * level 6+ at 11.9% of resource tiles overall but in large fully-saturated blocks — there is a 32x32
 * run near the world centre where every single tile is 6+. Inside those blocks every visible tile is
 * labelled (measured: 650/650 at 1920x1080, 2706/3660 at 1080x2340), so the only thing keeping the
 * layer readable is the label's own weight, not this filter — see {@link RES_LEVEL_LABEL_MAX_PX} and
 * slg-resource-art.md §6.12.
 */
export const RES_LEVEL_LABEL_MIN_LEVEL = 6;

/**
 * Smallest tile pitch (screen px) that still shows the label. Below this the glyphs are under ~9 px
 * and turn into grey smudges that read as map dirt rather than as text — the same reason the zoomed-out
 * levels drop markers entirely (zoom.ts L2/L3).
 */
export const RES_LEVEL_LABEL_MIN_TP = 64;

/** Glyph size as a fraction of the tile pitch, before {@link RES_LEVEL_LABEL_MAX_PX} caps it. */
export const RES_LEVEL_LABEL_TP_FRAC = 0.13;
/** Floor from {@link RES_LEVEL_LABEL_MIN_TP}'s reasoning: below ~9 px the glyphs read as map dirt. */
export const RES_LEVEL_LABEL_MIN_PX = 9;
/**
 * Ceiling on the glyph size, in screen px.
 *
 * The label is chrome laid over the artwork, not part of it, so it should not keep growing with the
 * tile. `tp` at the closest zoom tier swings from 98 (portrait, 1080 design width) to 174 (landscape,
 * 1920) — the same tier, nearly double the pitch. Uncapped, `tp * 0.13` gives 13 px on a phone, which
 * is right, and 23 px on a desktop, which is 44% of the motif's own width; measured on the real map's
 * densest l6+ region that is 650 labels over 650 visible tiles and the map reads as a wall of text
 * rather than as drawn resources (slg-resource-art.md §6.12). Capping lands desktop on the weight the
 * phone already had, and leaves the phone untouched.
 */
export const RES_LEVEL_LABEL_MAX_PX = 17;

/** Rendered glyph size for a `Lv.N` label on a tile of pitch `tp`. */
export function resLevelLabelFontPx(tp: number): number {
  const px = Math.round(tp * RES_LEVEL_LABEL_TP_FRAC);
  return Math.max(RES_LEVEL_LABEL_MIN_PX, Math.min(RES_LEVEL_LABEL_MAX_PX, px));
}

/**
 * The label text for a resource tile, or null when this tile/zoom should show none.
 *
 * Plain `Lv.{n}` rather than any symbolic encoding, following the 2026-08-01 city-label precedent:
 * the dot-matrix tier marker it replaced encoded two things at once and players reported it as
 * confusing (WORLD_MAP_ART_SPEC.md §4). Digits have no such ambiguity.
 */
export function resLevelLabelText(level: number, tp: number): string | null {
  if (!Number.isFinite(level) || level < RES_LEVEL_LABEL_MIN_LEVEL) return null;
  if (tp < RES_LEVEL_LABEL_MIN_TP) return null;
  return `Lv.${Math.min(10, Math.round(level))}`;
}

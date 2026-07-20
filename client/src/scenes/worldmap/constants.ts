// WorldMap constants — extracted from WorldMapScene (SLG overworld). Pure values, no PIXI/state.

export const DEFAULT_MAP_SIZE = 1500; // server default 1500×1500; actual value comes from getSeason
export const HUD_H    = 56;   // bottom chat-bar height (§25 HUD relayout — status/marches moved to a floating top-right stack)
export const MARGIN   = 4;    // margin inside modal
export const CONFIRM_H = 280;

// City sprite side length in tiles (ADR-025). The base now really occupies a 3×3 footprint; the
// sprite is drawn slightly larger than 3 tiles to compensate the ~15% transparent margin baked into
// the isometric city art, so the drawn building visually fills its 3×3 block instead of floating small.
export const BASE_SPRITE_TILES = 3.2;

/** Coin cost for a voluntary capital relocation (display only; server @nw/shared RELOCATE_COST is authoritative). */
export const RELOCATE_COST = 500;
/** Resource cost to build a watchtower (display only; server @nw/shared WATCHTOWER_COST is authoritative). */
export const WATCHTOWER_COST_METAL = 2000;
export const WATCHTOWER_COST_PAPER = 3000;

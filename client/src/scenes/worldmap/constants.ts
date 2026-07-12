// WorldMap constants — extracted from WorldMapScene (SLG overworld). Pure values, no PIXI/state.

export const DEFAULT_MAP_SIZE = 1500; // server default 1500×1500; actual value comes from getSeason
export const HUD_H    = 56;   // bottom chat-bar height (§25 HUD relayout — status/marches moved to a floating top-right stack)
export const MARGIN   = 4;    // margin inside modal
export const CONFIRM_H = 280;

// City sprite side length in tiles (ADR-025). The base now really occupies a 3×3 footprint; the
// sprite is drawn slightly larger than 3 tiles to compensate the ~15% transparent margin baked into
// the isometric city art, so the drawn building visually fills its 3×3 block instead of floating small.
export const BASE_SPRITE_TILES = 3.2;

// Train economy mirrors (DRAFT; server @nw/shared is authoritative — these only
// size the client's preview/cost estimates for the C4 panel). Keep in sync with
// shared/slg.ts TROOP_TRAIN_INK_COST / TROOP_SPEEDUP_SECS_PER_COIN / *_BATCH_MAX.
export const TRAIN_INK_PER         = 10;
export const TRAIN_SPEEDUP_PER_COIN = 60; // seconds shortened per coin
export const TRAIN_BATCH_MAX       = 500;
export const TRAIN_PRESETS         = [10, 50];
/** Coin cost for a voluntary capital relocation (display only; server @nw/shared RELOCATE_COST is authoritative). */
export const RELOCATE_COST = 500;
/** Resource cost to build a watchtower (display only; server @nw/shared WATCHTOWER_COST is authoritative). */
export const WATCHTOWER_COST_METAL = 2000;
export const WATCHTOWER_COST_PAPER = 3000;

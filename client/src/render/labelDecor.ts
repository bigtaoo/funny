/**
 * labelDecor.ts — the battlefield "corner hand-lettering" textures (art-direction
 * §6.2, B-group). Four individual hand-drawn labels — `[START]` / `BOSS` / `WIN!` /
 * a curved `→ here` arrow — that get snapped into the paper margins around the
 * grid (see battleLabels.ts) to give a match that scribbled-notebook,
 * campaign-page feel.
 *
 * Packed into the shared decorMergedAtlas (see that module) alongside the A/C
 * decor groups — frame names are `label_boss` / `label_start` / `label_win` /
 * `label_arrow_here`. Loaded once at app boot (fire-and-forget — see app.ts) and
 * shared across every battle. A battle entered before the atlas finishes decoding
 * simply renders without labels (purely cosmetic, like the A-group ambience). In
 * headless tests no renderer exists and the label pass is skipped entirely.
 *
 * Lines are already the spec ink colour (red marker / blue pen — baked in by
 * art/ui/decos-b/pack_labels.cjs per "player=blue, enemy=red"), so they are used as-is and must
 * NOT be tinted (same rule as §6.2 note for the A group).
 */
import { decorMergedAtlas as atlas } from './decorMergedAtlas';

/** Stable label names — one per B-group asset. */
export type LabelName = 'label_boss' | 'label_start' | 'label_win' | 'label_arrow_here';

/** True once the shared decor atlas has decoded and frames are parsed. */
export const isLabelDecorReady = atlas.isReady;

/** Texture for a label name, or null if not loaded yet. */
export function getLabelTexture(name: LabelName): ReturnType<typeof atlas.getTexture> {
  return atlas.getTexture(name);
}

/**
 * Decode the shared decor atlas (idempotent — shares the in-flight load with
 * decorAtlas/decorCAtlas). Callers may ignore the result (labels are optional
 * ambience).
 */
export const loadLabelDecor = atlas.load;

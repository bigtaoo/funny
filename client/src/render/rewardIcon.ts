/**
 * rewardIcon.ts — the single source of truth for "what does a reward of kind X look like".
 *
 * Reward rows show up on six unrelated screens (daily check-in / daily tasks / weekly active
 * chest / battle-pass track / event点数商店 / recharge milestones / mail attachments) and each
 * one used to hand-roll its own `kind → IconKind → buildIcon(...)` table. Materials and coins
 * had already been centralised (`buildMaterialIcon` / `buildCoinIcon`), but `card` / `equipment`
 * / `skin` were still falling through to the *procedural* SketchPen glyphs (`cards` / `armor` /
 * `brush`) long after AI line art existed for exactly those three concepts — so e.g. the weekly
 * chest tab drew a thin program-drawn shield next to a real AI-drawn pencil-lead bitmap in the
 * card right above it (2026-08-15 bug report).
 *
 * This module is the one place that decides. It composes the three existing per-domain resolvers
 * rather than adding a fourth art path:
 *   coins    → `buildCoinIcon`      (AI coin atlas, escalating tier art; assets/shop/coins.png)
 *   material → `buildMaterialIcon`  (AI material atlas; iconsAtlas)
 *   card     → `rosterIcon`  ┐
 *   equipment→ `equipIcon`   ├ AI tab-icon PNGs (assets/tabicons/*), the same art the Cards /
 *   skin     → `skinIcon`    ┘ Equipment / Skins page tabs use — identical concepts, so reused
 *                              rather than re-generated (same call the auction equipment filter
 *                              and the lobby nav make; see design/product/tab-icon-art-prompts.md).
 *                              Drawn in the `content` ink, not the tab greys — see below.
 *   stamina / anything else → null (caller falls back to a bare "+N" label)
 *
 * Every one of those resolvers degrades to a procedural glyph on its own when its art has not
 * decoded yet, so a caller that forgets {@link preloadRewardIconArt} still renders *something* —
 * it just renders the old look for a frame or two. Scenes with reward rows should call the
 * preloader once in their constructor and re-render on resolve.
 */
import * as PIXI from 'pixi.js-legacy';
import { buildIcon, preloadTabIconTextures, tabIconVariant, type IconKind } from './icons';
import { buildCoinIcon, loadCoinIconAtlas } from './atlas/coinIconAtlas';
import { buildMaterialIcon, loadMaterialAtlas, type MaterialKind } from './atlas/materialAtlas';

/** The shape every reward-ish payload on the wire shares (battle pass / daily / event / mail…). */
export interface RewardLike {
  kind: string;
  id?: string;
  count?: number;
}

/**
 * Coin reward → escalating pile glyph so larger payouts read visibly richer at a glance
 * (single coin → cluster → stack → sack → chest). This is the *gameplay-reward* scale (daily /
 * battle pass / events, tens-to-hundreds of coins); RechargeScene keeps its own far coarser
 * scale locally and passes it in via `opts.coinKind`, because its payouts run to five figures
 * and would otherwise all bottom out as a chest.
 */
export function coinIconTier(count: number): IconKind {
  if (count >= 300) return 'coinChest';
  if (count >= 150) return 'coinSack';
  if (count >= 80) return 'coinStack';
  if (count >= 40) return 'coins';
  return 'coin';
}

/** A craft-material id → its atlas frame, or null when the id isn't one of the three materials. */
export function materialKind(id: string | undefined): MaterialKind | null {
  return id === 'scrap' || id === 'lead' || id === 'binding' ? id : null;
}

/**
 * The picture for one reward, fitted to a `size × size` box with its top-left at the origin
 * (same positioning contract as `buildIcon`), or `null` when the kind has no picture at all
 * (stamina, or a server kind this client doesn't know) — callers draw a bare "+N" for those.
 *
 * `color` is the requested ink: it tints the procedural fallbacks and, for the raster tab-icon
 * art, is read as a light/dark hint about the surface behind the icon (see `tabIconVariant`).
 *
 * `opts.materialFallback` decides what an unrecognised `material` id draws as: most screens want
 * `'scrap'` (the reward *is* a material, we just don't know which), but EventScene's redemption
 * rows want `null` so an unknown item id degrades to a text-only row instead of a wrong picture.
 */
export function buildRewardIcon(
  reward: RewardLike,
  size: number,
  color: number,
  opts?: { coinKind?: IconKind; materialFallback?: MaterialKind | null },
): PIXI.DisplayObject | null {
  const { kind, id, count } = reward;
  if (kind === 'coins') return buildCoinIcon(opts?.coinKind ?? coinIconTier(count ?? 0), size, color);
  if (kind === 'material') {
    const mat = materialKind(id) ?? (opts?.materialFallback === undefined ? 'scrap' : opts.materialFallback);
    return mat ? buildMaterialIcon(mat, size, color) : null;
  }
  // The three item rewards reuse the AI tab-icon art, but as page CONTENT — every reward row today
  // is drawn on a paper fill next to full-colour material/coin bitmaps and the primary label, where
  // the de-emphasised tab grey `tabIconVariant` would pick reads a notch washed out (2026-08-15
  // follow-up). Ask for the `C.dark` `content` ink instead. The `'active'` branch is not dead
  // weight: a caller drawing a reward on a dark fill still passes a light ink and still needs the
  // white art — `content` on near-black would be the same invisible-icon bug batch 3 shipped.
  const variant = tabIconVariant(color) === 'active' ? 'active' : 'content';
  if (kind === 'card') return buildIcon('rosterIcon', size, color, { variant });
  if (kind === 'equipment') return buildIcon('equipIcon', size, color, { variant });
  if (kind === 'skin') return buildIcon('skinIcon', size, color, { variant });
  // Servers also hand out bare material ids as the `kind` itself on some endpoints (events).
  const bareMaterial = materialKind(kind);
  if (bareMaterial) return buildMaterialIcon(bareMaterial, size, color);
  return null;
}

/**
 * Warm every art source {@link buildRewardIcon} can reach (tab-icon PNGs + coin atlas + material
 * atlas). Never rejects — each source degrades to its procedural glyph on failure, and a reward
 * row is cosmetic. Call once per scene that draws reward rows and re-render on resolve:
 * `void preloadRewardIconArt().then(() => this.render())`.
 */
export function preloadRewardIconArt(): Promise<void> {
  return Promise.allSettled([
    preloadTabIconTextures(),
    loadCoinIconAtlas(),
    loadMaterialAtlas(),
  ]).then(() => undefined);
}

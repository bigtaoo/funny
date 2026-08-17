/**
 * icons.ts — small hand-drawn UI glyphs (book / globe / coin / trophy).
 *
 * Replaces emoji placeholders in the lobby with SketchPen line-art so the icons
 * share the worn-notebook ink language (art-direction: three stationery pens,
 * flat scrawl, no gradients). Each icon is drawn once into an `s × s` box at
 * local origin (0,0) and baked to a GPU texture via `uiCache` (cache key folds
 * in kind + size + colour), so repeated lobby builds cost nothing. Headless
 * tests with no renderer transparently fall back to a live draw.
 *
 * Coordinates are normalised to the box size `s` and content is centred, so a
 * caller can position either the baked Sprite or the live Graphics by its
 * top-left corner the same way.
 *
 * The individual draw helpers live under `./icons/*` grouped by category; this
 * module keeps the public `IconKind` union + the `buildIcon` dispatcher stable.
 */
import * as PIXI from 'pixi.js-legacy';
import { getCachedDisplay } from '../ui/widgets/uiCache';
import { getArtTexture, containScale } from './cardArt';
import { preloadTextureList } from '../assets/preloadTextures';
import { drawCoin, drawCoins, drawCoinStack, drawCoinSack, drawCoinChest } from './icons/currency';
import { drawBook, drawGlobe, drawTrophy, drawCastle, drawPencils } from './icons/motifs';
import {
  drawScrap, drawLead, drawBinding,
  drawAtk, drawHp, drawArmor, drawArmorHeavy, drawSpd, drawAtkspd, drawBrush,
} from './icons/equipment';
import { drawFlag, drawDesk, drawCabinet, drawHammer, drawHourglassSm, drawHourglassMd, drawHourglassLg } from './icons/slg';
import {
  drawSwords, drawReplay, drawShare, drawHome,
  drawTag, drawCapsule, drawCards, drawStar, drawLock, drawMedal, drawZoom, drawGift,
  drawClose, drawCheck, drawPlay,
} from './icons/ui';
import {
  drawTitleBronze, drawTitleSilver, drawTitleGold, drawTitlePlatinum, drawTitleDiamond,
  drawTitleStar, drawTitleMaster, drawTitleGrandmaster, drawTitleKing,
  drawTitleChampion, drawTitleTop3,
} from './icons/titles';

// Tab-icon AI art pilot (design/product/tab-icon-art-prompts.md, 2026-08-14): the [Cards|Equipment|Skins]
// growth-group peer tabs (CardScene/list.ts + EquipmentScene/inventory.ts's mirrored peer rail) are the
// first page-tab icons to move off procedural SketchPen glyphs onto AI-drawn line art, to fix both low
// recognizability (thin program-drawn line work) and the `cards`/`armor`/`brush` reuse across unrelated
// tabs (see the prompt doc's dedupe table). Colour is baked at pack time, not runtime-tinted (see
// art/ui/tabicons/pack_tab_icons.cjs's header comment for why) — one white PNG for the active cell
// (dark fill) and one mid-grey PNG for the inactive cell (paper fill) per icon.
import rosterActiveUrl from '../assets/tabicons/roster_active.png';
import rosterInactiveUrl from '../assets/tabicons/roster_inactive.png';
import rosterContentUrl from '../assets/tabicons/roster_content.png';
import equipIconActiveUrl from '../assets/tabicons/equip_active.png';
import equipIconInactiveUrl from '../assets/tabicons/equip_inactive.png';
import equipIconContentUrl from '../assets/tabicons/equip_content.png';
import skinIconActiveUrl from '../assets/tabicons/skin_active.png';
import skinIconInactiveUrl from '../assets/tabicons/skin_inactive.png';
import skinIconContentUrl from '../assets/tabicons/skin_content.png';

// Tab-icon AI art batch 2 (design/product/tab-icon-art-prompts.md §batch2, 2026-08-15): resolves the
// trophy(3-way)/book/medal reuse conflicts flagged after the pilot — these 4 are the genuinely new
// meanings that had no existing AI icon to reuse (the reuse-only fixes went straight to rosterIcon/
// skinIcon above, no new asset needed).
import statsTabIconActiveUrl from '../assets/tabicons/stats_active.png';
import statsTabIconInactiveUrl from '../assets/tabicons/stats_inactive.png';
import statsTabIconContentUrl from '../assets/tabicons/stats_content.png';
import progressTabIconActiveUrl from '../assets/tabicons/progress_active.png';
import progressTabIconInactiveUrl from '../assets/tabicons/progress_inactive.png';
import progressTabIconContentUrl from '../assets/tabicons/progress_content.png';
import honorTabIconActiveUrl from '../assets/tabicons/honor_active.png';
import honorTabIconInactiveUrl from '../assets/tabicons/honor_inactive.png';
import honorTabIconContentUrl from '../assets/tabicons/honor_content.png';
import collectionTabIconActiveUrl from '../assets/tabicons/collection_active.png';
import collectionTabIconInactiveUrl from '../assets/tabicons/collection_inactive.png';
import collectionTabIconContentUrl from '../assets/tabicons/collection_content.png';

// Tab-icon AI art batch 3 (design/product/tab-icon-art-prompts.md §batch3, 2026-08-15): the remaining
// 12 page-tab icons that had no reuse conflict to resolve (10 pure recognizability upgrades) or closed
// out the last 2 conflicts batch 2 missed (trophy was actually 4-way, not 3-way — battlepass tab was
// never accounted for; book's achievement-wall "pve" category use was also missed). `armor`(auction
// equipment filter)/`book`(Career stats tab) resolved via pure reuse of `equipIcon`/`statsTabIcon`
// instead — no new asset needed for those two.
import shopTabIconActiveUrl from '../assets/tabicons/shop_active.png';
import shopTabIconInactiveUrl from '../assets/tabicons/shop_inactive.png';
import shopTabIconContentUrl from '../assets/tabicons/shop_content.png';
import coinTabIconActiveUrl from '../assets/tabicons/coin_active.png';
import coinTabIconInactiveUrl from '../assets/tabicons/coin_inactive.png';
import coinTabIconContentUrl from '../assets/tabicons/coin_content.png';
import gachaTabIconActiveUrl from '../assets/tabicons/gacha_active.png';
import gachaTabIconInactiveUrl from '../assets/tabicons/gacha_inactive.png';
import gachaTabIconContentUrl from '../assets/tabicons/gacha_content.png';
import rechargeTabIconActiveUrl from '../assets/tabicons/recharge_active.png';
import rechargeTabIconInactiveUrl from '../assets/tabicons/recharge_inactive.png';
import rechargeTabIconContentUrl from '../assets/tabicons/recharge_content.png';
import homeTabIconActiveUrl from '../assets/tabicons/home_active.png';
import homeTabIconInactiveUrl from '../assets/tabicons/home_inactive.png';
import homeTabIconContentUrl from '../assets/tabicons/home_content.png';
import socialTabIconActiveUrl from '../assets/tabicons/social_active.png';
import socialTabIconInactiveUrl from '../assets/tabicons/social_inactive.png';
import socialTabIconContentUrl from '../assets/tabicons/social_content.png';
import pvpTabIconActiveUrl from '../assets/tabicons/pvp_active.png';
import pvpTabIconInactiveUrl from '../assets/tabicons/pvp_inactive.png';
import pvpTabIconContentUrl from '../assets/tabicons/pvp_content.png';
import bidTabIconActiveUrl from '../assets/tabicons/bid_active.png';
import bidTabIconInactiveUrl from '../assets/tabicons/bid_inactive.png';
import bidTabIconContentUrl from '../assets/tabicons/bid_content.png';
import materialTabIconActiveUrl from '../assets/tabicons/material_active.png';
import materialTabIconInactiveUrl from '../assets/tabicons/material_inactive.png';
import materialTabIconContentUrl from '../assets/tabicons/material_content.png';
import achievementTabIconActiveUrl from '../assets/tabicons/achievement_active.png';
import achievementTabIconInactiveUrl from '../assets/tabicons/achievement_inactive.png';
import achievementTabIconContentUrl from '../assets/tabicons/achievement_content.png';
import battlepassTabIconActiveUrl from '../assets/tabicons/battlepass_active.png';
import battlepassTabIconInactiveUrl from '../assets/tabicons/battlepass_inactive.png';
import battlepassTabIconContentUrl from '../assets/tabicons/battlepass_content.png';
import pveTabIconActiveUrl from '../assets/tabicons/pve_active.png';
import pveTabIconInactiveUrl from '../assets/tabicons/pve_inactive.png';
import pveTabIconContentUrl from '../assets/tabicons/pve_content.png';

export type IconKind =
  | 'book' | 'globe' | 'coin' | 'trophy' | 'castle' | 'pencils'
  // Recharge tiers (ShopScene): escalating treasure to make bigger tiers read richer.
  | 'coins' | 'coinStack' | 'coinSack' | 'coinChest'
  // Equipment page materials (EQUIPMENT_DESIGN): scrap / lead / binding.
  | 'scrap' | 'lead' | 'binding'
  // Equipment page stat icons: attack / HP / armor / move-speed / attack-speed.
  | 'atk' | 'hp' | 'armor' | 'spd' | 'atkspd'
  // SLG header-shop protection tiers (8h/24h): 'armor' is the base/shorter tier, this is the
  // reinforced/longer one — same shield, extra band + rivets, no new silhouette.
  | 'armorHeavy'
  // Collection page skin tag: cosmetic brush (cards/units use real PNG art, see cardArt.ts).
  | 'brush'
  // Results page actions: rematch (crossed swords) / replay (loop arrow) / share (out-of-box arrow) / back to lobby (house).
  | 'swords' | 'replay' | 'share' | 'home'
  // SLG march-kind glyph (WorldMapScene HUD): occupy (planted flag).
  // attack→swords, reinforce→armor(shield), return→replay are reused from above.
  | 'flag'
  // SLG city buildings (CityScene grid): HQ desk / archive cabinet + a build-queue hammer badge.
  // Resource-producer buildings reuse the res_atlas motifs; drillYard→swords, wall→castle, academy→book.
  | 'desk' | 'cabinet' | 'hammer'
  // SLG header-shop training-speedup tiers (1h/8h/24h): distinct from the 'spd' move-speed stat
  // glyph, and escalating sand/tick count per tier — see hourglassCore in icons/slg.ts.
  | 'hourglassSm' | 'hourglassMd' | 'hourglassLg'
  // Hub tab strip glyphs (HubTabs): shop price-tag / gacha capsule / roster card stack.
  // Other hub tabs reuse existing glyphs — coins→coin, battlepass→trophy, equipment→armor, collection→book.
  | 'tag' | 'capsule' | 'cards'
  // GachaScene rarity pips + limited-pool marker (standard pool reuses capsule). Tinted per rarity.
  | 'star'
  // Lock badge: locked cards/equipment/deck slots + battle-pass pass-required tier.
  | 'lock'
  // Leaderboard top-3 rank medal (tinted gold / silver / bronze per rank).
  | 'medal'
  // TitlesScene title-wall fallback for dynamic (non-permanent) titles: 9 ladder ranks
  // (bronze→king, escalating detail) + 2 SLG season titles (shield silhouette). See
  // icons/titles.ts — distinct from 'medal' above, which stays a single undifferentiated
  // glyph for the leaderboard's simpler 3-colour top-3 tint.
  | 'titleBronze' | 'titleSilver' | 'titleGold' | 'titlePlatinum' | 'titleDiamond'
  | 'titleStar' | 'titleMaster' | 'titleGrandmaster' | 'titleKing'
  | 'titleChampion' | 'titleTop3'
  // Zoom cycle button (WorldMapScene HUD): a magnifier lens + handle.
  | 'zoom'
  // Mail attachment marker (FriendsScene): a wrapped present with a bow.
  | 'gift'
  // Common UI dingbats replacing bare typographic glyphs so they share the ink
  // language: close (✕) / confirm tick (✓) / replay-triangle (▶).
  | 'close' | 'check' | 'play'
  // [Cards|Equipment|Skins] peer-tab AI art pilot (see the import block above) — raster, not drawn
  // via DRAW/SketchPen. `cards`/`armor`/`brush` above stay untouched for every other reuse site
  // (auction "mine" tab, itemKind()'s content badges…) that batch 2 judged a different concept.
  | 'rosterIcon' | 'equipIcon' | 'skinIcon'
  // Tab-icon AI art batch 2 (see the import block above) — the 4 genuinely-new meanings: lobby
  // "career/战绩" entry (bar chart), achievement "progression" category (stacked chevrons), Career
  // "Titles" tab (laurel wreath, deliberately not a closed disc so it doesn't crowd `medal`'s round-medal
  // look), achievement "collection" category (jigsaw puzzle piece, distinct from `book`'s pve glyph in
  // the same tab strip).
  | 'statsTabIcon' | 'progressTabIcon' | 'honorTabIcon' | 'collectionTabIcon'
  // Tab-icon AI art batch 3 (see the import block above) — 10 pure recognizability upgrades (shop hub
  // entries: shop/coins/gacha/recharge; bottom nav: home/social; achievement category: pvp; auction
  // filters/tabs: bid/material) plus the 2 new concepts that closed batch 2's missed trophy/book
  // conflicts: `achievementTabIcon` (trophy cup — CareerTabs "achievements" tab; trophy itself finally
  // goes full-AI here) and `battlepassTabIcon` (ticket — shop-group hub "battlepass" tab, the trophy
  // usage batch 2 never accounted for) split the trophy conflict; `pveTabIcon` (treasure-map scroll —
  // achievement "pve" category, book's missed 3rd usage) plus reusing `statsTabIcon` for CareerTabs
  // "stats" (see CareerTabs.ts) splits the book conflict.
  | 'shopTabIcon' | 'coinTabIcon' | 'gachaTabIcon' | 'rechargeTabIcon' | 'homeTabIcon' | 'socialTabIcon'
  | 'pvpTabIcon' | 'bidTabIcon' | 'materialTabIcon' | 'achievementTabIcon' | 'battlepassTabIcon' | 'pveTabIcon';

/** Raster tab-icon `IconKind`s that skip `DRAW`/`SketchPen` entirely — dispatched via `TAB_ICON_RASTER` instead. */
export type RasterIconKind =
  | 'rosterIcon' | 'equipIcon' | 'skinIcon'
  | 'statsTabIcon' | 'progressTabIcon' | 'honorTabIcon' | 'collectionTabIcon'
  | 'shopTabIcon' | 'coinTabIcon' | 'gachaTabIcon' | 'rechargeTabIcon' | 'homeTabIcon' | 'socialTabIcon'
  | 'pvpTabIcon' | 'bidTabIcon' | 'materialTabIcon' | 'achievementTabIcon' | 'battlepassTabIcon' | 'pveTabIcon';

/**
 * Which pre-baked ink a raster icon is drawn in. All three come from the same source art, recoloured
 * at pack time (art/ui/tabicons/pack_tab_icons.cjs) because a raster asset can't be tinted live:
 *   `active`   — white, for a tab cell filled with the dark cover colour.
 *   `inactive` — `C.mid` grey, deliberately de-emphasised, for a tab cell on paper.
 *   `content`  — `C.dark`, for the icon used as CONTENT rather than as a tab — a reward row's
 *                picture sits beside full-colour material/coin bitmaps and the primary label, and
 *                the tab grey read a notch washed out there (2026-08-15). Never auto-selected:
 *                a content site and an inactive tab both ask for a dark ink, so `tabIconVariant`
 *                can't tell them apart — the caller opts in via `buildIcon`'s `variant` option.
 */
export type RasterIconVariant = 'active' | 'inactive' | 'content';

/**
 * One PNG per {@link RasterIconVariant} per raster tab-icon kind — see the import block above.
 * Exported for the regression test (same reason as `DRAW`/`tabIconVariant`): a row that silently
 * loses its `content` entry, or points it at the `inactive` file, is invisible in review.
 */
export const TAB_ICON_RASTER: Record<RasterIconKind, Record<RasterIconVariant, string>> = {
  rosterIcon: { active: rosterActiveUrl as string, inactive: rosterInactiveUrl as string, content: rosterContentUrl as string },
  equipIcon:  { active: equipIconActiveUrl as string, inactive: equipIconInactiveUrl as string, content: equipIconContentUrl as string },
  skinIcon:   { active: skinIconActiveUrl as string, inactive: skinIconInactiveUrl as string, content: skinIconContentUrl as string },
  statsTabIcon:      { active: statsTabIconActiveUrl as string, inactive: statsTabIconInactiveUrl as string, content: statsTabIconContentUrl as string },
  progressTabIcon:   { active: progressTabIconActiveUrl as string, inactive: progressTabIconInactiveUrl as string, content: progressTabIconContentUrl as string },
  honorTabIcon:      { active: honorTabIconActiveUrl as string, inactive: honorTabIconInactiveUrl as string, content: honorTabIconContentUrl as string },
  collectionTabIcon: { active: collectionTabIconActiveUrl as string, inactive: collectionTabIconInactiveUrl as string, content: collectionTabIconContentUrl as string },
  shopTabIcon:        { active: shopTabIconActiveUrl as string, inactive: shopTabIconInactiveUrl as string, content: shopTabIconContentUrl as string },
  coinTabIcon:        { active: coinTabIconActiveUrl as string, inactive: coinTabIconInactiveUrl as string, content: coinTabIconContentUrl as string },
  gachaTabIcon:       { active: gachaTabIconActiveUrl as string, inactive: gachaTabIconInactiveUrl as string, content: gachaTabIconContentUrl as string },
  rechargeTabIcon:    { active: rechargeTabIconActiveUrl as string, inactive: rechargeTabIconInactiveUrl as string, content: rechargeTabIconContentUrl as string },
  homeTabIcon:        { active: homeTabIconActiveUrl as string, inactive: homeTabIconInactiveUrl as string, content: homeTabIconContentUrl as string },
  socialTabIcon:      { active: socialTabIconActiveUrl as string, inactive: socialTabIconInactiveUrl as string, content: socialTabIconContentUrl as string },
  pvpTabIcon:         { active: pvpTabIconActiveUrl as string, inactive: pvpTabIconInactiveUrl as string, content: pvpTabIconContentUrl as string },
  bidTabIcon:         { active: bidTabIconActiveUrl as string, inactive: bidTabIconInactiveUrl as string, content: bidTabIconContentUrl as string },
  materialTabIcon:    { active: materialTabIconActiveUrl as string, inactive: materialTabIconInactiveUrl as string, content: materialTabIconContentUrl as string },
  achievementTabIcon: { active: achievementTabIconActiveUrl as string, inactive: achievementTabIconInactiveUrl as string, content: achievementTabIconContentUrl as string },
  battlepassTabIcon:  { active: battlepassTabIconActiveUrl as string, inactive: battlepassTabIconInactiveUrl as string, content: battlepassTabIconContentUrl as string },
  pveTabIcon:         { active: pveTabIconActiveUrl as string, inactive: pveTabIconInactiveUrl as string, content: pveTabIconContentUrl as string },
};

/** Warm the 57 tab-icon PNGs (19 kinds × 3 inks) into the PIXI texture cache — call once from a
 *  scene that uses them (CardScene, EquipmentScene, or any reward row via `preloadRewardIconArt`)
 *  so the first render doesn't show a blank icon while it decodes. */
export function preloadTabIconTextures(): Promise<void> {
  return preloadTextureList(Object.values(TAB_ICON_RASTER).flatMap((v) => Object.values(v)));
}

/** Every `IconKind` except the raster-only tab icons above, which skip `DRAW` entirely (see `buildIcon`). */
export type DrawableIconKind = Exclude<IconKind, RasterIconKind>;

export const DRAW: Record<DrawableIconKind, (g: PIXI.Graphics, s: number, color: number) => void> = {
  book:    drawBook,
  globe:   drawGlobe,
  coin:    drawCoin,
  coins:     drawCoins,
  coinStack: drawCoinStack,
  coinSack:  drawCoinSack,
  coinChest: drawCoinChest,
  trophy:  drawTrophy,
  castle:  drawCastle,
  pencils: drawPencils,
  scrap:   drawScrap,
  lead:    drawLead,
  binding: drawBinding,
  atk:     drawAtk,
  hp:      drawHp,
  armor:   drawArmor,
  armorHeavy: drawArmorHeavy,
  spd:     drawSpd,
  atkspd:  drawAtkspd,
  brush:   drawBrush,
  swords:  drawSwords,
  replay:  drawReplay,
  share:   drawShare,
  home:    drawHome,
  flag:    drawFlag,
  desk:    drawDesk,
  cabinet: drawCabinet,
  hammer:  drawHammer,
  hourglassSm: drawHourglassSm,
  hourglassMd: drawHourglassMd,
  hourglassLg: drawHourglassLg,
  tag:     drawTag,
  capsule: drawCapsule,
  cards:   drawCards,
  star:    drawStar,
  lock:    drawLock,
  medal:   drawMedal,
  titleBronze: drawTitleBronze,
  titleSilver: drawTitleSilver,
  titleGold: drawTitleGold,
  titlePlatinum: drawTitlePlatinum,
  titleDiamond: drawTitleDiamond,
  titleStar: drawTitleStar,
  titleMaster: drawTitleMaster,
  titleGrandmaster: drawTitleGrandmaster,
  titleKing: drawTitleKing,
  titleChampion: drawTitleChampion,
  titleTop3: drawTitleTop3,
  zoom:    drawZoom,
  gift:    drawGift,
  close:   drawClose,
  check:   drawCheck,
  play:    drawPlay,
};

/**
 * A baked, reusable hand-drawn icon sized `size × size`, drawn in `color`.
 * Returns a `PIXI.Sprite` of the cached texture (or a live Graphics in headless
 * tests). Position by its top-left corner; the artwork is centred in the box.
 *
 * `opts.variant` only affects the raster kinds ({@link RasterIconVariant}); pass `'content'` when
 * the icon is page content rather than a tab, so it gets the full-strength ink instead of the
 * de-emphasised tab grey `color` alone would select. Ignored by the procedural glyphs, which take
 * `color` literally.
 */
export function buildIcon(
  kind: IconKind, size: number, color: number, opts?: { variant?: RasterIconVariant },
): PIXI.DisplayObject {
  const s = Math.round(size);
  const raster = (TAB_ICON_RASTER as Partial<Record<IconKind, Record<RasterIconVariant, string>>>)[kind];
  if (raster) return buildRasterTabIcon(raster, opts?.variant ?? tabIconVariant(color), s);
  const key = `icon:${kind}:${s}:${(color >>> 0).toString(16)}`;
  return getCachedDisplay(key, () => {
    const g = new PIXI.Graphics();
    DRAW[kind as DrawableIconKind](g, s, color);
    return g;
  }, s, s);
}

/**
 * Which pre-baked variant of a raster tab icon a caller's requested ink colour asks for. The art is
 * coloured at PACK time, not runtime-tinted (see the import block above), so `color` can't be applied
 * literally — it's read as a light/dark HINT about the surface the icon will sit on: a light ink means
 * "this sits on a dark fill" → the white `*_active.png`; anything darker → the mid-grey
 * `*_inactive.png` baked for paper fills.
 *
 * Rec. 601 luma at a deliberately high cut (0.70), NOT `=== 0xffffff`: only HubTabs' active cell
 * happens to pass exactly white, so the strict test handed the lobby bottom nav (which asks for
 * `C.light` 0xdddddd on its near-black `C.cover` bar) the paper-grey art, leaving the thin-lined
 * icons 养成/商城 invisible on it (2026-08-15). HubTabs' inactive `C.mid` (0x888888 ≈ 0.53) stays
 * below the cut and keeps its paper variant. Exported for the regression test.
 *
 * Deliberately never returns `'content'`: that variant is also a dark ink on paper, so no colour
 * test can separate it from an inactive tab — content sites ask for it explicitly through
 * `buildIcon`'s `variant` option.
 */
export function tabIconVariant(color: number): 'active' | 'inactive' {
  const r = ((color >> 16) & 0xff) / 255, g = ((color >> 8) & 0xff) / 255, b = (color & 0xff) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b >= 0.70 ? 'active' : 'inactive';
}

/**
 * A raster tab-icon sprite (`RasterIconKind` above), contain-fit and centred in an `s × s` box (same
 * positioning contract as the procedural glyphs above). The already-resolved `variant` picks one of
 * the three pre-baked inks (see `RasterIconVariant`) — the art is never tinted at runtime.
 * Not routed through `getCachedDisplay`/`uiCache` (that bakes a *drawn* Graphics to a texture; these
 * are already static textures) — `PIXI.Texture.from` has its own url-keyed cache, so repeat calls are
 * cheap. If the texture hasn't decoded yet (see `preloadTabIconTextures`), this draws nothing for that
 * one frame rather than a garbage 0/1px-scaled sprite; the caller's next render (post-preload) fixes it.
 */
function buildRasterTabIcon(
  raster: Record<RasterIconVariant, string>, variant: RasterIconVariant, s: number,
): PIXI.DisplayObject {
  const tex = getArtTexture(raster[variant]);
  const box = new PIXI.Container();
  if (!tex.baseTexture.valid) return box;
  const sprite = new PIXI.Sprite(tex);
  const scale = containScale(tex.width, tex.height, s, s);
  sprite.scale.set(scale);
  sprite.x = (s - tex.width * scale) / 2;
  sprite.y = (s - tex.height * scale) / 2;
  box.addChild(sprite);
  return box;
}

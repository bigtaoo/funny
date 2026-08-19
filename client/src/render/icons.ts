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
 *
 * The AI-drawn RASTER tab icons (`RasterIconKind` + `TAB_ICON_RASTER`) live in `./icons/tabIconRaster`
 * and are re-exported below, so `render/icons` remains the single public entry point for callers.
 */
import * as PIXI from 'pixi.js-legacy';
import { getCachedDisplay } from '../ui/widgets/uiCache';
import {
  TAB_ICON_RASTER, tabIconVariant, buildRasterTabIcon,
  type RasterIconKind, type RasterIconVariant,
} from './icons/tabIconRaster';
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
  drawClose, drawCheck, drawPlay, drawBackArrow,
} from './icons/ui';
import {
  drawTitleBronze, drawTitleSilver, drawTitleGold, drawTitlePlatinum, drawTitleDiamond,
  drawTitleStar, drawTitleMaster, drawTitleGrandmaster, drawTitleKing,
  drawTitleChampion, drawTitleTop3,
} from './icons/titles';

export { TAB_ICON_RASTER, tabIconVariant, preloadTabIconTextures } from './icons/tabIconRaster';
export type { RasterIconKind, RasterIconVariant } from './icons/tabIconRaster';

/** Every `IconKind` drawn procedurally through `DRAW`/SketchPen — i.e. all of them but the raster
 *  tab icons, which `buildIcon` dispatches to `./icons/tabIconRaster` instead. */
export type DrawableIconKind =
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
  // Back button (SceneHeader): the hand-drawn left arrow that replaced the literal arrow character.
  | 'backArrow';

/** Every icon `buildIcon` can build, procedural or raster. */
export type IconKind = DrawableIconKind | RasterIconKind;

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
  backArrow: drawBackArrow,
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

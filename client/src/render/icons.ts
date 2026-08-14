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
import equipIconActiveUrl from '../assets/tabicons/equip_active.png';
import equipIconInactiveUrl from '../assets/tabicons/equip_inactive.png';
import skinIconActiveUrl from '../assets/tabicons/skin_active.png';
import skinIconInactiveUrl from '../assets/tabicons/skin_inactive.png';

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
  // (Career codex, auction filters, achievement category…), only this one peer group moved.
  | 'rosterIcon' | 'equipIcon' | 'skinIcon';

/** `{active, inactive}` PNG pair per raster tab-icon kind — see the import block above. */
const TAB_ICON_RASTER: Record<'rosterIcon' | 'equipIcon' | 'skinIcon', { active: string; inactive: string }> = {
  rosterIcon: { active: rosterActiveUrl as string, inactive: rosterInactiveUrl as string },
  equipIcon:  { active: equipIconActiveUrl as string, inactive: equipIconInactiveUrl as string },
  skinIcon:   { active: skinIconActiveUrl as string, inactive: skinIconInactiveUrl as string },
};

/** Warm the 6 tab-icon PNGs into the PIXI texture cache — call once from a scene that uses them
 *  (CardScene, EquipmentScene) so the first render doesn't show a blank icon while it decodes. */
export function preloadTabIconTextures(): Promise<void> {
  return preloadTextureList(Object.values(TAB_ICON_RASTER).flatMap((v) => [v.active, v.inactive]));
}

/** Every `IconKind` except the raster-only tab icons above, which skip `DRAW` entirely (see `buildIcon`). */
type DrawableIconKind = Exclude<IconKind, 'rosterIcon' | 'equipIcon' | 'skinIcon'>;

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
 */
export function buildIcon(kind: IconKind, size: number, color: number): PIXI.DisplayObject {
  const s = Math.round(size);
  const raster = (TAB_ICON_RASTER as Partial<Record<IconKind, { active: string; inactive: string }>>)[kind];
  if (raster) return buildRasterTabIcon(raster, color, s);
  const key = `icon:${kind}:${s}:${(color >>> 0).toString(16)}`;
  return getCachedDisplay(key, () => {
    const g = new PIXI.Graphics();
    DRAW[kind as DrawableIconKind](g, s, color);
    return g;
  }, s, s);
}

/**
 * A `rosterIcon`/`equipIcon`/`skinIcon` sprite, contain-fit and centred in an `s × s` box (same
 * positioning contract as the procedural glyphs above). `color` picks the pre-baked variant instead
 * of tinting — `0xffffff` (HubTabs' active-cell colour) → the active PNG, anything else → inactive.
 * Not routed through `getCachedDisplay`/`uiCache` (that bakes a *drawn* Graphics to a texture; these
 * are already static textures) — `PIXI.Texture.from` has its own url-keyed cache, so repeat calls are
 * cheap. If the texture hasn't decoded yet (see `preloadTabIconTextures`), this draws nothing for that
 * one frame rather than a garbage 0/1px-scaled sprite; the caller's next render (post-preload) fixes it.
 */
function buildRasterTabIcon(raster: { active: string; inactive: string }, color: number, s: number): PIXI.DisplayObject {
  const tex = getArtTexture(color === 0xffffff ? raster.active : raster.inactive);
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

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
import { drawCoin, drawCoins, drawCoinStack, drawCoinSack, drawCoinChest } from './icons/currency';
import { drawBook, drawGlobe, drawTrophy, drawCastle, drawPencils } from './icons/motifs';
import {
  drawScrap, drawLead, drawBinding,
  drawAtk, drawHp, drawArmor, drawSpd, drawAtkspd, drawBrush,
} from './icons/equipment';
import { drawScope, drawFlag, drawDesk, drawCabinet, drawHammer } from './icons/slg';
import {
  drawSwords, drawReplay, drawShare, drawHome,
  drawTag, drawCapsule, drawCards, drawStar, drawLock, drawMedal, drawZoom, drawGift,
  drawClose, drawCheck, drawPlay,
} from './icons/ui';

export type IconKind =
  | 'book' | 'globe' | 'coin' | 'trophy' | 'castle' | 'pencils'
  // Recharge tiers (ShopScene): escalating treasure to make bigger tiers read richer.
  | 'coins' | 'coinStack' | 'coinSack' | 'coinChest'
  // Equipment page materials (EQUIPMENT_DESIGN): scrap / lead / binding.
  | 'scrap' | 'lead' | 'binding'
  // Equipment page stat icons: attack / HP / armor / move-speed / attack-speed.
  | 'atk' | 'hp' | 'armor' | 'spd' | 'atkspd'
  // Collection page skin tag: cosmetic brush (cards/units use real PNG art, see cardArt.ts).
  | 'brush'
  // Results page actions: rematch (crossed swords) / replay (loop arrow) / share (out-of-box arrow) / back to lobby (house).
  | 'swords' | 'replay' | 'share' | 'home'
  // SLG march-kind glyphs (WorldMapScene HUD): scout (telescope) / occupy (planted flag).
  // attack→swords, reinforce→armor(shield), return→replay are reused from above.
  | 'scope' | 'flag'
  // SLG city buildings (CityScene grid): HQ desk / archive cabinet + a build-queue hammer badge.
  // Resource-producer buildings reuse the res_atlas motifs; drillYard→swords, wall→castle, academy→book.
  | 'desk' | 'cabinet' | 'hammer'
  // Hub tab strip glyphs (HubTabs): shop price-tag / gacha capsule / roster card stack.
  // Other hub tabs reuse existing glyphs — coins→coin, battlepass→trophy, equipment→armor, collection→book.
  | 'tag' | 'capsule' | 'cards'
  // GachaScene rarity pips + limited-pool marker (standard pool reuses capsule). Tinted per rarity.
  | 'star'
  // Lock badge: locked cards/equipment/deck slots + battle-pass pass-required tier.
  | 'lock'
  // Leaderboard top-3 rank medal (tinted gold / silver / bronze per rank).
  | 'medal'
  // Zoom cycle button (WorldMapScene HUD): a magnifier lens + handle.
  | 'zoom'
  // Mail attachment marker (FriendsScene): a wrapped present with a bow.
  | 'gift'
  // Common UI dingbats replacing bare typographic glyphs so they share the ink
  // language: close (✕) / confirm tick (✓) / replay-triangle (▶).
  | 'close' | 'check' | 'play';

const DRAW: Record<IconKind, (g: PIXI.Graphics, s: number, color: number) => void> = {
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
  spd:     drawSpd,
  atkspd:  drawAtkspd,
  brush:   drawBrush,
  swords:  drawSwords,
  replay:  drawReplay,
  share:   drawShare,
  home:    drawHome,
  scope:   drawScope,
  flag:    drawFlag,
  desk:    drawDesk,
  cabinet: drawCabinet,
  hammer:  drawHammer,
  tag:     drawTag,
  capsule: drawCapsule,
  cards:   drawCards,
  star:    drawStar,
  lock:    drawLock,
  medal:   drawMedal,
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
  const key = `icon:${kind}:${s}:${(color >>> 0).toString(16)}`;
  return getCachedDisplay(key, () => {
    const g = new PIXI.Graphics();
    DRAW[kind](g, s, color);
    return g;
  }, s, s);
}

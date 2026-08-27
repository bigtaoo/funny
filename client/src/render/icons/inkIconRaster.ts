/**
 * icons/inkIconRaster.ts - the AI-drawn, RUNTIME-TINTED half of the icon set.
 *
 * Batch 7 (design/product/tab-icon-art-prompts-batch7.md, 2026-08-25) replaced the last 44
 * procedurally-drawn `IconKind`s - equipment affix/material glyphs, the generic UI dingbats a dozen
 * screens share, the SLG building + speed-up tier art, the five old fallback motifs, and the 11-step
 * title ladder - with AI line art, which emptied `icons.ts`'s `DRAW` table and deleted every
 * `icons/{motifs,equipment,slg,ui,titles,currency}.ts` draw function along with it.
 *
 * Why a second table instead of rows in {@link ./tabIconRaster}: a TAB icon's `color` argument is
 * only a light/dark HINT (`tabIconVariant` maps it onto one of three pre-baked inks, because the
 * caller is really saying "I am a cell on paper" / "I am a cell on the dark cover"). These 44 are
 * not tabs - they are content glyphs whose callers pass an ink they MEAN: LeaderboardScene tints
 * `medal` gold/silver/bronze per rank, GachaScene tints `star` per rarity, TitlesScene tints the
 * ladder glyph per owned/equipped/locked state, CampaignMapScene greys out unearned stars, HUDView
 * draws `ink` in the faction blue. Mapping those onto a pre-baked grey would silently flatten every
 * one of them, so instead the pack script bakes ONE white master per kind (`inks: ['active']`) and
 * the sprite is tinted live - white x tint reproduces the requested colour exactly, which is
 * precisely the `color`-taken-literally contract the procedural glyphs had. `render/titleArt.ts`
 * already tints its four permanent-title PNGs this way, so this is the established move for ink line
 * art; the "bake, don't tint" rule in the pack script's header is about FINISHED FULL-COLOUR art
 * (the coin bitmaps), which has no single ink to multiply.
 */
import * as PIXI from 'pixi.js-legacy';
import { getArtTexture, containScale } from '../cardArt';
import { preloadTextureList } from '../../assets/preloadTextures';

// Equipment affix values (EquipmentScene/detail.ts's `affixIconKind`) - the smallest icons in the
// game at ~20px, and the batch-7 starting point: `armor`/`armorHeavy` are one round buckler and the
// same buckler reinforced (the SLG shop's two protection tiers), deliberately neither `equipIcon`'s
// kite shield nor `armorslotTabIcon`'s breastplate.
import atkInkUrl from '../../assets/tabicons/atk_active.png';
import hpInkUrl from '../../assets/tabicons/hp_active.png';
import armorInkUrl from '../../assets/tabicons/armor_active.png';
import armorHeavyInkUrl from '../../assets/tabicons/armorHeavy_active.png';
import spdInkUrl from '../../assets/tabicons/spd_active.png';
import atkspdInkUrl from '../../assets/tabicons/atkspd_active.png';

// Equipment enhance panel: the three upgrade materials and the enhance button's own forging hammer
// (a flat-headed smith's hammer, NOT `bidTabIcon`'s auction gavel) - plus `ink`, the battle currency
// in HUDView, whose `drawInk` had carried a "placeholder until the AI-drawn glyph lands" note since
// the day it was written.
import scrapInkUrl from '../../assets/tabicons/scrap_active.png';
import leadInkUrl from '../../assets/tabicons/lead_active.png';
import bindingInkUrl from '../../assets/tabicons/binding_active.png';
import hammerInkUrl from '../../assets/tabicons/hammer_active.png';
import inkInkUrl from '../../assets/tabicons/ink_active.png';

// Generic UI dingbats: results-page actions, gacha rarity pips, lock badges, the leaderboard's
// tinted top-3 medal, the world map's zoom cycle, the auction "my listings" card badge, and the
// close/check/play trio that replaced bare typographic glyphs.
import replayInkUrl from '../../assets/tabicons/replay_active.png';
import shareInkUrl from '../../assets/tabicons/share_active.png';
import starInkUrl from '../../assets/tabicons/star_active.png';
import lockInkUrl from '../../assets/tabicons/lock_active.png';
import medalInkUrl from '../../assets/tabicons/medal_active.png';
import closeInkUrl from '../../assets/tabicons/close_active.png';
import checkInkUrl from '../../assets/tabicons/check_active.png';
import playInkUrl from '../../assets/tabicons/play_active.png';
import zoomInkUrl from '../../assets/tabicons/zoom_active.png';
import cardsInkUrl from '../../assets/tabicons/cards_active.png';

// SLG: the world-map occupy flag, two CityScene buildings, and the header shop's three training
// speed-up tiers (escalating sand - see the batch-7 doc's note that these three must be reviewed as
// a set, since the tier is the only thing that distinguishes them).
import flagInkUrl from '../../assets/tabicons/flag_active.png';
import deskInkUrl from '../../assets/tabicons/desk_active.png';
import cabinetInkUrl from '../../assets/tabicons/cabinet_active.png';
import hourglassSmInkUrl from '../../assets/tabicons/hourglassSm_active.png';
import hourglassMdInkUrl from '../../assets/tabicons/hourglassMd_active.png';
import hourglassLgInkUrl from '../../assets/tabicons/hourglassLg_active.png';

// The five oldest motifs, whose main sites moved to bespoke art in batches 1-6 but which each kept
// an edge fallback: CityScene's academy/wall buildings, the lobby's info/achievement toasts, the
// shop's annual-pass corner badge, CardScene's "new skin" placeholder cell.
import bookInkUrl from '../../assets/tabicons/book_active.png';
import globeInkUrl from '../../assets/tabicons/globe_active.png';
import trophyInkUrl from '../../assets/tabicons/trophy_active.png';
import castleInkUrl from '../../assets/tabicons/castle_active.png';
import pencilsInkUrl from '../../assets/tabicons/pencils_active.png';

// TitlesScene's dynamic-title ladder: 9 escalating ranks (bronze -> king) plus the 2 SLG season
// shields. The only PROGRESSION family in the set - each step adds exactly one detail to the one
// below it, so they are reviewed together at 28px, never one at a time.
import titleBronzeInkUrl from '../../assets/tabicons/titleBronze_active.png';
import titleSilverInkUrl from '../../assets/tabicons/titleSilver_active.png';
import titleGoldInkUrl from '../../assets/tabicons/titleGold_active.png';
import titlePlatinumInkUrl from '../../assets/tabicons/titlePlatinum_active.png';
import titleDiamondInkUrl from '../../assets/tabicons/titleDiamond_active.png';
import titleStarInkUrl from '../../assets/tabicons/titleStar_active.png';
import titleMasterInkUrl from '../../assets/tabicons/titleMaster_active.png';
import titleGrandmasterInkUrl from '../../assets/tabicons/titleGrandmaster_active.png';
import titleKingInkUrl from '../../assets/tabicons/titleKing_active.png';
import titleChampionInkUrl from '../../assets/tabicons/titleChampion_active.png';
import titleTop3InkUrl from '../../assets/tabicons/titleTop3_active.png';

// Batch 8 (design/product/tab-icon-art-prompts-batch8.md): the four stat words that never had a
// glyph at all — not even a procedural one, so batch 7's "replace every DRAW row" sweep could not
// have reached them. `range` is the codex tile's third stat chip; the other three are affix lines
// (`siege`/`crit` main-or-sub, `critmult` sub-only) that used to render as text with a blank where
// their neighbours had an icon. `crit`/`critmult` are one family: the same target and solid
// arrowhead, `critmult` adding the impact strokes outside the ring.
import rangeInkUrl from '../../assets/tabicons/range_active.png';
import siegeInkUrl from '../../assets/tabicons/siege_active.png';
import critInkUrl from '../../assets/tabicons/crit_active.png';
import critmultInkUrl from '../../assets/tabicons/critmult_active.png';

// The 6 kinds that ALIAS the white master of an existing tab icon rather than getting art of their
// own, so each concept is drawn exactly once in the game. They live here rather than as call-site
// renames to `pvpTabIcon`/`gachaTabIcon`/... because most of them have call sites where `color`
// carries real information a pre-baked tab ink would throw away: StatsScene tints `swords` green/red
// per match result, AuctionScene tints the `tag` sale-mode badge red for auction rows, FriendsScene
// draws the mail-attachment `gift` in gold, BattlePassScene passes `capsule` the reward's own
// colour, GachaScene tints `brush` per rarity. The tinted path keeps all of that and needs no churn
// at the ~20 sites involved.
//
// Five of the six came out of batch 7's dedupe table. `brush` joined them after three redraws:
// it is the "this is a skin/cosmetic" content badge (skin listings, the card skins grid, gacha
// rarity pips, the shop's skin products), and a stationery brush is the metaphor this project
// already rejected for skins once - `skinIcon` is a theatre mask precisely because "文具/画笔"
// collided with the equipment-material glyphs, which are also stationery (see
// design/product/art-direction-map-ui.md). Keeping a brush as the skin badge re-imported exactly
// that collision, so the badge now borrows the mask instead.
import swordsInkUrl from '../../assets/tabicons/pvp_active.png';
import homeInkUrl from '../../assets/tabicons/home_active.png';
import capsuleInkUrl from '../../assets/tabicons/gacha_active.png';
import giftInkUrl from '../../assets/tabicons/weekly_active.png';
import tagInkUrl from '../../assets/tabicons/auction_active.png';
import brushInkUrl from '../../assets/tabicons/skin_active.png';

/**
 * Every `IconKind` that resolves to a runtime-tinted ink PNG (see the module header) - i.e. all of
 * them but the raster TAB icons in ./tabIconRaster. The names are the ones the call sites already
 * passed when these were procedural glyphs, so batch 7 needed no call-site churn: `buildIcon` finds
 * the table entry below instead of a `DRAW` row and nothing else changes.
 */
export type InkIconKind =
  | 'atk' | 'hp' | 'armor' | 'armorHeavy' | 'spd' | 'atkspd'
  | 'range' | 'siege' | 'crit' | 'critmult'
  | 'scrap' | 'lead' | 'binding' | 'hammer' | 'ink'
  | 'replay' | 'share' | 'star' | 'lock' | 'medal' | 'close' | 'check' | 'play' | 'zoom' | 'cards'
  | 'flag' | 'desk' | 'cabinet' | 'hourglassSm' | 'hourglassMd' | 'hourglassLg'
  | 'book' | 'globe' | 'trophy' | 'castle' | 'pencils'
  | 'titleBronze' | 'titleSilver' | 'titleGold' | 'titlePlatinum' | 'titleDiamond'
  | 'titleStar' | 'titleMaster' | 'titleGrandmaster' | 'titleKing'
  | 'titleChampion' | 'titleTop3'
  // Aliases onto an existing icon's art (see the import block above) - no drawing of their own.
  | 'swords' | 'home' | 'capsule' | 'gift' | 'tag' | 'brush';

/**
 * One white master PNG per {@link InkIconKind} - tinted at draw time by {@link buildInkIcon}.
 * Exported for the regression test (same reason as `TAB_ICON_RASTER`): a row pointing at the wrong
 * file is invisible in review. The asset base name IS the kind name here (`armorHeavy` ->
 * `armorHeavy_active.png`), unlike the tab table's `fooTabIcon` -> `foo_active.png` suffix dance —
 * which is what lets `inkIconArt.test.ts` check every row against the packed output on disk without
 * a second hand-maintained kind-to-file map to drift out of sync.
 */
export const INK_ICON_ART: Record<InkIconKind, string> = {
  atk:               atkInkUrl as string,
  hp:                hpInkUrl as string,
  armor:             armorInkUrl as string,
  armorHeavy:        armorHeavyInkUrl as string,
  spd:               spdInkUrl as string,
  atkspd:            atkspdInkUrl as string,
  range:             rangeInkUrl as string,
  siege:             siegeInkUrl as string,
  crit:              critInkUrl as string,
  critmult:          critmultInkUrl as string,
  scrap:             scrapInkUrl as string,
  lead:              leadInkUrl as string,
  binding:           bindingInkUrl as string,
  hammer:            hammerInkUrl as string,
  ink:               inkInkUrl as string,
  replay:            replayInkUrl as string,
  share:             shareInkUrl as string,
  star:              starInkUrl as string,
  lock:              lockInkUrl as string,
  medal:             medalInkUrl as string,
  close:             closeInkUrl as string,
  check:             checkInkUrl as string,
  play:              playInkUrl as string,
  zoom:              zoomInkUrl as string,
  cards:             cardsInkUrl as string,
  flag:              flagInkUrl as string,
  desk:              deskInkUrl as string,
  cabinet:           cabinetInkUrl as string,
  hourglassSm:       hourglassSmInkUrl as string,
  hourglassMd:       hourglassMdInkUrl as string,
  hourglassLg:       hourglassLgInkUrl as string,
  book:              bookInkUrl as string,
  globe:             globeInkUrl as string,
  trophy:            trophyInkUrl as string,
  castle:            castleInkUrl as string,
  pencils:           pencilsInkUrl as string,
  titleBronze:       titleBronzeInkUrl as string,
  titleSilver:       titleSilverInkUrl as string,
  titleGold:         titleGoldInkUrl as string,
  titlePlatinum:     titlePlatinumInkUrl as string,
  titleDiamond:      titleDiamondInkUrl as string,
  titleStar:         titleStarInkUrl as string,
  titleMaster:       titleMasterInkUrl as string,
  titleGrandmaster:  titleGrandmasterInkUrl as string,
  titleKing:         titleKingInkUrl as string,
  titleChampion:     titleChampionInkUrl as string,
  titleTop3:         titleTop3InkUrl as string,
  swords:            swordsInkUrl as string,
  home:              homeInkUrl as string,
  capsule:           capsuleInkUrl as string,
  gift:              giftInkUrl as string,
  tag:               tagInkUrl as string,
  brush:             brushInkUrl as string,
};

/**
 * The kinds whose entry above ALIASES another icon's white master instead of naming art of their own
 * (see that import block). Exported so `inkIconArt.test.ts` can hold the two halves of the naming
 * contract apart: every OTHER ink kind must have a `<kind>_active.png` packed from a
 * `tabicon_<kind>.*` source of its own, while these must have neither.
 */
export const INK_ICON_ALIASES: readonly InkIconKind[] = ['swords', 'home', 'capsule', 'gift', 'tag', 'brush'];

/** Warm the ink-icon PNGs into the PIXI texture cache - see `preloadTabIconTextures`. */
export function preloadInkIconTextures(): Promise<void> {
  return preloadTextureList(Object.values(INK_ICON_ART));
}

/**
 * A tinted ink-icon sprite, contain-fit and centred in an `s x s` box (the same positioning contract
 * ./tabIconRaster's `buildRasterTabIcon` and the procedural glyphs both had). The art is a white
 * line drawing on transparent, so `sprite.tint = color` multiplies straight to `color`.
 *
 * Like the raster tab icons this draws NOTHING until the texture has decoded, rather than a garbage
 * 0/1px-scaled sprite - callers that can't tolerate a blank first frame preload via
 * {@link preloadInkIconTextures} (or `preloadRewardIconArt`, which chains it) and re-render.
 */
export function buildInkIcon(url: string, s: number, color: number): PIXI.DisplayObject {
  const tex = getArtTexture(url);
  const box = new PIXI.Container();
  if (!tex.baseTexture.valid) return box;
  const sprite = new PIXI.Sprite(tex);
  sprite.tint = color;
  const scale = containScale(tex.width, tex.height, s, s);
  sprite.scale.set(scale);
  sprite.x = (s - tex.width * scale) / 2;
  sprite.y = (s - tex.height * scale) / 2;
  box.addChild(sprite);
  return box;
}

/**
 * icons/tabIconRaster.ts — the AI-drawn RASTER half of the icon set (see ../icons.ts for the
 * procedural SketchPen half and the shared `buildIcon` dispatcher that picks between them).
 *
 * Split out of icons.ts on 2026-08-18, when batch 6 pushed that file past the 500-line convention:
 * 46 kinds × 3 pre-baked inks is 138 static imports plus the url table, roughly two thirds of the
 * old file, and it shares nothing with the draw-function dispatch beyond the `IconKind` union.
 * Everything here is re-exported from ../icons.ts, which stays the single public entry point.
 */
import * as PIXI from 'pixi.js-legacy';
import { getArtTexture, containScale } from '../cardArt';
import { preloadTextureList } from '../../assets/preloadTextures';

// Tab-icon AI art pilot (design/product/tab-icon-art-prompts.md, 2026-08-14): the [Cards|Equipment|Skins]
// growth-group peer tabs (CardScene/list.ts + EquipmentScene/inventory.ts's mirrored peer rail) are the
// first page-tab icons to move off procedural SketchPen glyphs onto AI-drawn line art, to fix both low
// recognizability (thin program-drawn line work) and the `cards`/`armor`/`brush` reuse across unrelated
// tabs (see the prompt doc's dedupe table). Colour is baked at pack time, not runtime-tinted (see
// art/ui/tabicons/pack_tab_icons.cjs's header comment for why) — one white PNG for the active cell
// (dark fill) and one mid-grey PNG for the inactive cell (paper fill) per icon.
import rosterActiveUrl from '../../assets/tabicons/roster_active.png';
import rosterInactiveUrl from '../../assets/tabicons/roster_inactive.png';
import rosterContentUrl from '../../assets/tabicons/roster_content.png';
import equipIconActiveUrl from '../../assets/tabicons/equip_active.png';
import equipIconInactiveUrl from '../../assets/tabicons/equip_inactive.png';
import equipIconContentUrl from '../../assets/tabicons/equip_content.png';
import skinIconActiveUrl from '../../assets/tabicons/skin_active.png';
import skinIconInactiveUrl from '../../assets/tabicons/skin_inactive.png';
import skinIconContentUrl from '../../assets/tabicons/skin_content.png';

// Tab-icon AI art batch 2 (design/product/tab-icon-art-prompts.md §batch2, 2026-08-15): resolves the
// trophy(3-way)/book/medal reuse conflicts flagged after the pilot — these 4 are the genuinely new
// meanings that had no existing AI icon to reuse (the reuse-only fixes went straight to rosterIcon/
// skinIcon above, no new asset needed).
import statsTabIconActiveUrl from '../../assets/tabicons/stats_active.png';
import statsTabIconInactiveUrl from '../../assets/tabicons/stats_inactive.png';
import statsTabIconContentUrl from '../../assets/tabicons/stats_content.png';
import progressTabIconActiveUrl from '../../assets/tabicons/progress_active.png';
import progressTabIconInactiveUrl from '../../assets/tabicons/progress_inactive.png';
import progressTabIconContentUrl from '../../assets/tabicons/progress_content.png';
import honorTabIconActiveUrl from '../../assets/tabicons/honor_active.png';
import honorTabIconInactiveUrl from '../../assets/tabicons/honor_inactive.png';
import honorTabIconContentUrl from '../../assets/tabicons/honor_content.png';
import collectionTabIconActiveUrl from '../../assets/tabicons/collection_active.png';
import collectionTabIconInactiveUrl from '../../assets/tabicons/collection_inactive.png';
import collectionTabIconContentUrl from '../../assets/tabicons/collection_content.png';

// Tab-icon AI art batch 3 (design/product/tab-icon-art-prompts.md §batch3, 2026-08-15): the remaining
// 12 page-tab icons that had no reuse conflict to resolve (10 pure recognizability upgrades) or closed
// out the last 2 conflicts batch 2 missed (trophy was actually 4-way, not 3-way — battlepass tab was
// never accounted for; book's achievement-wall "pve" category use was also missed). `armor`(auction
// equipment filter)/`book`(Career stats tab) resolved via pure reuse of `equipIcon`/`statsTabIcon`
// instead — no new asset needed for those two.
import shopTabIconActiveUrl from '../../assets/tabicons/shop_active.png';
import shopTabIconInactiveUrl from '../../assets/tabicons/shop_inactive.png';
import shopTabIconContentUrl from '../../assets/tabicons/shop_content.png';
import coinTabIconActiveUrl from '../../assets/tabicons/coin_active.png';
import coinTabIconInactiveUrl from '../../assets/tabicons/coin_inactive.png';
import coinTabIconContentUrl from '../../assets/tabicons/coin_content.png';
import gachaTabIconActiveUrl from '../../assets/tabicons/gacha_active.png';
import gachaTabIconInactiveUrl from '../../assets/tabicons/gacha_inactive.png';
import gachaTabIconContentUrl from '../../assets/tabicons/gacha_content.png';
import rechargeTabIconActiveUrl from '../../assets/tabicons/recharge_active.png';
import rechargeTabIconInactiveUrl from '../../assets/tabicons/recharge_inactive.png';
import rechargeTabIconContentUrl from '../../assets/tabicons/recharge_content.png';
import homeTabIconActiveUrl from '../../assets/tabicons/home_active.png';
import homeTabIconInactiveUrl from '../../assets/tabicons/home_inactive.png';
import homeTabIconContentUrl from '../../assets/tabicons/home_content.png';
import socialTabIconActiveUrl from '../../assets/tabicons/social_active.png';
import socialTabIconInactiveUrl from '../../assets/tabicons/social_inactive.png';
import socialTabIconContentUrl from '../../assets/tabicons/social_content.png';
import pvpTabIconActiveUrl from '../../assets/tabicons/pvp_active.png';
import pvpTabIconInactiveUrl from '../../assets/tabicons/pvp_inactive.png';
import pvpTabIconContentUrl from '../../assets/tabicons/pvp_content.png';
import bidTabIconActiveUrl from '../../assets/tabicons/bid_active.png';
import bidTabIconInactiveUrl from '../../assets/tabicons/bid_inactive.png';
import bidTabIconContentUrl from '../../assets/tabicons/bid_content.png';
import materialTabIconActiveUrl from '../../assets/tabicons/material_active.png';
import materialTabIconInactiveUrl from '../../assets/tabicons/material_inactive.png';
import materialTabIconContentUrl from '../../assets/tabicons/material_content.png';
import achievementTabIconActiveUrl from '../../assets/tabicons/achievement_active.png';
import achievementTabIconInactiveUrl from '../../assets/tabicons/achievement_inactive.png';
import achievementTabIconContentUrl from '../../assets/tabicons/achievement_content.png';
import battlepassTabIconActiveUrl from '../../assets/tabicons/battlepass_active.png';
import battlepassTabIconInactiveUrl from '../../assets/tabicons/battlepass_inactive.png';
import battlepassTabIconContentUrl from '../../assets/tabicons/battlepass_content.png';
import pveTabIconActiveUrl from '../../assets/tabicons/pve_active.png';
import pveTabIconInactiveUrl from '../../assets/tabicons/pve_inactive.png';
import pveTabIconContentUrl from '../../assets/tabicons/pve_content.png';

// Tab-icon AI art batch 5 (design/product/tab-icon-art-prompts-batch5.md, 2026-08-17): the first batch
// aimed at PAGE TITLES rather than tab strips — batches 1–4 scoped themselves to tab cells, so all 31
// title states had no glyph at all (see `drawSceneHeader`'s `opts.icon`). 16 of these are title
// concepts, 8 are the last tab/filter cells still on bare text (equipment's Inventory/Craft rail +
// slot filter, the avatar picker's preset tab, family/sect channel). The `*TabIcon` suffix is kept for
// the whole raster family regardless of the site — it marks "PNG from art/ui/tabicons", not "a tab".
import auctionTabIconActiveUrl from '../../assets/tabicons/auction_active.png';
import auctionTabIconInactiveUrl from '../../assets/tabicons/auction_inactive.png';
import auctionTabIconContentUrl from '../../assets/tabicons/auction_content.png';
import cityTabIconActiveUrl from '../../assets/tabicons/city_active.png';
import cityTabIconInactiveUrl from '../../assets/tabicons/city_inactive.png';
import cityTabIconContentUrl from '../../assets/tabicons/city_content.png';
import leaderboardTabIconActiveUrl from '../../assets/tabicons/leaderboard_active.png';
import leaderboardTabIconInactiveUrl from '../../assets/tabicons/leaderboard_inactive.png';
import leaderboardTabIconContentUrl from '../../assets/tabicons/leaderboard_content.png';
import settingsTabIconActiveUrl from '../../assets/tabicons/settings_active.png';
import settingsTabIconInactiveUrl from '../../assets/tabicons/settings_inactive.png';
import settingsTabIconContentUrl from '../../assets/tabicons/settings_content.png';
import eventTabIconActiveUrl from '../../assets/tabicons/event_active.png';
import eventTabIconInactiveUrl from '../../assets/tabicons/event_inactive.png';
import eventTabIconContentUrl from '../../assets/tabicons/event_content.png';
import deckTabIconActiveUrl from '../../assets/tabicons/deck_active.png';
import deckTabIconInactiveUrl from '../../assets/tabicons/deck_inactive.png';
import deckTabIconContentUrl from '../../assets/tabicons/deck_content.png';
import roomTabIconActiveUrl from '../../assets/tabicons/room_active.png';
import roomTabIconInactiveUrl from '../../assets/tabicons/room_inactive.png';
import roomTabIconContentUrl from '../../assets/tabicons/room_content.png';
import defenseTabIconActiveUrl from '../../assets/tabicons/defense_active.png';
import defenseTabIconInactiveUrl from '../../assets/tabicons/defense_inactive.png';
import defenseTabIconContentUrl from '../../assets/tabicons/defense_content.png';
import checkinTabIconActiveUrl from '../../assets/tabicons/checkin_active.png';
import checkinTabIconInactiveUrl from '../../assets/tabicons/checkin_inactive.png';
import checkinTabIconContentUrl from '../../assets/tabicons/checkin_content.png';
import tasksTabIconActiveUrl from '../../assets/tabicons/tasks_active.png';
import tasksTabIconInactiveUrl from '../../assets/tabicons/tasks_inactive.png';
import tasksTabIconContentUrl from '../../assets/tabicons/tasks_content.png';
import weeklyTabIconActiveUrl from '../../assets/tabicons/weekly_active.png';
import weeklyTabIconInactiveUrl from '../../assets/tabicons/weekly_inactive.png';
import weeklyTabIconContentUrl from '../../assets/tabicons/weekly_content.png';
import adsTabIconActiveUrl from '../../assets/tabicons/ads_active.png';
import adsTabIconInactiveUrl from '../../assets/tabicons/ads_inactive.png';
import adsTabIconContentUrl from '../../assets/tabicons/ads_content.png';
import friendsTabIconActiveUrl from '../../assets/tabicons/friends_active.png';
import friendsTabIconInactiveUrl from '../../assets/tabicons/friends_inactive.png';
import friendsTabIconContentUrl from '../../assets/tabicons/friends_content.png';
import familyTabIconActiveUrl from '../../assets/tabicons/family_active.png';
import familyTabIconInactiveUrl from '../../assets/tabicons/family_inactive.png';
import familyTabIconContentUrl from '../../assets/tabicons/family_content.png';
import sectTabIconActiveUrl from '../../assets/tabicons/sect_active.png';
import sectTabIconInactiveUrl from '../../assets/tabicons/sect_inactive.png';
import sectTabIconContentUrl from '../../assets/tabicons/sect_content.png';
import mailTabIconActiveUrl from '../../assets/tabicons/mail_active.png';
import mailTabIconInactiveUrl from '../../assets/tabicons/mail_inactive.png';
import mailTabIconContentUrl from '../../assets/tabicons/mail_content.png';
import bagTabIconActiveUrl from '../../assets/tabicons/bag_active.png';
import bagTabIconInactiveUrl from '../../assets/tabicons/bag_inactive.png';
import bagTabIconContentUrl from '../../assets/tabicons/bag_content.png';
import craftTabIconActiveUrl from '../../assets/tabicons/craft_active.png';
import craftTabIconInactiveUrl from '../../assets/tabicons/craft_inactive.png';
import craftTabIconContentUrl from '../../assets/tabicons/craft_content.png';
import allTabIconActiveUrl from '../../assets/tabicons/all_active.png';
import allTabIconInactiveUrl from '../../assets/tabicons/all_inactive.png';
import allTabIconContentUrl from '../../assets/tabicons/all_content.png';
import weaponTabIconActiveUrl from '../../assets/tabicons/weapon_active.png';
import weaponTabIconInactiveUrl from '../../assets/tabicons/weapon_inactive.png';
import weaponTabIconContentUrl from '../../assets/tabicons/weapon_content.png';
import armorslotTabIconActiveUrl from '../../assets/tabicons/armorslot_active.png';
import armorslotTabIconInactiveUrl from '../../assets/tabicons/armorslot_inactive.png';
import armorslotTabIconContentUrl from '../../assets/tabicons/armorslot_content.png';
import trinketTabIconActiveUrl from '../../assets/tabicons/trinket_active.png';
import trinketTabIconInactiveUrl from '../../assets/tabicons/trinket_inactive.png';
import trinketTabIconContentUrl from '../../assets/tabicons/trinket_content.png';
import avatarTabIconActiveUrl from '../../assets/tabicons/avatar_active.png';
import avatarTabIconInactiveUrl from '../../assets/tabicons/avatar_inactive.png';
import avatarTabIconContentUrl from '../../assets/tabicons/avatar_content.png';
import channelTabIconActiveUrl from '../../assets/tabicons/channel_active.png';
import channelTabIconInactiveUrl from '../../assets/tabicons/channel_inactive.png';
import channelTabIconContentUrl from '../../assets/tabicons/channel_content.png';

// Tab-icon AI art batch 6 (design/product/tab-icon-art-prompts-batch6.md, 2026-08-17): the lobby home
// screen itself, which batches 1–5 never touched — they scoped themselves to second-level pages, so
// the three most-looked-at glyphs in the game (the hero button's watermark + both pillar cards) were
// still procedural `pencils`/`book`/`castle` sitting right beside the already-AI coin bitmap, which
// made the thin program-drawn line work obvious. These render LARGE (the pillar motif is 60% of the
// card height), not at 28px, so the source art carries a little more detail than earlier batches.
// The 4th glyph the same review flagged — the rank chip's `trophy` — deliberately gets no new art:
// it reuses `leaderboardTabIcon` (the chip opens the leaderboard), see LobbyScene/header.ts.
import duelTabIconActiveUrl from '../../assets/tabicons/duel_active.png';
import duelTabIconInactiveUrl from '../../assets/tabicons/duel_inactive.png';
import duelTabIconContentUrl from '../../assets/tabicons/duel_content.png';
import campaignTabIconActiveUrl from '../../assets/tabicons/campaign_active.png';
import campaignTabIconInactiveUrl from '../../assets/tabicons/campaign_inactive.png';
import campaignTabIconContentUrl from '../../assets/tabicons/campaign_content.png';
import worldTabIconActiveUrl from '../../assets/tabicons/world_active.png';
import worldTabIconInactiveUrl from '../../assets/tabicons/world_inactive.png';
import worldTabIconContentUrl from '../../assets/tabicons/world_content.png';

/** Raster tab-icon `IconKind`s that skip `DRAW`/`SketchPen` entirely — dispatched via `TAB_ICON_RASTER` instead. */
export type RasterIconKind =
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
  | 'pvpTabIcon' | 'bidTabIcon' | 'materialTabIcon' | 'achievementTabIcon' | 'battlepassTabIcon' | 'pveTabIcon'
  // Tab-icon AI art batch 5 (see the import block above) — 16 page-title concepts plus 8 leftover tab
  // cells. Each one deliberately avoids an existing icon it would otherwise be confused with, and the
  // three riskiest pairs were checked side by side at 28px before wiring: `leaderboardTabIcon` is a
  // symmetrical podium, NOT `statsTabIcon`'s ascending bars; `weeklyTabIcon` is a ribboned gift box,
  // NOT `rechargeTabIcon`'s arched-lid chest; `craftTabIcon` is a bare anvil, since the hammer/mallet
  // shape is already `bidTabIcon`'s auction gavel. Likewise `cityTabIcon` (gatehouse) vs `homeTabIcon`
  // (pitched-roof house) vs `sectTabIcon` (pagoda), `armorslotTabIcon` (breastplate) vs `equipIcon`
  // (kite shield), `weaponTabIcon` (one upright sword) vs `pvpTabIcon` (crossed swords), and
  // `friendsTabIcon` (two heads) vs `familyTabIcon` (three, centre one larger).
  | 'auctionTabIcon' | 'cityTabIcon' | 'leaderboardTabIcon' | 'settingsTabIcon' | 'eventTabIcon'
  | 'deckTabIcon' | 'roomTabIcon' | 'defenseTabIcon' | 'checkinTabIcon' | 'tasksTabIcon'
  | 'weeklyTabIcon' | 'adsTabIcon' | 'friendsTabIcon' | 'familyTabIcon' | 'sectTabIcon' | 'mailTabIcon'
  | 'bagTabIcon' | 'craftTabIcon' | 'allTabIcon' | 'weaponTabIcon' | 'armorslotTabIcon'
  | 'trinketTabIcon' | 'avatarTabIcon' | 'channelTabIcon'
  // Tab-icon AI art batch 6 (see the import block above) — the lobby home screen: crossed pencils with
  // an ink splat at the clash point (hero "start match" watermark, replaces `pencils`), an open spiral
  // exercise book (战役 pillar, replaces `book` — deliberately the splayed-open notebook, NOT
  // `pveTabIcon`'s rolled treasure-map scroll), and an unfolded paper map with a dotted route + pennant
  // (大世界 pillar, replaces `castle` — not `cityTabIcon`'s gatehouse, not `socialTabIcon`'s globe).
  | 'duelTabIcon' | 'campaignTabIcon' | 'worldTabIcon';

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
 * Exported for the regression test (same reason as ../icons.ts's `DRAW` and `tabIconVariant` below): a row that silently
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
  auctionTabIcon:     { active: auctionTabIconActiveUrl as string, inactive: auctionTabIconInactiveUrl as string, content: auctionTabIconContentUrl as string },
  cityTabIcon:        { active: cityTabIconActiveUrl as string, inactive: cityTabIconInactiveUrl as string, content: cityTabIconContentUrl as string },
  leaderboardTabIcon: { active: leaderboardTabIconActiveUrl as string, inactive: leaderboardTabIconInactiveUrl as string, content: leaderboardTabIconContentUrl as string },
  settingsTabIcon:    { active: settingsTabIconActiveUrl as string, inactive: settingsTabIconInactiveUrl as string, content: settingsTabIconContentUrl as string },
  eventTabIcon:       { active: eventTabIconActiveUrl as string, inactive: eventTabIconInactiveUrl as string, content: eventTabIconContentUrl as string },
  deckTabIcon:        { active: deckTabIconActiveUrl as string, inactive: deckTabIconInactiveUrl as string, content: deckTabIconContentUrl as string },
  roomTabIcon:        { active: roomTabIconActiveUrl as string, inactive: roomTabIconInactiveUrl as string, content: roomTabIconContentUrl as string },
  defenseTabIcon:     { active: defenseTabIconActiveUrl as string, inactive: defenseTabIconInactiveUrl as string, content: defenseTabIconContentUrl as string },
  checkinTabIcon:     { active: checkinTabIconActiveUrl as string, inactive: checkinTabIconInactiveUrl as string, content: checkinTabIconContentUrl as string },
  tasksTabIcon:       { active: tasksTabIconActiveUrl as string, inactive: tasksTabIconInactiveUrl as string, content: tasksTabIconContentUrl as string },
  weeklyTabIcon:      { active: weeklyTabIconActiveUrl as string, inactive: weeklyTabIconInactiveUrl as string, content: weeklyTabIconContentUrl as string },
  adsTabIcon:         { active: adsTabIconActiveUrl as string, inactive: adsTabIconInactiveUrl as string, content: adsTabIconContentUrl as string },
  friendsTabIcon:     { active: friendsTabIconActiveUrl as string, inactive: friendsTabIconInactiveUrl as string, content: friendsTabIconContentUrl as string },
  familyTabIcon:      { active: familyTabIconActiveUrl as string, inactive: familyTabIconInactiveUrl as string, content: familyTabIconContentUrl as string },
  sectTabIcon:        { active: sectTabIconActiveUrl as string, inactive: sectTabIconInactiveUrl as string, content: sectTabIconContentUrl as string },
  mailTabIcon:        { active: mailTabIconActiveUrl as string, inactive: mailTabIconInactiveUrl as string, content: mailTabIconContentUrl as string },
  bagTabIcon:         { active: bagTabIconActiveUrl as string, inactive: bagTabIconInactiveUrl as string, content: bagTabIconContentUrl as string },
  craftTabIcon:       { active: craftTabIconActiveUrl as string, inactive: craftTabIconInactiveUrl as string, content: craftTabIconContentUrl as string },
  allTabIcon:         { active: allTabIconActiveUrl as string, inactive: allTabIconInactiveUrl as string, content: allTabIconContentUrl as string },
  weaponTabIcon:      { active: weaponTabIconActiveUrl as string, inactive: weaponTabIconInactiveUrl as string, content: weaponTabIconContentUrl as string },
  armorslotTabIcon:   { active: armorslotTabIconActiveUrl as string, inactive: armorslotTabIconInactiveUrl as string, content: armorslotTabIconContentUrl as string },
  trinketTabIcon:     { active: trinketTabIconActiveUrl as string, inactive: trinketTabIconInactiveUrl as string, content: trinketTabIconContentUrl as string },
  avatarTabIcon:      { active: avatarTabIconActiveUrl as string, inactive: avatarTabIconInactiveUrl as string, content: avatarTabIconContentUrl as string },
  channelTabIcon:     { active: channelTabIconActiveUrl as string, inactive: channelTabIconInactiveUrl as string, content: channelTabIconContentUrl as string },
  duelTabIcon:        { active: duelTabIconActiveUrl as string, inactive: duelTabIconInactiveUrl as string, content: duelTabIconContentUrl as string },
  campaignTabIcon:    { active: campaignTabIconActiveUrl as string, inactive: campaignTabIconInactiveUrl as string, content: campaignTabIconContentUrl as string },
  worldTabIcon:       { active: worldTabIconActiveUrl as string, inactive: worldTabIconInactiveUrl as string, content: worldTabIconContentUrl as string },
};

/** Warm the 138 tab-icon PNGs (46 kinds × 3 inks) into the PIXI texture cache — call once from a
 *  scene that uses them (`LobbyScene` does it for every second-level page, since they all enter from
 *  the lobby; CardScene/EquipmentScene and any reward row via `preloadRewardIconArt` also do)
 *  so the first render doesn't show a blank icon while it decodes. */
export function preloadTabIconTextures(): Promise<void> {
  return preloadTextureList(Object.values(TAB_ICON_RASTER).flatMap((v) => Object.values(v)));
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
 * positioning contract as ../icons.ts's procedural glyphs). The already-resolved `variant` picks one of
 * the three pre-baked inks (see `RasterIconVariant`) — the art is never tinted at runtime.
 * Not routed through `getCachedDisplay`/`uiCache` (that bakes a *drawn* Graphics to a texture; these
 * are already static textures) — `PIXI.Texture.from` has its own url-keyed cache, so repeat calls are
 * cheap. If the texture hasn't decoded yet (see `preloadTabIconTextures`), this draws nothing for that
 * one frame rather than a garbage 0/1px-scaled sprite; the caller's next render (post-preload) fixes it.
 */
export function buildRasterTabIcon(
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

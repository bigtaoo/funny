// STOPS — where the layout sweep goes, as DATA.
//
// Two walkers consume this table and they share nothing else: `test/browser/portraitLayout.spec.ts`
// drives a real Chromium from a Playwright process, and `entries/wechat-layout.ts` drives the app
// from INSIDE a WeChat mini-game package (§50.6 — the mini-game runtime has no appservice, so
// `miniprogram-automator`'s `evaluate` hangs forever and no external automation can reach in).
// Everything that describes *where to go* belongs here; everything that describes *how to get
// there* belongs to each walker, because the two mechanisms have nothing in common — one clicks
// browser pixels, the other pushes design-space coordinates into `InputManager`.
//
// A stop added here is walked by both. That is the whole point of the file.

import type { TranslationKey } from '../i18n';
// Recorded from a real, played-out AI match — see test/browser/captureEndStats.spec.ts, which
// regenerates it.
import { REAL_END_WINNER, REAL_END_STATS } from './endStatsFixture';

/**
 * One navigation step. Either a callback on the current screen's bag (`state.<screen>Cb`) — the
 * name alone, or with the argument it needs — or a TAP on a label, for the things that are not
 * screens: a modal has no callback to call, so the only way in is the way a player gets in (see
 * each walker's own `tapLabel`).
 */
export type Hop =
  | string
  /**
   * A callback on the current screen's bag. `stay` marks the ones that do NOT navigate — an overlay
   * mounted straight onto `app.stage` (the feedback dialog), or a loader whose result the next hop
   * needs (`loadSLGStatus`). Without it the walk waits ten seconds for a screen change that is never
   * coming and records the stop as an unwired feature, which is exactly how the feedback dialog spent
   * two rounds reported as "not offered by this account" while being perfectly wired.
   */
  | { fn: string; args?: unknown[]; stay?: boolean }
  /**
   * A tap on an on-screen label, addressed by its TRANSLATION KEY rather than its text: the same stop
   * table runs in three languages, and 'Craft' is 'Herstellen' in one of them. The key is resolved
   * against the viewport's own dictionary and truncated at the first `{` placeholder, so a
   * parameterised label ('Single {cost}') still matches on its literal prefix.
   */
  | { tap: TranslationKey }
  /**
   * A tap on a literal string. Only legitimate for text THIS SUITE PUT ON SCREEN (a seeded mail
   * subject): tapping content the account merely happens to own is what makes a stop table depend on
   * which cards a fresh roll handed out. Locale-independent by construction, since the seed writes
   * the same string in every run.
   */
  | { tapText: string };

export const hopName = (h: Hop): string =>
  typeof h === 'string' ? h
    : 'tap' in h ? `tap(${h.tap})`
      : 'tapText' in h ? `tap("${h.tapText}")`
        : h.fn;

export interface Stop {
  /**
   * The screen this entry is expected to land on, for readability — NOT asserted. The lobby's
   * bottom nav does not map one-to-one onto scenes (LOBBY_IA_REDESIGN): "Store" opens the gacha
   * scene, not ShopScene. The sweep audits whatever screen it actually lands on and records that
   * name, so a re-shuffled IA changes the report, not the result.
   */
  screen: string;
  /**
   * How to get there from the lobby: one callback name per hop, each invoked on the callback bag
   * of the screen currently showing (`state.<screen>Cb`). Two hops = a screen that is not on the
   * lobby's own nav, e.g. the title wall behind the career hub.
   */
  via: Hop[];
  /**
   * Name this stop reports under. Defaults to the screen actually reached, which is the right
   * answer for every screen-to-screen hop; a stop that ends in a modal needs its own name, because
   * `state.screen` still says the scene underneath and two stops would otherwise overwrite each
   * other's report and screenshot.
   */
  as?: string;
  /**
   * True when the entry is legitimately absent for this account — an online-only or
   * progression-gated feature (the world map needs chapter one cleared, ONBOARDING_DESIGN §4).
   * Such a stop is recorded as skipped instead of failing the walk.
   */
  gated?: boolean;
  /** Extra settle time (ms) for screens that paint again once their first fetch lands. */
  settleMs?: number;
  /**
   * Reload before walking on. Needed only by stops that open something on top of the LOBBY (the
   * feedback dialog is mounted straight on `app.stage`, not by a scene): `backToLobby` unwinds by
   * leaving screens, so with the lobby already showing it has nothing to do and the overlay would
   * stay up for every stop after this one. Scene-owned modals need none of this — leaving the scene
   * destroys them.
   */
  reloadAfter?: boolean;
}

/**
 * Where the sweep goes. The one-hop list is the lobby's own nav; the two-hop ones are the screens
 * behind it, and their callback names come from the `cbKeys` each report records — that is the
 * cheapest way to extend this list, rather than reading every scene's callback interface.
 */
/**
 * One side's end-of-match stats, cranked to the widest number each field can carry.
 *
 * The companion to the RECORDED payload below, not a replacement for it: a real match produces
 * realistic numbers, and realistic numbers do not tell you whether the score row survives a
 * seven-digit one. `PlayerStats` (server/engine/src/types/runtime.ts) puts no upper bound on damage,
 * and a long stalemate genuinely reaches these.
 */
function extremeStats(owner: number, dealt: number, taken: number): Record<string, unknown> {
  return {
    owner,
    damageDealtToBase: dealt,
    damageTakenByBase: taken,
    unitsSent: 1284,
    unitsKilled: 1176,
    spellHits: 486,
    // Populated, unlike the hand-written fixture this replaces: these two maps are the per-unit-type
    // breakdown rows, i.e. the tallest and widest block on the screen. Empty ones rendered nothing at
    // all, so the sweep was auditing a result screen the player never sees.
    killsByType: { infantry: 486, archer: 372, cavalry: 218, medic: 64, siege: 36 },
    castsByType: { fireball: 128, heal: 94, rally: 71, snipe: 43 },
    buildingSurvivalTicks: 108_000,
    goldSpent: 264_800,
  };
}

export const STOPS: Stop[] = [
  { screen: 'settings',     via: ['onOpenProfile'] },
  { screen: 'shop',         via: ['onOpenShop'],        settleMs: 800 },
  { screen: 'cardRoster',   via: ['onOpenCards'],       settleMs: 1200 },
  { screen: 'stats',        via: ['onOpenStats'] },
  { screen: 'campaignMap',  via: ['onOpenCampaign'],    settleMs: 800 },
  { screen: 'daily',        via: ['onOpenDaily'],       gated: true, settleMs: 800 },
  { screen: 'events',       via: ['onOpenEvents'],      gated: true, settleMs: 800 },
  { screen: 'leaderboard',  via: ['onOpenLeaderboard'], gated: true, settleMs: 1200 },
  { screen: 'friends',      via: ['onOpenSocial'],      gated: true, settleMs: 1200 },
  { screen: 'room',         via: ['onOpenRoom'],        gated: true, settleMs: 800 },
  { screen: 'recharge',     via: ['onOpenRecharge'],    gated: true, settleMs: 800 },
  { screen: 'achievements', via: ['onOpenAchievements'],gated: true, settleMs: 800 },
  { screen: 'auction',      via: ['onOpenAuction'],     gated: true, settleMs: 1800 },
  { screen: 'titles',       via: ['onOpenStats', 'onOpenTitles'] },
  { screen: 'cardCodex',    via: ['onOpenStats', 'onOpenCodex'], settleMs: 800 },
  { screen: 'equipment',    via: ['onOpenCampaign', 'onOpenEquipment'], settleMs: 1200 },
  // `ch1_lv1` is chapter one's first node (game/campaign/maps/ch1.json) — the only hop in this
  // table that takes an argument, since level entry is per-node rather than a single nav slot.
  { screen: 'levelPrep',    via: ['onOpenCampaign', { fn: 'onSelectLevel', args: ['ch1_lv1'] }], settleMs: 800 },
  { screen: 'worldMap',     via: ['onOpenWorld'],       gated: true, settleMs: 2500 },
  { screen: 'city',         via: ['onOpenWorld', 'onOpenCity'],    gated: true, settleMs: 2500 },
  // 'base' = the home city's own defense layout; `onOpenDefense(tileKey)` takes the tile it edits,
  // and calling it bare puts a literal "undefined" in the scene title.
  { screen: 'defenseEditor',via: ['onOpenWorld', { fn: 'onOpenDefense', args: ['base'] }], gated: true, settleMs: 1500 },
  { screen: 'battlePass',   via: ['onOpenShop', 'openBattlePass'], gated: true, settleMs: 900 },

  // ── Tabs that are not the default one ────────────────────────────────────────────────────────
  //
  // A one-hop stop audits whichever tab the scene opens on and nothing else, which for a four-tab
  // scene is a quarter of its surface. Daily is the case that proved it (2026-09-15): its landing
  // tab is not even fixed — `DailyScene.pickInitialTab` derives it from the save, so a fresh
  // account lands on Monthly Check-in and the other three tabs had never been walked. The daily
  // TASK cards were reported by a player, from a screenshot, on a screen the sweep calls clean.
  //
  // Reached by tapping the tab's own label, which is how a player reaches it and needs no new
  // callback surface (`Hop`'s tap form). Safe as long as the label is unique on the screen the tap
  // starts from — 'Daily Tasks' is also the tasks panel's section heading, so the hop to it starts
  // from check-in, where the tab strip is the only place those words appear.
  { screen: 'daily', as: 'daily+tasks',  via: ['onOpenDaily', { tap: 'daily.tasks.title' }],  gated: true, settleMs: 800 },
  { screen: 'daily', as: 'daily+weekly', via: ['onOpenDaily', { tap: 'daily.weekly.title' }], gated: true, settleMs: 800 },
  // The auction's other two tabs. `mine` draws a cancel action per row, `bids` an outcome badge —
  // neither shape exists on the market tab, and both are seeded (lib/seedFixtures.ts).
  { screen: 'auction', as: 'auction+mine', via: ['onOpenAuction', { tap: 'auction.tabMine' }], gated: true, settleMs: 1800 },
  { screen: 'auction', as: 'auction+bids', via: ['onOpenAuction', { tap: 'auction.tabBids' }], gated: true, settleMs: 1800 },

  // ── The social hub: ONE scene, five tabs, three entry points ─────────────────────────────────
  // `goMail` and the world map's chat button are both `goFriends({defaultTab})` (app/nav/social.ts),
  // so all three report `screen: 'friends'`. Until 2026-09-11 they shared one report slot and one
  // screenshot file, and `friends.png` was simply whichever of the three ran last — two thirds of
  // this scene's surface was silently unaudited.
  { screen: 'friends', as: 'friends+mail',  via: ['onOpenMail'], gated: true, settleMs: 1500 },
  { screen: 'friends', as: 'friends+world', via: ['onOpenWorld', 'onOpenChat'], gated: true, settleMs: 2000 },
  // The mail reader, opened the way a player opens it. Tapped by a subject the SEED wrote, so the
  // stop does not depend on what mail an account happens to have (see `Hop`'s tapText form).
  { screen: 'friends', as: 'friends+mailRead',
    via: ['onOpenMail', { tapText: 'Kampfbericht #1001' }], gated: true, settleMs: 1500 },

  // Family and sect. Two hops of loading, not one: `openFamilyHub`/`openSectHub` return false until
  // `loadSLGStatus` has resolved the caller's shard (app/nav/social.ts), and the scene only runs that
  // when the player switches to the tab. Both were recorded as "gated" for two rounds because of it.
  { screen: 'family', via: ['onOpenSocial', { fn: 'loadSLGStatus', stay: true }, 'openFamilyHub'],
    gated: true, settleMs: 2000 },
  { screen: 'sect',   via: ['onOpenSocial', { fn: 'loadSLGStatus', stay: true }, 'openSectHub'],
    gated: true, settleMs: 2000 },

  // The feedback dialog. Not a screen and never was — `onOpenFeedback` calls `requestFeedbackDialog()`
  // (net/log.ts), which hands off to a sink app.ts registered that mounts the dialog on `app.stage`.
  // The walk waited ten seconds for a screen change and filed it as an unwired feature.
  { screen: 'lobby', as: 'feedback', via: [{ fn: 'onOpenFeedback', stay: true }],
    gated: true, settleMs: 900, reloadAfter: true },

  // The battle, and the screen behind it. This is the one stop that leaves the menu shell: the HUD
  // is laid out by ILayout directly (not by a scene's own column arithmetic), so it is the one
  // place portrait can break in a way no menu screen would show.
  { screen: 'game',        via: [{ fn: 'onStartGame', args: ['AI'] }], settleMs: 3000 },
  // ...and the screen behind it, handed the payload a REAL match produced (endStatsFixture.ts,
  // recorded by captureEndStats.spec.ts) rather than played out: an AI match takes minutes, and this
  // stop audits the layout of a screen full of numbers — which is fixed the moment the match ends.
  { screen: 'result',
    via: [{ fn: 'onStartGame', args: ['AI'] },
      { fn: 'onGameEnd', args: [REAL_END_WINNER, REAL_END_STATS] }],
    settleMs: 1500 },
  // The same screen at the other end of the range. A recorded match is realistic, which is the one
  // thing it cannot be while also being extreme.
  { screen: 'result', as: 'result+extreme',
    via: [{ fn: 'onStartGame', args: ['AI'] },
      { fn: 'onGameEnd', args: [0, [extremeStats(0, 1284600, 986400), extremeStats(1, 986400, 1284600)]] }],
    settleMs: 1500 },

  // ── Modals and tabs: the states that are not screens ────────────────────────────────────────
  // Every one of these is opened by a hit rect inside a scene, so there is no callback for the
  // sweep to call and `state.screen` does not change — see `Hop`'s tap form and `Stop.as`.
  //
  // Addressed by translation key rather than by literal text, since the same table now runs in three
  // languages; the key is also what keeps the stop pointed at a UI string rather than at a content
  // name, so the table does not depend on which heroes an account happens to hold.
  { screen: 'cardRoster',  as: 'cardRoster+detail', via: ['onOpenCards', { tap: 'roster.power' }], settleMs: 1500 },
  { screen: 'equipment',   as: 'equipment+craft',
    via: ['onOpenCampaign', 'onOpenEquipment', { tap: 'equip.tabCraft' }], settleMs: 1500 },
  { screen: 'gacha',       as: 'gacha+draw',        via: ['onOpenShop', { tap: 'gacha.drawOne' }],
    gated: true, settleMs: 3000 },
  { screen: 'city',        as: 'city+buildDetail',
    via: ['onOpenWorld', 'onOpenCity', { tap: 'city.bld.desk' }], gated: true, settleMs: 2500 },
  { screen: 'city',        as: 'city+trainModal',
    via: ['onOpenWorld', 'onOpenCity', { tap: 'city.bld.trainTroops' }], gated: true, settleMs: 2500 },
];

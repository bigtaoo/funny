// Layout sweep — walks every screen, modal and battle the lobby can reach, on six viewports in a
// real browser, and fails on labels that collide, spill, fall off the canvas or come out too small
// to read.
//
// Still called portraitLayout.spec.ts (and still `npm run test:portrait`) because portrait is why it
// exists and what it is tuned for; two landscape rows in VIEWPORTS came free once the design box
// and the legibility floor were derived per viewport rather than hardcoded.
//
// Why this exists: development happens on a landscape desktop window, so portrait defects are only
// ever found by someone holding a phone and screenshotting one screen at a time. Everything needed
// to find them automatically was already here — `window.__nwE2E` (entries/web-e2e.ts) exposes both
// the scene callbacks and the real `PIXI.Application`, so a script can drive navigation and then
// measure the real display tree. What it could not do is *judge* the result; that is
// lib/layoutAudit.ts, and this spec is the walk that feeds it.
//
// This is the only layer that can judge text layout at all: the headless `test:ui` harness stubs
// `measureText` as a flat 7px per character, ignoring font size, so wrap-driven collisions — the
// entire portrait failure mode — do not reproduce there (see test/ui/titlesPortraitOverlap.ui.ts).
//
// Every stop also drops a PNG under `portrait-report/<viewport>/<screen>.png` and the findings
// under `portrait-report/report-<viewport>.json`, so a failure can be looked at, not just read.
//
// Prereq: a backend. Unlike smoke.spec.ts (which expects the bare-metal dev stack), this runs
// against the Docker stack on :8088 — playwright.portrait.config.ts points the client's e2e build
// at it. Start it with `./docker/local-up.ps1` from the repo root.
//
// Run: npm run test:portrait

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  uid, trackErrors, screenIs, currentScreen, registerAndEnterLobby, callCb, dismissFeatureGuide,
  tapLabel,
} from './lib/nwE2E';
import { seedAccount, seedWorld, type SeedTarget } from './lib/seed';
// Recorded from a real, played-out AI match — see captureEndStats.spec.ts, which regenerates it.
import { REAL_END_WINNER, REAL_END_STATS } from './endStatsFixture';
// The dictionaries themselves, not the i18n module: `t()` keeps the CURRENT locale in module state
// and this process has none. A stop that taps a label has to know what that label says in the
// locale the browser was booted in — see `Hop`'s tap form.
import { zh, type TranslationKey } from '../../src/i18n/locales/zh';
import { en } from '../../src/i18n/locales/en';
import { de } from '../../src/i18n/locales/de';
import {
  auditLayout, type AuditFinding, type AuditOptions, type AuditResult,
} from './lib/layoutAudit';
// Dependency-free pure module (no PIXI, no DOM) — safe to pull into the Playwright process, and
// the point of sharing it is that the `tiny` gate below asserts exactly the floor the app applies.
import { fontFloorDesignPx } from '../../src/render/fontScale';

/**
 * Every shape the layout has to survive. Portrait is why the sweep exists (development happens in a
 * landscape desktop window, so portrait defects only ever arrive as a screenshot from a phone), but
 * nothing in the walk or the audit is portrait-specific — the design box and the legibility floor
 * are derived per viewport below — so the same 33 stops cover landscape for the cost of two more
 * rows here.
 *
 *  · phone / narrow  — a current iPhone and the squeeze case (16:9 budget Android, the WeChat
 *    mini-game floor). Both contain to WIDTH, at 0.36x and 0.33x.
 *  · tablet portrait — squatter than 9:16, so it contains to HEIGHT and `ScalingManager`
 *    letterboxes the sides into desk bands (see its DESK_FILL header), a different code path.
 *  · the same two phones rotated — landscape's design box is the mirror rule (height fixed at
 *    1080, width tracks the aspect between 1920 and 2592), and a phone held sideways renders at
 *    the same brutal 0.36x, so it needs the same legibility floor.
 *  · desktop-1366x768 — the shape the game is actually developed in, as a floor: its 0.71x asks
 *    for no legibility floor at all, so anything the sweep reports there is a plain layout bug
 *    rather than a scale artefact.
 *
 * Each is a separate Playwright test, a separate browser context and a separate fresh account, so
 * one shape failing still reports the others. The full run is ~25 minutes; `--grep <name>` runs one.
 */
const DICTS = { zh, en, de } as const;
type Locale = keyof typeof DICTS;

const VIEWPORTS = [
  { name: 'phone-390x844',     width: 390,  height: 844,  locale: 'en' },
  { name: 'narrow-360x640',    width: 360,  height: 640,  locale: 'en' },
  { name: 'tablet-768x1024',   width: 768,  height: 1024, locale: 'en' },
  { name: 'landscape-844x390', width: 844,  height: 390,  locale: 'en' },
  { name: 'tablet-1024x768',   width: 1024, height: 768,  locale: 'en' },
  { name: 'desktop-1366x768',  width: 1366, height: 768,  locale: 'en' },
  // German and Chinese on the two phones only (2026-09-11). Locale is a multiplier on an already
  // 25-minute run, so it is spent where it can actually change the answer: the two viewports with
  // the least room. German is the longest of the three languages word for word — it is the one that
  // overflows a button — and Chinese is the one whose glyphs are full-width and whose text has no
  // spaces for word-wrap to break at, which is a different failure. The four wider viewports gain
  // nothing from either: they had slack in English and the extra characters fit in it.
  { name: 'phone-390x844-de',  width: 390,  height: 844,  locale: 'de' },
  { name: 'narrow-360x640-de', width: 360,  height: 640,  locale: 'de' },
  { name: 'phone-390x844-zh',  width: 390,  height: 844,  locale: 'zh' },
  { name: 'narrow-360x640-zh', width: 360,  height: 640,  locale: 'zh' },
] as const satisfies readonly { name: string; width: number; height: number; locale: Locale }[];

/** How long a tap hop waits for its label to appear before calling the stop unreachable. */
const TAP_WAIT_MS = 6_000;

/**
 * One navigation step. Either a callback on the current screen's bag (`state.<screen>Cb`) — the
 * name alone, or with the argument it needs — or a TAP on a label, for the things that are not
 * screens: a modal has no callback to call, so the only way in is the way a player gets in (see
 * lib/nwE2E.ts's `tapLabel`).
 */
type Hop =
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

const hopName = (h: Hop): string =>
  typeof h === 'string' ? h
    : 'tap' in h ? `tap(${h.tap})`
      : 'tapText' in h ? `tap("${h.tapText}")`
        : h.fn;

/** The literal, parameter-free prefix of a label in one locale — what `tapLabel` can match on. */
function label(locale: Locale, key: TranslationKey): string {
  const raw = DICTS[locale][key] ?? DICTS.zh[key] ?? key;
  return raw.split('{')[0]!.trim();
}

interface Stop {
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

const STOPS: Stop[] = [
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

const OUT_DIR = 'portrait-report';

/** Overlap thresholds — the only audit options that do not depend on the viewport. */
const OVERLAP = { minFrac: 0.12, minPx: 40 };


/** Short edge of both layouts' reference box, and the axis both fix. */
const REFERENCE_SHORT = 1080;
/** PortraitLayout's `REFERENCE_H` floor; LandscapeLayout's `REFERENCE_W` / `MAX_W` bounds. */
const PORTRAIT_MIN_LONG = 1920;
const LANDSCAPE_MIN_LONG = 1920;
const LANDSCAPE_MAX_LONG = 2592;

/**
 * The design rect `createLayout` will build for this viewport — the two layouts' own sizing rules,
 * duplicated rather than imported because those modules pull `@nw/engine/config` and PIXI into a
 * Playwright process with no DOM. Both fix their SHORT axis at 1080 and let the long one track the
 * aspect: portrait never shorter than 1920, landscape between 1920 and 2592 (past which it
 * letterboxes on purpose — see LandscapeLayout's MAX_W).
 */
function designBox(vp: { width: number; height: number }): { w: number; h: number } {
  if (vp.width > vp.height) {
    const long = Math.round(REFERENCE_SHORT * (vp.width / vp.height));
    return { w: Math.min(LANDSCAPE_MAX_LONG, Math.max(LANDSCAPE_MIN_LONG, long)), h: REFERENCE_SHORT };
  }
  const long = Math.round(REFERENCE_SHORT * (vp.height / vp.width));
  return { w: REFERENCE_SHORT, h: Math.max(PORTRAIT_MIN_LONG, long) };
}

/** The design→screen scale `ScalingManager` will contain this viewport at. */
function designScaleOf(vp: { width: number; height: number }): number {
  const box = designBox(vp);
  return Math.min(vp.width / box.w, vp.height / box.h);
}

/**
 * Audit options for one viewport. Everything is shared except the `tiny` gate, which is the
 * viewport's own legibility floor (render/fontScale.ts): the app lifts every font token to
 * `fontFloorDesignPx(scale)`, so nothing on screen may measure below it — 20 design px on either
 * phone, 16 on the tablet, against the flat 11 (`FS.micro`, the raw table's smallest entry) this
 * gate used before the floor existed.
 *
 * Deriving it from the shipped function rather than restating a number is what makes this a gate
 * on the floor rather than a second opinion about it: re-tune `MIN_LEGIBLE_CSS_PX` and the sweep
 * demands the new floor on the next run.
 */
function auditFor(vp: { width: number; height: number }): AuditOptions {
  const box = designBox(vp);
  return {
    ...OVERLAP,
    designW: box.w,
    designH: box.h,
    minInkDesignPx: fontFloorDesignPx(designScaleOf(vp)),
  };
}

interface Report {
  viewport: string;
  screen: string;
  labels: number;
  /**
   * The callback names this screen exposes (`state.<screen>Cb`). Recorded because they ARE the
   * navigation graph: every deeper screen this sweep can grow into is one of these names, and
   * reading them out of a report beats grepping the scene's callback interface by hand.
   */
  cbKeys: string[];
  findings: AuditFinding[];
}

/** One line per finding, short enough to read in a terminal failure. */
function fmt(viewport: string, screen: string, f: AuditFinding): string {
  const r = (x: { x: number; y: number; w: number; h: number }): string =>
    `(${Math.round(x.x)},${Math.round(x.y)} ${Math.round(x.w)}x${Math.round(x.h)})`;
  const where = `${viewport} ${screen}`;
  if (f.kind === 'offscreen') return `${where}: offscreen "${f.a}" ${r(f.rectA)}`;
  if (f.kind === 'tiny') return `${where}: unreadable "${f.a}" ${f.frac}px ${f.b} ${r(f.rectA)}`;
  if (f.kind === 'placeholder') return `${where}: placeholder text "${f.a}" ${r(f.rectA)}`;
  if (f.kind === 'covered') {
    return `${where}: covered ${Math.round(f.frac * 100)}% "${f.a}" ${r(f.rectA)} by ${r(f.rectB)}`;
  }
  if (f.kind === 'overflow') return `${where}: overflow "${f.a}" ${r(f.rectA)} out of its box ${r(f.rectB)}`;
  return `${where}: overlap ${Math.round(f.frac * 100)}% "${f.a}" ${r(f.rectA)} x "${f.b}" ${r(f.rectB)}`;
}

/**
 * Walks one stop's `via` chain from the lobby, clearing the first-time feature guide that sits in
 * front of most entries on a fresh account (ONBOARDING_DESIGN §4.1) — it is shown INSTEAD of
 * navigating, so the entry has to be tapped again after it. Returns the screen finally reached, or
 * null if a hop is not wired (gated feature) or never lands.
 */
async function open(page: Page, stop: Stop, locale: Locale): Promise<string | null> {
  let from = await currentScreen(page);
  for (const hop of stop.via) {
    if (typeof hop === 'object' && ('tap' in hop || 'tapText' in hop)) {
      // A tap opens a modal (or a tab) on the SAME screen, so there is no screen change to wait
      // for — settle, re-read whatever `state.screen` says, and let the audit judge what is now on
      // top of it. A label that isn't there is a navigation failure like any other.
      //
      // A tab CAN navigate, though (the family tab hands straight off to the family hub once the
      // player has a family), so the re-read matters: `state.screen` after the settle is the answer
      // either way.
      const text = 'tap' in hop ? label(locale, hop.tap) : hop.tapText;
      // Polled rather than tapped once (2026-09-12). A tap hop that follows a navigation hop fires
      // the instant `state.screen` changes — which, for a list the server fills in (the mail list),
      // is before any row exists. `friends+mailRead` was recorded as an unreachable stop for a whole
      // round because of it, while the screenshot of the stop before it showed the very label this
      // was looking for. Modals inside a scene are built synchronously and hit on the first pass, so
      // this costs them nothing.
      const deadline = Date.now() + TAP_WAIT_MS;
      let tapped = await tapLabel(page, text);
      while (!tapped && Date.now() < deadline) {
        await page.waitForTimeout(250);
        tapped = await tapLabel(page, text);
      }
      if (!tapped) return null;
      await page.waitForTimeout(800);
      from = await currentScreen(page);
      continue;
    }
    const fn = typeof hop === 'string' ? hop : hop.fn;
    const args = typeof hop === 'string' ? [] : hop.args ?? [];
    const bag = `${from}Cb`;
    if (!await callCb(page, bag, fn, args)) return null;
    if (typeof hop === 'object' && hop.stay) {
      // Deliberately no screen change: an overlay mounted on `app.stage`, or a loader the next hop
      // depends on. `callCb` has already awaited whatever it returned.
      from = await currentScreen(page);
      continue;
    }
    const deadline = Date.now() + 10_000;
    let landed: string | null = null;
    while (Date.now() < deadline) {
      const now = await currentScreen(page);
      if (now !== from) { landed = now; break; }
      if (await dismissFeatureGuide(page)) await callCb(page, bag, fn, args);
      await page.waitForTimeout(200);
    }
    if (landed === null) return null;
    from = landed;
  }
  return from;
}

/** What the page thinks it is showing — the readable half of a navigation failure. */
async function whereAmI(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = window.__nwE2E?.state ?? {};
    const cbs = Object.keys(s).filter((k) => k.endsWith('Cb')).join(',');
    return `screen=${s.screen} cbs=[${cbs}]`;
  });
}

/** Back to the lobby by whichever exit each scene offers, unwinding however deep the stop went. */
async function backToLobby(page: Page): Promise<void> {
  for (let depth = 0; depth < 4; depth++) {
    const screen = await currentScreen(page);
    if (screen === 'lobby') return;
    let moved = false;
    for (const fn of ['onBack', 'onExit', 'onClose', 'onExitToLobby']) {
      if (!await callCb(page, `${screen}Cb`, fn)) continue;
      try {
        await page.waitForFunction(
          (s: string) => window.__nwE2E?.state?.screen !== s, screen, { timeout: 5_000 },
        );
        moved = true;
        break;
      } catch { /* try the next exit name */ }
    }
    if (!moved) break;
  }
  if (await currentScreen(page) !== 'lobby') {
    // The session is persisted, so a reload lands straight back in the lobby.
    await page.reload();
    await screenIs(page, 'lobby', 20_000);
  }
}

test.describe('layout sweep — real renderer', () => {
  for (const vp of VIEWPORTS) {
    test(`no label collisions on ${vp.name}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        // Phones are HiDPI, and `bake()` rasterizes at the renderer resolution — at dpr 1 the
        // audit would be measuring glyphs no player ever sees.
        deviceScaleFactor: 2,
      });
      // The player's saved language, read once at boot by `initI18n` (src/i18n/index.ts) and ahead
      // of any scene being built — so it has to be in place before the first navigation, not set
      // through the settings screen afterwards. Without this every run took Chromium's own en-US
      // and the German and Chinese rows of the matrix would have been three copies of the English
      // one.
      await ctx.addInitScript(
        (loc: string) => { try { localStorage.setItem('nw_locale', loc); } catch { /* private mode */ } },
        vp.locale,
      );
      const page = await ctx.newPage();
      const errors = trackErrors(page);
      const shotDir = path.join(OUT_DIR, vp.name);
      fs.mkdirSync(shotDir, { recursive: true });

      const reports: Report[] = [];
      const skipped: string[] = [];
      /** Screens that painted no label at all — audited, but the audit saw nothing to judge. */
      const blank: string[] = [];
      try {
        await registerAndEnterLobby(page, uid('portrait'), 'Portrait');

        // ── Give the account something to render ──────────────────────────────────────────────
        // Everything below this line is why the sweep is worth running: an empty leaderboard, an
        // empty inbox and an empty market cannot break a layout, and for two rounds that is most of
        // what it was measuring. See lib/seed.ts.
        //
        // Two phases, because the SLG half needs a `PlayerWorldDoc` and only `joinWorld` may create
        // one — which happens the first time this account opens the world map. So: seed the account,
        // walk to the map once, seed the world on top of what joinWorld allocated.
        const target: SeedTarget = await seedAccount(page);
        await page.reload();
        await screenIs(page, 'lobby', 30_000);
        if (await open(page, { screen: 'worldMap', via: ['onOpenWorld'] }, vp.locale) === null) {
          throw new Error('seed: could not reach the world map, so joinWorld never ran');
        }
        await page.waitForTimeout(2_500);
        await backToLobby(page);
        await seedWorld(page, target);   // reloads
        await screenIs(page, 'lobby', 30_000);

        const audit = async (screen: string): Promise<void> => {
          const opts = auditFor(vp);
          let res: AuditResult = await page.evaluate(auditLayout, opts);
          if (res.labels === 0) {
            // Still painting its loading state (the world map streams tiles before anything else).
            await page.waitForTimeout(2_000);
            res = await page.evaluate(auditLayout, opts);
          }
          if (res.labels === 0) blank.push(screen);
          // Off the LIVE screen name, not the report's: a modal stop reports under its own name
          // (`Stop.as`) while the callback bag still belongs to the scene underneath.
          const cbKeys = await page.evaluate(() => {
            const st = window.__nwE2E?.state;
            const bag = st?.[`${st?.screen}Cb`];
            return bag && typeof bag === 'object' ? Object.keys(bag) : [];
          });
          reports.push({ viewport: vp.name, screen, labels: res.labels, cbKeys, findings: res.findings });
          await page.screenshot({ path: path.join(shotDir, `${screen}.png`) });
        };

        await page.waitForTimeout(600);
        await audit('lobby');

        for (const stop of STOPS) {
          const landed = await open(page, stop, vp.locale);
          if (landed === null) {
            expect(
              stop.gated,
              `${vp.name}: ${stop.via.map(hopName).join(' > ')} ` +
              `did not reach ${stop.screen} — ${await whereAmI(page)}`,
            ).toBe(true);
            skipped.push(stop.as ?? stop.screen);
            await backToLobby(page);
            continue;
          }
          await page.waitForTimeout(stop.settleMs ?? 400);
          await audit(stop.as ?? landed);
          if (stop.reloadAfter) {
            await page.reload();
            await screenIs(page, 'lobby', 30_000);
          } else {
            await backToLobby(page);
          }
        }
      } finally {
        fs.writeFileSync(
          path.join(OUT_DIR, `report-${vp.name}.json`),
          JSON.stringify({ viewport: vp.name, skipped, blank, reports }, null, 2),
        );
        await ctx.close();
      }

      // A screen with no labels was not judged — say so rather than counting it as clean.
      expect(blank, `${vp.name}: no labels found on ${blank.join(', ')}`).toEqual([]);
      const lines = reports.flatMap((r) => r.findings.map((f) => fmt(r.viewport, r.screen, f)));
      expect(lines, `${lines.length} portrait layout finding(s):\n${lines.join('\n')}`).toEqual([]);
      // Uncaught exceptions only. Console errors are smoke.spec.ts's gate and cannot be one here:
      // this config serves the client from :9097 against a stack on :8088, so every request is
      // cross-origin and nginx's /health (which the client polls) answers without CORS headers.
      // That noise is a property of the split-origin test setup, not of the build.
      const crashes = errors.filter((e) => e.startsWith('[pageerror]'));
      expect(crashes, crashes.join('\n')).toEqual([]);
    });
  }
});

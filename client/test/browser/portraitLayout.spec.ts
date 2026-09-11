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
const VIEWPORTS = [
  { name: 'phone-390x844',    width: 390,  height: 844  },
  { name: 'narrow-360x640',   width: 360,  height: 640  },
  { name: 'tablet-768x1024',  width: 768,  height: 1024 },
  { name: 'landscape-844x390',width: 844,  height: 390  },
  { name: 'tablet-1024x768',  width: 1024, height: 768  },
  { name: 'desktop-1366x768', width: 1366, height: 768  },
] as const;

/**
 * One navigation step. Either a callback on the current screen's bag (`state.<screen>Cb`) — the
 * name alone, or with the argument it needs — or a TAP on a label, for the things that are not
 * screens: a modal has no callback to call, so the only way in is the way a player gets in (see
 * lib/nwE2E.ts's `tapLabel`).
 */
type Hop = string | { fn: string; args: unknown[] } | { tap: string };

const hopName = (h: Hop): string =>
  typeof h === 'string' ? h : 'tap' in h ? `tap(${h.tap})` : h.fn;

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
}

/**
 * Where the sweep goes. The one-hop list is the lobby's own nav; the two-hop ones are the screens
 * behind it, and their callback names come from the `cbKeys` each report records — that is the
 * cheapest way to extend this list, rather than reading every scene's callback interface.
 */
/** One side's end-of-match stats — `PlayerStats` (server/engine/src/types/runtime.ts). */
function endStats(owner: number, dealt: number, taken: number): Record<string, unknown> {
  return {
    owner,
    damageDealtToBase: dealt,
    damageTakenByBase: taken,
    unitsSent: 24,
    unitsKilled: 17,
    spellHits: 6,
    killsByType: {},
    castsByType: {},
    buildingSurvivalTicks: 5400,
    goldSpent: 310,
  };
}

const STOPS: Stop[] = [
  { screen: 'settings',     via: ['onOpenProfile'] },
  { screen: 'shop',         via: ['onOpenShop'],        settleMs: 800 },
  { screen: 'cardRoster',   via: ['onOpenCards'],       settleMs: 800 },
  { screen: 'stats',        via: ['onOpenStats'] },
  { screen: 'campaignMap',  via: ['onOpenCampaign'],    settleMs: 800 },
  { screen: 'daily',        via: ['onOpenDaily'],       gated: true, settleMs: 800 },
  { screen: 'events',       via: ['onOpenEvents'],      gated: true, settleMs: 800 },
  { screen: 'leaderboard',  via: ['onOpenLeaderboard'], gated: true, settleMs: 800 },
  { screen: 'friends',      via: ['onOpenSocial'],      gated: true, settleMs: 800 },
  { screen: 'room',         via: ['onOpenRoom'],        gated: true, settleMs: 800 },
  { screen: 'recharge',     via: ['onOpenRecharge'],    gated: true, settleMs: 800 },
  { screen: 'achievements', via: ['onOpenAchievements'],gated: true, settleMs: 800 },
  { screen: 'auction',      via: ['onOpenAuction'],     gated: true, settleMs: 800 },
  { screen: 'titles',       via: ['onOpenStats', 'onOpenTitles'] },
  { screen: 'cardCodex',    via: ['onOpenStats', 'onOpenCodex'], settleMs: 800 },
  { screen: 'equipment',    via: ['onOpenCampaign', 'onOpenEquipment'], settleMs: 800 },
  // `ch1_lv1` is chapter one's first node (game/campaign/maps/ch1.json) — the only hop in this
  // table that takes an argument, since level entry is per-node rather than a single nav slot.
  { screen: 'levelPrep',    via: ['onOpenCampaign', { fn: 'onSelectLevel', args: ['ch1_lv1'] }], settleMs: 800 },
  { screen: 'worldMap',     via: ['onOpenWorld'],       gated: true, settleMs: 2000 },
  { screen: 'city',         via: ['onOpenWorld', 'onOpenCity'],    gated: true, settleMs: 2000 },
  { screen: 'chat',         via: ['onOpenWorld', 'onOpenChat'],    gated: true, settleMs: 1500 },
  // 'base' = the home city's own defense layout; `onOpenDefense(tileKey)` takes the tile it edits,
  // and calling it bare puts a literal "undefined" in the scene title.
  { screen: 'defenseEditor',via: ['onOpenWorld', { fn: 'onOpenDefense', args: ['base'] }], gated: true, settleMs: 1500 },

  // ── 2026-09-11, round two: the rest of what the `cbKeys` graph offers ────────────────────────
  { screen: 'mail',        via: ['onOpenMail'],     gated: true, settleMs: 900 },
  { screen: 'feedback',    via: ['onOpenFeedback'], gated: true, settleMs: 900 },
  // Reached through the store rather than the lobby: `openBattlePass` is on the gacha screen's bag
  // (and the shop's), never the lobby's.
  { screen: 'battlePass',  via: ['onOpenShop', 'openBattlePass'], gated: true, settleMs: 900 },
  { screen: 'family',      via: ['onOpenSocial', 'openFamilyHub'], gated: true, settleMs: 1500 },
  { screen: 'sect',        via: ['onOpenSocial', 'openSectHub'],   gated: true, settleMs: 1500 },

  // The battle, and the screen behind it. This is the one stop that leaves the menu shell: the HUD
  // is laid out by ILayout directly (not by a scene's own column arithmetic), so it is the one
  // place portrait can break in a way no menu screen would show.
  { screen: 'game',        via: [{ fn: 'onStartGame', args: ['AI'] }], settleMs: 3000 },
  // ...and the screen behind it. Handed the end-of-match payload the game scene's own renderer
  // would hand it (`onGameEnd(winner, [stats, stats])`), rather than played out: an AI match takes
  // minutes, and what this stop audits is the layout of a screen full of numbers — which does not
  // care where the numbers came from, only that they are the shape ResultScene reads.
  { screen: 'result',
    via: [{ fn: 'onStartGame', args: ['AI'] }, { fn: 'onGameEnd', args: [0, [
      endStats(0, 5200, 1400), endStats(1, 1400, 5200),
    ]] }],
    settleMs: 1500 },

  // ── Modals, tabs and results: the states that are not screens ───────────────────────────────
  // Every one of these is opened by a hit rect inside a scene, so there is no callback for the
  // sweep to call and `state.screen` does not change — see `Hop`'s tap form and `Stop.as`.
  //
  // Tapped by a UI string rather than a content name wherever possible ('Power' is the roster
  // cell's own stat label, inside the cell's hit rect), so the table does not depend on which
  // heroes a fresh account happens to start with.
  { screen: 'cardRoster',  as: 'cardRoster+detail', via: ['onOpenCards', { tap: 'Power' }], settleMs: 1200 },
  { screen: 'equipment',   as: 'equipment+craft',
    via: ['onOpenCampaign', 'onOpenEquipment', { tap: 'Craft' }], settleMs: 1200 },
  { screen: 'gacha',       as: 'gacha+draw',        via: ['onOpenShop', { tap: 'Single' }],
    gated: true, settleMs: 3000 },
  { screen: 'city',        as: 'city+buildDetail',
    via: ['onOpenWorld', 'onOpenCity', { tap: 'Desk' }], gated: true, settleMs: 2000 },
  { screen: 'city',        as: 'city+trainModal',
    via: ['onOpenWorld', 'onOpenCity', { tap: 'Train Troops' }], gated: true, settleMs: 2000 },
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
async function open(page: Page, stop: Stop): Promise<string | null> {
  let from = await currentScreen(page);
  for (const hop of stop.via) {
    if (typeof hop === 'object' && 'tap' in hop) {
      // A tap opens a modal (or a tab) on the SAME screen, so there is no screen change to wait
      // for — settle, re-read whatever `state.screen` says, and let the audit judge what is now on
      // top of it. A label that isn't there is a navigation failure like any other.
      if (!await tapLabel(page, hop.tap)) return null;
      await page.waitForTimeout(600);
      from = await currentScreen(page);
      continue;
    }
    const fn = typeof hop === 'string' ? hop : hop.fn;
    const args = typeof hop === 'string' ? [] : hop.args;
    const bag = `${from}Cb`;
    if (!await callCb(page, bag, fn, args)) return null;
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
          const landed = await open(page, stop);
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
          await backToLobby(page);
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

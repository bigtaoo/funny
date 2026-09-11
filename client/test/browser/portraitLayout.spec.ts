// Portrait layout sweep — walks the lobby-reachable screens on three portrait viewports in a real
// browser, and fails on labels that collide or fall off the canvas.
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
} from './lib/nwE2E';
import { auditLayout, type AuditFinding, type AuditResult } from './lib/layoutAudit';

/**
 * The three shapes portrait has to survive, per the 2026-09-11 sweep scope:
 * a current iPhone, the squeeze case (a 16:9 budget Android / the WeChat mini-game floor), and a
 * tablet — squatter than 9:16, so `ScalingManager` letterboxes it into desk bands and the layout
 * runs a different path (see its DESK_FILL header).
 */
const VIEWPORTS = [
  { name: 'phone-390x844',   width: 390, height: 844  },
  { name: 'narrow-360x640',  width: 360, height: 640  },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
] as const;

/** One navigation step: a callback name on the current screen's bag, plus any argument it needs. */
type Hop = string | { fn: string; args: unknown[] };

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
];

const OUT_DIR = 'portrait-report';

/**
 * `designW`/`designH` are PortraitLayout's own reference box (its `DESIGN_W` / `REFERENCE_H`);
 * `minInkDesignPx` is `FS.micro`, the smallest size the font scale offers (render/fontScale.ts).
 * Both are duplicated rather than imported: this file runs in Node under Playwright, and importing
 * either module drags `pixi.js-legacy` into a process with no DOM.
 */
const AUDIT = { minFrac: 0.12, minPx: 40, designW: 1080, designH: 1920, minInkDesignPx: 11 };

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
  if (f.kind === 'tiny') return `${where}: unreadable "${f.a}" ${r(f.rectA)}`;
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

test.describe('portrait layout — real renderer', () => {
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
          let res: AuditResult = await page.evaluate(auditLayout, AUDIT);
          if (res.labels === 0) {
            // Still painting its loading state (the world map streams tiles before anything else).
            await page.waitForTimeout(2_000);
            res = await page.evaluate(auditLayout, AUDIT);
          }
          if (res.labels === 0) blank.push(screen);
          const cbKeys = await page.evaluate((s: string) => {
            const bag = window.__nwE2E?.state?.[`${s}Cb`];
            return bag && typeof bag === 'object' ? Object.keys(bag) : [];
          }, screen);
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
              `${vp.name}: ${stop.via.map((h) => (typeof h === 'string' ? h : h.fn)).join(' > ')} ` +
              `did not reach ${stop.screen} — ${await whereAmI(page)}`,
            ).toBe(true);
            skipped.push(stop.screen);
            await backToLobby(page);
            continue;
          }
          await page.waitForTimeout(stop.settleMs ?? 400);
          await audit(landed);
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

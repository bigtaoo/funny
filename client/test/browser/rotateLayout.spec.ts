// Rotation sweep — walk to a screen, TURN THE PHONE, and check what the player is looking at now.
//
// `portraitLayout.spec.ts` navigates to each stop at a fixed viewport. That is the shape the client
// was built for until 2026-09-14: outside the lobby, a viewport change re-fitted the canvas and
// nothing else, so a screen entered in portrait stayed laid out for portrait forever and there was
// nothing for a rotation to audit. Since `app/sceneMounts.ts`, a settled viewport change rebuilds
// whatever is on screen — and that is a code path no existing test reaches in a real browser.
//
// Two things are asserted, and they are not the same thing:
//
//   1. **You are still where you were.** Universal, every stop. The rebuild target is resolved from
//      one field ("how do we put the CURRENT screen back"), so a screen that never claimed it
//      inherits the PREVIOUS one's — and rotating then rebuilds that one on top of this one, i.e.
//      the player is sent back a page by turning their phone. `test/sceneMountRouting.test.ts`
//      gates that statically against the source; this is the same claim against a real renderer,
//      a real backend and a real resize event.
//   2. **The new shape is laid out for the new shape.** Only for MAIN_STOPS (see below), because
//      not every screen is rebuilt on purpose — a live match, the SLG map and the panels overlaid
//      on it keep the layout they were entered with by design (SceneMounts' `volatile()`), and
//      auditing those after a rotation would be asserting the opposite of the intent.
//
// Everything else — the walk, the stop table, the audit, the design box — is shared with the
// portrait sweep, so a stop added there is rotated here for free.
//
// Prereq: a backend, same as portraitLayout.spec.ts — `./docker/local-up.ps1` from the repo root.
// Run: npm run test:portrait -- --grep rotation     (or the whole config)
//      NW_ROTATE_ALL=1 npm run test:portrait -- --grep rotation   walks every stop, not just the
//      main ones, and reports (without failing) what the un-rebuilt screens look like afterwards.

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { uid, trackErrors, screenIs, currentScreen, registerAndEnterLobby } from './lib/nwE2E';
import { open, backToLobby, whereAmI, type Locale } from './lib/walk';
import { seedAccount, seedWorld, type SeedTarget } from './lib/seed';
import { auditLayout, type AuditFinding, type AuditResult } from '../../src/testing/layoutAudit';
import { auditFor, fmt } from './lib/auditBox';
import { STOPS, hopName } from '../../src/testing/layoutStops';

/**
 * One phone, rotated. Not the full VIEWPORTS matrix of the portrait sweep: this spec is not looking
 * for shape-specific defects (that one already covers every shape, in three languages) — it is
 * looking for whether the rebuild happens and lands right, which is one code path and does not vary
 * per device. 390x844 is the current iPhone, i.e. the report that started this.
 */
const PORTRAIT = { width: 390, height: 844 } as const;
const LANDSCAPE = { width: 844, height: 390 } as const;
const LOCALE: Locale = 'en';

const OUT_DIR = 'portrait-report';
const REPORT = path.join(OUT_DIR, 'report-rotation.json');

/**
 * The screens whose post-rotation layout is ASSERTED, rather than merely recorded.
 *
 * Deliberately a short, hand-picked list rather than "every rebuildable stop": these are the ones a
 * player reaches from the lobby in one or two taps and spends real time on, and each is a plain
 * `mounts.mount` with no host underneath it. The rest of the table still gets walked and rotated
 * (assertion 1 applies to all of it) and its findings land in the report — promoting one here is a
 * one-line edit once someone has looked at its screenshot.
 *
 * The first two rows are both "the shop", which is the screen the bug was reported on, and it takes
 * both to cover it: the lobby's Store slot opens the GACHA scene in a shop group
 * (LOBBY_IA_REDESIGN — `nav.goGacha({shopBack})`, which is why the stop named `shop` reports as
 * `gacha`), and ShopScene itself is what the lobby's coins entry lands on (`goShop(…, 'coins')`,
 * the stop named `recharge`). Same quirk the portrait sweep has always had; named here so the next
 * reader does not assume `shop` means ShopScene.
 */
const MAIN_STOPS = new Set([
  'shop', 'recharge', 'settings', 'cardRoster', 'stats', 'campaignMap',
  'equipment', 'levelPrep', 'titles', 'cardCodex', 'result',
]);

/** Walk the whole stop table instead of just the main screens (see the file header). */
const ROTATE_ALL = process.env.NW_ROTATE_ALL === '1';

/**
 * Long enough for the rebuild to have happened and been painted.
 *
 * Two waits in one: `REBUILD_COALESCE_MS` (180ms, app/viewportResize.ts) swallows the burst of
 * resize events a rotation produces, and then the menu scenes are `paint: 'reactive'`
 * (render/renderPolicy.ts) so the canvas is not guaranteed to repaint on the very next frame. A
 * 2-second wait during hand-verification read as "the fix did not work" for exactly this reason.
 */
const SETTLE_AFTER_ROTATE_MS = 1_200;

interface RotationReport {
  screen: string;
  /** Whether this stop's post-rotation layout is asserted or only recorded. */
  asserted: boolean;
  screenBefore: string;
  screenAfter: string;
  labelsPortrait: number;
  labelsLandscape: number;
  findingsLandscape: AuditFinding[];
  /** Findings after rotating BACK — a rebuild has to be reversible, not just one-way. */
  findingsBack: AuditFinding[];
  /** Uncaught exceptions thrown while this stop was on screen, with stacks. */
  crashes: string[];
}

test.describe('rotation sweep — real renderer', () => {
  test('every screen survives a rotation, and the main ones re-lay out for it', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { ...PORTRAIT },
      // Phones are HiDPI and `bake()` rasterizes at the renderer resolution — at dpr 1 the audit
      // would be measuring glyphs no player ever sees. Same reasoning as the portrait sweep.
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript(
      (loc: string) => { try { localStorage.setItem('nw_locale', loc); } catch { /* private mode */ } },
      LOCALE,
    );
    const page = await ctx.newPage();
    const errors = trackErrors(page);
    // A second listener, for the stack. `trackErrors` keeps only `err.message`, which is the right
    // amount for a sweep that just needs to say "something threw" — but the thing this spec is most
    // likely to catch is a scene throwing DURING a rotation, and "Cannot read properties of
    // undefined" without a frame is a two-hour bisect. Drained per stop, so each crash is also
    // attributed to the screen that was on the display when it happened.
    let pending: string[] = [];
    page.on('pageerror', (err: Error) => pending.push(err.stack ?? err.message));
    const drainCrashes = (): string[] => { const c = pending; pending = []; return c; };
    const shotDir = path.join(OUT_DIR, 'rotation');
    fs.mkdirSync(shotDir, { recursive: true });

    const reports: RotationReport[] = [];
    const skipped: string[] = [];
    /** Stops where the rotation moved the player somewhere else — the failure this spec exists for. */
    const yanked: string[] = [];

    const rotateTo = async (vp: { width: number; height: number }): Promise<void> => {
      await page.setViewportSize({ ...vp });
      await page.waitForTimeout(SETTLE_AFTER_ROTATE_MS);
    };

    const auditAt = async (vp: { width: number; height: number }): Promise<AuditResult> => {
      const opts = auditFor(vp);
      let res: AuditResult = await page.evaluate(auditLayout, opts);
      if (res.labels === 0) {
        await page.waitForTimeout(2_000);
        res = await page.evaluate(auditLayout, opts);
      }
      return res;
    };

    try {
      await registerAndEnterLobby(page, uid('rotate'), 'Rotate');
      const target: SeedTarget = await seedAccount(page);
      await page.reload();
      await screenIs(page, 'lobby', 30_000);
      if (ROTATE_ALL) {
        // The SLG half needs a PlayerWorldDoc, and only joinWorld may create one — which happens
        // the first time this account opens the map. Same two-phase seed as the portrait sweep;
        // skipped in the default run because none of MAIN_STOPS is behind the world map.
        if (await open(page, { screen: 'worldMap', via: ['onOpenWorld'] }, LOCALE) === null) {
          throw new Error('seed: could not reach the world map, so joinWorld never ran');
        }
        await page.waitForTimeout(2_500);
        await backToLobby(page);
        await seedWorld(page, target);
        await screenIs(page, 'lobby', 30_000);
      }

      // The lobby itself first — the one screen that already rebuilt on rotation before this
      // change, so it is the control: if this row is red, the regression is in the old path.
      await page.waitForTimeout(600);
      const walk = ROTATE_ALL ? STOPS : STOPS.filter((s) => MAIN_STOPS.has(s.as ?? s.screen));
      for (const stop of [null, ...walk] as const) {
        const name = stop === null ? 'lobby' : (stop.as ?? stop.screen);
        if (stop !== null) {
          const landed = await open(page, stop, LOCALE);
          if (landed === null) {
            expect(
              stop.gated,
              `${stop.via.map(hopName).join(' > ')} did not reach ${stop.screen} — ${await whereAmI(page)}`,
            ).toBe(true);
            skipped.push(name);
            await backToLobby(page);
            continue;
          }
          await page.waitForTimeout(stop.settleMs ?? 400);
        }

        const screenBefore = await currentScreen(page);
        const portrait = await auditAt(PORTRAIT);

        await rotateTo(LANDSCAPE);
        const screenAfter = await currentScreen(page);
        const landscape = await auditAt(LANDSCAPE);
        await page.screenshot({ path: path.join(shotDir, `${name}-landscape.png`) });

        // ...and back, because a rebuild has to be reversible. The first hand-verification of this
        // change found portrait→landscape working and only then checked the return trip.
        await rotateTo(PORTRAIT);
        const back = await auditAt(PORTRAIT);
        await page.screenshot({ path: path.join(shotDir, `${name}-portrait.png`) });

        if (screenAfter !== screenBefore) yanked.push(`${name}: rotated into "${screenAfter}"`);
        const crashes = drainCrashes();
        reports.push({
          crashes,
          screen: name,
          asserted: name === 'lobby' || MAIN_STOPS.has(name),
          screenBefore,
          screenAfter,
          labelsPortrait: portrait.labels,
          labelsLandscape: landscape.labels,
          findingsLandscape: landscape.findings,
          findingsBack: back.findings,
        });

        if (stop !== null) {
          if (stop.reloadAfter) {
            await page.reload();
            await screenIs(page, 'lobby', 30_000);
          } else {
            await backToLobby(page);
          }
        }
      }
    } finally {
      fs.writeFileSync(REPORT, JSON.stringify({ rotateAll: ROTATE_ALL, skipped, yanked, reports }, null, 2));
      await ctx.close();
    }

    // ── 1. Universal: turning the phone must not navigate ────────────────────────────────────
    expect(yanked, `rotation changed the screen:\n${yanked.join('\n')}`).toEqual([]);

    // ── 2. Main screens: the new shape is laid out for the new shape ─────────────────────────
    const asserted = reports.filter((r) => r.asserted);
    expect(asserted.length, 'no main stop was reached — the walk is broken, not clean').toBeGreaterThan(3);
    // A screen that painted nothing was not judged; say so rather than counting it as clean.
    const blank = asserted.filter((r) => r.labelsLandscape === 0).map((r) => r.screen);
    expect(blank, `no labels after rotating: ${blank.join(', ')}`).toEqual([]);
    const lines = asserted.flatMap((r) => [
      ...r.findingsLandscape.map((f) => fmt('rotated-landscape', r.screen, f)),
      ...r.findingsBack.map((f) => fmt('rotated-back-portrait', r.screen, f)),
    ]);
    expect(lines, `${lines.length} rotation layout finding(s):\n${lines.join('\n')}`).toEqual([]);

    // Attributed, so the failure names the screen that threw rather than the count. `errors` is
    // still the source of truth for whether anything threw at all — including during navigation
    // between stops, which `crashes` cannot see.
    const thrown = reports
      .filter((r) => r.crashes.length > 0)
      .map((r) => `${r.screen} (${r.crashes.length}x):\n${r.crashes[0]}`);
    expect(thrown, `screens that threw while being rotated:\n${thrown.join('\n\n')}`).toEqual([]);
    const stray = errors.filter((e) => e.startsWith('[pageerror]'));
    expect(stray, stray.join('\n')).toEqual([]);
  });
});

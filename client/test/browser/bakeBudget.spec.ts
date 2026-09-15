// What the bake cache costs a whole session — measured, on a real renderer, at two real geometries.
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────────
// `render/bake.ts` never evicts (deliberately: destroying a texture a live scene still holds draws
// garbage — see its header and ADR-073). So its size is not a leak to watch climb, it is a CEILING:
// one texture per distinct (key, resolution), reached as the player opens screens, and then flat
// forever. That makes it the one memory number in this client that can be measured exactly rather
// than sampled — walk every screen once and you have the worst case for that device.
//
// Which matters because nothing else can see it. `MemoryMonitor`'s byte gate scans
// `PIXI.utils.BaseTextureCache`, and `PIXI.RenderTexture.create()` never registers there; the heap
// gate cannot see GPU bytes at all. The 2026-08-25 crash was exactly this cache (three page layers
// at 111 MB each killed a WKWebView on the first lobby paint) and every channel was blind to it.
// `MemoryMonitor`'s fourth gate now has a budget for it — and this is where that budget's number
// comes from. A guess would have been the alternative, on a cache whose history is two order-of-
// magnitude surprises in a row.
//
// ── What it measures ──────────────────────────────────────────────────────────────────────────────
// The union of bake KEYS over a walk of `layoutStops.STOPS`, not the running total. The walk has to
// reload the page occasionally (some stops leave no way back), and a reload destroys the renderer
// and the whole cache with it — so totals read afterwards are a fresh climb. Keys are reload-proof:
// the same screen at the same geometry always bakes the same key at the same size, so their union
// is what one uninterrupted session would be holding. That is `bakeEntries()`' whole reason to be.
//
// Skipped unless NW_BAKE=1, like captureEndStats/frameCost: it needs the local docker stack, seeds
// two fresh accounts, and spends several minutes per geometry.
//
//   Run: docker/local-up.ps1, then  NW_BAKE=1 npx playwright test --config playwright.portrait.config.ts bakeBudget
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { uid, screenIs, registerAndEnterLobby } from './lib/nwE2E';
import { open, backToLobby, whereAmI, type Locale } from './lib/walk';
import { seedAccount, seedWorld, type SeedTarget } from './lib/seed';
import { STOPS, hopName } from '../../src/testing/layoutStops';
// The number under test, from the module that ships it — not a copy of it. `memoryBudgets.ts` is
// PIXI-free precisely so this import works in a plain Playwright process.
import { DEFAULT_BAKE_BUDGET_SCREENS } from '../../src/cache/memoryBudgets';

const MiB = 1024 * 1024;
const OUT_DIR = 'bake-report';

/**
 * The two geometries worth the minutes.
 *
 * `desktop` reproduces the 2026-09-10 reference measurement (45 entries / 279 MiB, before
 * `paperBakeKey` collapsed the byte-identical page copies) so the two numbers are comparable and
 * the fix's effect is readable rather than asserted. `phone` is the budget's actual subject: an
 * iPhone 13 in portrait, the device class that has already died of this once.
 *
 * The phone row is declared at dpr **3** and measured at resolution 0.75, which is worth knowing:
 * `renderPolicy.MAX_RENDER_RESOLUTION` caps the backbuffer at 2 before `pageBakeResolution` ever
 * multiplies by `designScale` (2 x 0.361 -> 0.75 after the 1/16 rounding). ADR-073's phone
 * extrapolation assumed the raw dpr 3 and so predicted 12.2 MiB per page; the real figure on this
 * geometry is 5.4 MiB. Declaring 3 rather than 2 here is deliberate — it keeps that cap inside
 * what the measurement exercises.
 */
const CASES = [
  { name: 'desktop-1280x631', width: 1280, height: 631, dpr: 1.5, locale: 'en' },
  { name: 'phone-390x844',    width: 390,  height: 844, dpr: 3,   locale: 'en' },
] as const satisfies readonly {
  name: string; width: number; height: number; dpr: number; locale: Locale;
}[];

interface Entry { key: string; w: number; h: number; bytes: number }

/** Every bake entry the page is holding right now. */
async function entries(page: Page): Promise<Entry[]> {
  return page.evaluate(() => (window.__nwE2E?.bakeEntries?.() ?? []) as Entry[]);
}

const mb = (bytes: number): number => Math.round((bytes / MiB) * 10) / 10;

/** `paper:1080x1920:97` -> `paper`; a keyless bake (`lobbybg`) is its own family. */
const family = (key: string): string => key.split(':')[0]!;

test.describe('bake cache — the session ceiling', () => {
  for (const c of CASES) {
    test(`walking every screen on ${c.name}`, async ({ browser }) => {
      test.skip(process.env.NW_BAKE !== '1', 'needs the docker stack; run with NW_BAKE=1');

      const ctx = await browser.newContext({
        viewport: { width: c.width, height: c.height },
        deviceScaleFactor: c.dpr,
      });
      await ctx.addInitScript(
        (loc: string) => { try { localStorage.setItem('nw_locale', loc); } catch { /* private mode */ } },
        c.locale,
      );
      const page = await ctx.newPage();

      /** key -> entry. The union across the whole walk, immune to the reloads inside it. */
      const seen = new Map<string, Entry>();
      /** One row per stop: what it ADDED to that union. */
      const rows: { stop: string; added: string[]; addedMB: number; unionMB: number }[] = [];
      const skipped: string[] = [];
      /**
       * One backbuffer, in bytes — the unit the shipped budget is denominated in, read off the
       * live canvas so the number this test judges is the number `screenBytes()` would give the
       * gate. Sampled after the walk rather than before: the walk never resizes, and reading it at
       * the end means one failure mode fewer between here and the assertion.
       */
      let screenBytes = 0;
      /** The bake union in backbuffers — what the shipped gate would compute. */
      let screens = 0;

      const record = async (stop: string): Promise<void> => {
        const added: string[] = [];
        let addedBytes = 0;
        for (const e of await entries(page)) {
          if (seen.has(e.key)) continue;
          seen.set(e.key, e);
          added.push(`${e.key} ${e.w}x${e.h}`);
          addedBytes += e.bytes;
        }
        let union = 0;
        for (const e of seen.values()) union += e.bytes;
        rows.push({ stop, added, addedMB: mb(addedBytes), unionMB: mb(union) });
      };

      try {
        await registerAndEnterLobby(page, uid('bake'), 'Bake');
        // Same two-phase seed as the layout sweep: the SLG half needs a `PlayerWorldDoc`, and only
        // `joinWorld` may create one — which happens the first time this account opens the map.
        const target: SeedTarget = await seedAccount(page);
        await page.reload();
        await screenIs(page, 'lobby', 30_000);
        if (await open(page, { screen: 'worldMap', via: ['onOpenWorld'] }, c.locale) === null) {
          throw new Error('seed: could not reach the world map, so joinWorld never ran');
        }
        await page.waitForTimeout(2_500);
        await backToLobby(page);
        await seedWorld(page, target);   // reloads
        await screenIs(page, 'lobby', 30_000);

        await page.waitForTimeout(600);
        await record('lobby');

        for (const stop of STOPS) {
          const landed = await open(page, stop, c.locale);
          if (landed === null) {
            // A stop this account cannot reach bakes nothing, which is a fine outcome for a
            // measurement — but an UNEXPECTEDLY unreachable one means the walk stopped covering
            // part of the app, and a ceiling measured over half the screens is not a ceiling.
            expect(
              stop.gated,
              `${c.name}: ${stop.via.map(hopName).join(' > ')} did not reach ${stop.screen} — ` +
              `${await whereAmI(page)}`,
            ).toBe(true);
            skipped.push(stop.as ?? stop.screen);
            await backToLobby(page);
            continue;
          }
          await page.waitForTimeout(stop.settleMs ?? 400);
          await record(stop.as ?? landed);
          if (stop.reloadAfter) {
            await page.reload();
            await screenIs(page, 'lobby', 30_000);
          } else {
            await backToLobby(page);
          }
        }
      } finally {
        screenBytes = await page.evaluate(() => {
          const view = window.__nwE2E?.app?.view as { width?: number; height?: number } | undefined;
          return (view?.width ?? 0) * (view?.height ?? 0) * 4;
        }).catch(() => 0);
        const all = [...seen.values()].sort((a, b) => b.bytes - a.bytes);
        const byFamily = new Map<string, { n: number; bytes: number }>();
        for (const e of all) {
          const g = byFamily.get(family(e.key)) ?? { n: 0, bytes: 0 };
          g.n += 1;
          g.bytes += e.bytes;
          byFamily.set(family(e.key), g);
        }
        const totalBytes = all.reduce((s, e) => s + e.bytes, 0);
        const totalMB = mb(totalBytes);
        screens = screenBytes > 0 ? Math.round((totalBytes / screenBytes) * 10) / 10 : 0;
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(OUT_DIR, `${c.name}.json`),
          JSON.stringify({
            case: c,
            totalMB,
            screenMB: mb(screenBytes),
            screens,
            budgetScreens: DEFAULT_BAKE_BUDGET_SCREENS,
            entries: all.length,
            byFamily: [...byFamily.entries()]
              .sort((a, b) => b[1].bytes - a[1].bytes)
              .map(([k, g]) => ({ family: k, n: g.n, mb: mb(g.bytes) })),
            top: all.slice(0, 10).map((e) => ({ key: e.key, size: `${e.w}x${e.h}`, mb: mb(e.bytes) })),
            skipped,
            rows,
          }, null, 2),
        );
        // eslint-disable-next-line no-console
        console.log(
          `[bake] ${c.name}: ${all.length} entries / ${totalMB} MiB = ${screens} backbuffers ` +
          `(budget ${DEFAULT_BAKE_BUDGET_SCREENS}) over ${rows.length} stops\n` +
          [...byFamily.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
            .map(([k, g]) => `  ${k}: ${g.n} x = ${mb(g.bytes)} MiB`).join('\n'),
        );
        await ctx.close();
      }

      // The walk has to have baked SOMETHING, or every assertion below passes on an empty map —
      // which is exactly what a renamed `__nwE2E` handle or a canvas-fallback renderer would look
      // like. (`bake()` returns null with no renderer wired.)
      expect(seen.size, 'no bake entries at all — is this the web-e2e entry on a real WebGL context?')
        .toBeGreaterThan(5);

      // The shipped budget, in the unit it ships in. A client that walks every screen must stay
      // inside it, or the gate would fire on healthy sessions and teach everyone to ignore it.
      // Fails when a new full-page bake is added — deliberately: the static half of that guard
      // (`test/pageBakeCallSites.test.ts`) makes the author declare the new call site, and this
      // half prices it.
      expect(screens, `${c.name} bake ceiling, in backbuffers`)
        .toBeLessThan(DEFAULT_BAKE_BUDGET_SCREENS);
    });
  }
});

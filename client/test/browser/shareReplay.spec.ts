// Shared-replay landing page in a REAL renderer (claudedocs/client-testing.md 缺口B, sibling of
// smoke.spec.ts) — the only layer that can tell whether the `?r=<code>` page actually paints skinned,
// animated units and a HUD, because all three depend on assets (.tao rigs, ink PNGs) the headless
// suites stub out. Pins the 2026-08-26 fix set: a shared replay used to show unskinned, frozen units
// and no HUD at all (REPLAY_SHARE_DESIGN §4.2).
//
// Unlike smoke.spec.ts this needs NO backend: the share fetch (`GET {api}/r/<code>`) is intercepted and
// answered with a hand-built state stream. `unpackReplayBlob` accepts a plain object as well as the
// base64(gzip) production form, so the fixture can be inlined as JSON.
//
// Run: npm run test:browser   (opt-in, real browser).

import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * The slice of the test-only `window.__nwE2E` hook (entries/web-e2e.ts) this spec reads. Cast locally
 * rather than augmenting the global `Window`: smoke.spec.ts already augments it with a different
 * `state` type, and two augmentations of one property in the same program collide (it type-checks as
 * one program — see tsconfig.test.json).
 */
type E2EWindow = {
  __nwE2E?: { state?: { screen?: string }; app?: { stage: { children?: unknown[] } } };
};


const SHARE_CODE = 'testsharecode0000000000';

/**
 * Ten seconds of four lanes advancing on each other: infantry for owner 0, archers for owner 1 (the two
 * types the fixture's skins target), base HP dropping, ink counting up for one side and down for the
 * other. Written directly in the delta wire form — `u`/`bs`/`rs` per keyframe.
 *
 * `v2: false` produces a genuine schema-v1 stream (no skins, no ink) — the shape every already-shared
 * link still has — so the runs that use it double as the backward-compatibility check.
 */
function fixture(v2: boolean): unknown {
  const LANES = [1, 3, 8, 10];
  const frames: unknown[] = [];
  for (let i = 0; i <= 10; i++) {
    frames.push({
      tick: i * 30,
      u: LANES.flatMap((col, k) => [
        { id: 100 + k, type: 'infantry', side: 0, col, row: 2 + i * 0.9, hp: 100 - i * 4, maxHp: 100, state: 'moving' },
        { id: 200 + k, type: 'archer', side: 1, col, row: 15 - i * 0.9, hp: 60, maxHp: 60, state: 'moving' },
      ]),
      bs: [{ owner: 0, hp: 100 - i * 6, maxHp: 100 }, { owner: 1, hp: 100 - i * 3, maxHp: 100 }],
      ...(v2 ? { rs: [{ owner: 0, ink: i, upgrade: i > 5 ? 1 : 0 }, { owner: 1, ink: 10 - i, upgrade: 0 }] } : {}),
    });
  }
  // skin_shop_c1 → infantry (owner 0), skin_shop_r1 → archer (owner 1); see UnitView/assets.ts SKIN_ASSETS.
  const skins = (ids: string[]): { skins?: string[] } => (v2 ? { skins: ids } : {});
  return {
    header: {
      schemaVersion: v2 ? 2 : 1,
      mode: 'netplay',
      tickRate: 30,
      endTick: 300,
      winner: 0,
      board: { cols: 12, rows: 18, lanes: [0, 1, 2, 3, 4, 7, 8, 9, 10, 11] },
      players: [
        { name: 'Tao', side: 0, ...skins(['skin_shop_c1']) },
        { name: 'Anna', side: 1, ...skins(['skin_shop_r1']) },
      ],
    },
    frames,
  };
}

/** Land on the share page with the fixture served in place of metaserver; returns the requested rigs. */
async function openSharedReplay(
  page: Page,
  v2 = true,
): Promise<{ rigs: Set<string>; errors: string[] }> {
  const rigs = new Set<string>();
  const errors: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith('.tao')) rigs.add(r.url()); });
  // No backend is running for this spec (only the share fetch is stubbed), so the app's own
  // bootstrap/analytics calls fail by design — everything else is a real error.
  const expected = /ERR_CONNECTION_REFUSED|Failed to fetch|bootstrap|analytics/i;
  page.on('console', (m) => {
    if (m.type() === 'error' && !expected.test(m.text())) errors.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e: Error) => errors.push(`[pageerror] ${e.message}`));

  await page.route(`**/r/${SHARE_CODE}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { blob: fixture(v2) } }),
    }),
  );
  await page.goto(`/?r=${SHARE_CODE}`);
  // The share code skips intro/consent/login entirely and lands straight in the dumb player.
  await page.waitForFunction(() => (window as unknown as E2EWindow).__nwE2E?.state?.screen === 'statePlayer', undefined, { timeout: 20_000 });
  return { rigs, errors };
}

/** Every visible plain-integer label in the live display tree — i.e. the HUD's two ink counts (the
 *  match clock is "m:ss", the speed button "1x", names are words). */
async function visibleCounts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walk = (c: { children?: unknown[]; visible?: boolean }): void => {
      for (const raw of c.children ?? []) {
        const ch = raw as { children?: unknown[]; visible?: boolean; text?: unknown };
        if (ch.visible === false) continue;
        if (typeof ch.text === 'string') {
          if (/^\d+$/.test(ch.text)) out.push(ch.text);
        } else if (ch.children) walk(ch);
      }
    };
    const stage = (window as unknown as E2EWindow).__nwE2E?.app?.stage;
    if (stage) walk(stage);
    return out;
  });
}

test.describe('shared replay landing page (?r=)', () => {
  test('fetches each side\'s own skin rig on top of the default set', async ({ browser }: { browser: Browser }) => {
    // Differential, because webpack names assets by content hash — "which rigs" isn't readable off the
    // URL, but "two more rigs than the same stream without skins" is, and it self-calibrates against
    // however many types the default bundle currently has. Separate contexts so the second run can't
    // serve its rigs out of the first one's HTTP cache.
    const counts: number[] = [];
    for (const v2 of [false, true]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const { rigs } = await openSharedReplay(page, v2);
      // UnitView kicks every rig fetch off in its constructor; give them a moment to be issued.
      await page.waitForTimeout(2000);
      counts.push(rigs.size);
      await ctx.close();
    }
    const [plain, skinned] = counts;
    expect(plain).toBeGreaterThan(0); // the default rigs load either way
    expect(skinned - plain!).toBe(2); // + one skin rig per side
  });

  test('plays the stream: the canvas keeps changing and the HUD shows both sides\' ink', async ({ page }) => {
    const { errors } = await openSharedReplay(page);

    // Animation: the same units' poses/positions advance between two grabs ~0.4 s apart. Compared on
    // the canvas' own pixels, so it can only pass if something really moved (the units used to slide
    // with their stickman clocks frozen at dt 0 — and at 0.4 s apart, pose is the visible difference).
    await page.waitForTimeout(1200); // let the rigs decode so this compares rigs, not placeholders
    const before = await page.locator('canvas').screenshot();
    await page.waitForTimeout(400);
    const after = await page.locator('canvas').screenshot();
    expect(Buffer.compare(before, after)).not.toBe(0);

    // HUD: one ink readout per side, both fed by the stream (owner 0 counts up, owner 1 down).
    const counts = await visibleCounts(page);
    expect(counts).toHaveLength(2);

    // Keep the frame as a report attachment: the assertions above can't tell "skinned, animated units
    // over a HUD" from "something changed", and this is the one layer that renders real pixels.
    await test.info().attach('shared-replay', { body: after, contentType: 'image/png' });

    expect(errors).toEqual([]);
  });
});

// Where a GameScene frame's time actually goes, measured on a real renderer at a real device
// geometry — and the end-to-end check that `render_profile`'s cost fields report it.
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────────
// 2026-09-11 produced ten `cpu` anomalies (fps 19-25) from one session, and the `render_profile`
// rows beside them said `maxFps:60, fpsP50:30, fpsMax:30, tickPerSec:29, skipPct:2-14` on a dpr-2 /
// 2048x1308 canvas. That is a real stutter — the loop asked for 60 all span and never got there —
// but the report could not say WHY, and the two diagnoses attempted from mechanism alone were both
// wrong inside ten minutes. `skipPct` had already ruled out "paint less often" as the answer: the
// frames are being drawn, so the question is what a drawn frame costs and what the cost scales with.
//
// So this measures the one thing a report cannot: the same scene, same CSS size, at two backbuffer
// densities. If paint cost tracks the PIXEL COUNT (x4 from dpr 1 to dpr 2), the wall is fill rate
// and the lever is `MAX_RENDER_RESOLUTION`; if it barely moves, the cost is per-object and the
// lever is the scene graph. One number decides which half of the client to even look at.
//
// Skipped unless NW_FRAMECOST=1, for the same reason captureEndStats is: it asserts almost nothing,
// it spends 30s per case waiting for a real `render_profile` window, and it needs the local stack up
// (docker: metaserver et al behind nginx on 8088 — the dev server must be built against it).
//
//   Run: NW_FRAMECOST=1 npx playwright test frameCost
import { test, expect, type Page } from '@playwright/test';
import { uid, registerAndEnterLobby, callCb, screenIs, dismissFeatureGuide } from './lib/nwE2E';

/**
 * CSS viewport of the reported device: 2048x1308 device px at dpr 2. Held CONSTANT across both
 * cases so the only variable is backbuffer density — same layout, same object count, same draw
 * calls, different pixels. A case that also changed the CSS size would re-lay-out the scene and
 * measure two things at once.
 */
const VIEWPORT = { width: 1024, height: 654 };

/** Paints timed per sample. Enough to swamp one stray compositor hitch, short enough to stay honest. */
const BENCH_FRAMES = 60;

interface PaintBench {
  /** `app.view.width/height` — the backbuffer this case actually rasterised into. */
  canvasW: number;
  canvasH: number;
  resolution: number;
  /** Milliseconds per paint, GPU work included (see the sync note below). */
  msPerPaint: number;
  /**
   * `UNMASKED_RENDERER_WEBGL`. Recorded because WITHOUT IT THE NUMBER IS UNREADABLE: Playwright's
   * Chromium routinely falls back to SwiftShader (software rasterisation), where paint cost has no
   * relationship to what a real GPU pays. The first run of this spec reported 4x the pixels for
   * +19% cost — a result that is nonsense on hardware and unremarkable in software, and there was
   * no field in the output to tell the two apart.
   */
  glRenderer: string | null;
}

/**
 * Time `BENCH_FRAMES` full paints of the live stage.
 *
 * `renderer.render()` returns as soon as the commands are queued — timing it alone measures
 * submission, not drawing, which is exactly the distinction this whole spec is about. A 1x1
 * `readPixels` after the batch blocks until the GPU has retired the work, so the total covers both
 * halves. `readPixels` rather than `finish()`: `finish` is advisory in several drivers and a no-op
 * whenever `renderer.gl` is absent (the canvas fallback), and an optional-chained `gl?.finish()`
 * fails SILENTLY there — it reports submission cost while looking like it measured drawing.
 * `readPixels` cannot be skipped and cannot be reordered.
 *
 * Synced ONCE for the batch rather than per frame: per-frame would serialise CPU and GPU and report
 * a number no real frame ever pays.
 */
async function benchPaint(page: Page): Promise<PaintBench> {
  return page.evaluate(async (frames: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (window as any).__nwE2E.app;
    const gl: WebGLRenderingContext | null = app.renderer.gl ?? null;
    if (!gl) throw new Error('no WebGL context — the canvas fallback cannot be benchmarked here');
    const scratch = new Uint8Array(4);
    const sync = (): void => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    const render = (): void => app.renderer.render(app.stage);

    for (let i = 0; i < 12; i++) render();   // warm shaders / upload any late texture
    sync();

    const t0 = performance.now();
    for (let i = 0; i < frames; i++) render();
    sync();
    const t1 = performance.now();

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      canvasW: app.view.width,
      canvasH: app.view.height,
      resolution: app.renderer.resolution,
      msPerPaint: (t1 - t0) / frames,
      glRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  }, BENCH_FRAMES);
}

/** Wait for the first shipped `render_profile` and hand back its props. ~30s of visible sampling. */
function firstRenderProfile(page: Page): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    page.on('console', (msg) => {
      if (!msg.text().includes('render_profile')) return;
      const arg = msg.args()[2];
      if (!arg) return;
      void arg.jsonValue().then((v) => resolve(v as Record<string, unknown>));
    });
  });
}

async function enterBattle(page: Page): Promise<void> {
  await registerAndEnterLobby(page, uid('fcost'), 'FrameCost');
  expect(await callCb(page, 'lobbyCb', 'onStartGame', ['AI'])).toBe(true);
  // A fresh account meets the first-time feature guide here (ONBOARDING_DESIGN §4.1) and `screen`
  // never becomes 'game' until it is dismissed — the same gate smoke.spec.ts steps over by hand.
  await page.waitForFunction(() => !!window.__nwE2E?.state?.showFeatureGuideCb, null, { timeout: 5_000 })
    .catch(() => { /* no guide on this account; nothing to dismiss */ });
  await dismissFeatureGuide(page);
  await screenIs(page, 'game');
  await page.waitForTimeout(3000); // same settle the layout sweep gives this stop
}

for (const dpr of [1, 2]) {
  test.describe(`GameScene frame cost @ dpr ${dpr}`, () => {
    test.use({ viewport: VIEWPORT, deviceScaleFactor: dpr });
    test.skip(process.env.NW_FRAMECOST !== '1', 'measurement harness; set NW_FRAMECOST=1');
    test.setTimeout(180_000);

    test('paint cost and the reported cost fields', async ({ page }) => {
      const profile = firstRenderProfile(page);
      await enterBattle(page);

      const bench = await benchPaint(page);
      expect(bench.resolution).toBe(dpr);
      expect(bench.canvasW).toBe(VIEWPORT.width * dpr);

      const props = await profile;
      // The fields this spec's sibling change adds. Asserted for PRESENCE and plausibility only:
      // the actual values are the measurement, and pinning them would pin this machine's speed.
      for (const f of ['updP50', 'rndP50', 'updMax', 'rndMax']) {
        expect(typeof props[f], `${f} missing from render_profile`).toBe('number');
      }

      const framePeriodMs = 1000 / (props.fpsP50 as number);
      const inOurJs = (props.updP50 as number) + (props.rndP50 as number);
      // eslint-disable-next-line no-console
      console.log(`\nFRAMECOST dpr=${dpr} canvas=${bench.canvasW}x${bench.canvasH} `
        + `px=${(bench.canvasW * bench.canvasH / 1e6).toFixed(2)}M\n`
        + `  gpu     ${bench.glRenderer}\n`
        + `  bench   ${bench.msPerPaint.toFixed(3)} ms/paint (GPU included)\n`
        + `  profile fpsP50=${props.fpsP50} maxFps=${props.maxFps} skipPct=${props.skipPct} `
        + `tickPerSec=${props.tickPerSec}\n`
        + `          updP50=${props.updP50} rndP50=${props.rndP50} `
        + `updMax=${props.updMax} rndMax=${props.rndMax}\n`
        + `  budget  frame period ${framePeriodMs.toFixed(1)} ms, `
        + `${inOurJs.toFixed(1)} ms of it in our JS `
        + `(${((inOurJs / framePeriodMs) * 100).toFixed(0)}%)\n`);
    });
  });
}

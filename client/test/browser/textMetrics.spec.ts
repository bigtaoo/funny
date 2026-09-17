// The Chrome half of the WeChat text-metrics comparison (src/render/textMetricsProbe.ts).
//
// `fitFont` computes the font size a label needs in one division rather than iterating, and it may
// only do that because a monospace advance width is linear in font size. The legibility floor
// (`fontFloorDesignPx`) is likewise a claim about how big a glyph ends up. Both were derived on
// Chrome. The WeChat mini-game runtime resolves `'monospace'` to whatever the phone ships, on a
// canvas that never went through the DOM — so the honest question is not "does WeChat work" but
// "are these two runtimes measuring the same thing", and that is a DIFFERENCE, which needs both
// numbers produced by the same code.
//
// This test asserts the two properties the client's layout arithmetic actually depends on, rather
// than pinning exact pixel widths (which are a property of whatever font the CI image happens to
// have installed and would fail for the wrong reason):
//
//   1. linear — advance width per character is proportional to font size;
//   2. monospaced — 'M' and 'i' advance identically, i.e. the resolved face really is fixed-pitch.
//
// Its other half is the report file: `npm run build:wechat-probe`, run the entry in WeChat DevTools,
// then read `<USER_DATA_PATH>/host-probe.json`'s `textMetrics` section and compare it to what this
// prints. See claudedocs/client-testing.md.

import { test, expect, type Page } from '@playwright/test';
import { type TextMetricsReport } from '../../src/render/textMetricsProbe';
import { MONO_CELL } from '../../src/render/pixiText';

/**
 * Runs the probe INSIDE the page, through the handle `entries/web-e2e.ts` exposes for exactly this.
 *
 * Not `page.evaluate(probeTextMetrics.toString())`, which is how this spec used to do it and why it
 * had been failing with `ReferenceError: PROBE_FONT_FAMILY is not defined`: `evaluate` ships a
 * function's own source and nothing else, so the corpus, the size list and the two helpers the
 * probe closes over all arrive undefined. `web-e2e.ts`'s comment already said so — the spec simply
 * never followed it. Going through the handle also keeps the property that makes this measurement
 * worth anything: the code that runs here is the same bundled module the WeChat probe entry runs,
 * not a transcription of it.
 */
async function measure(page: Page): Promise<TextMetricsReport> {
  const report = await page.evaluate(
    () => (window.__nwE2E?.textMetrics as (() => TextMetricsReport) | undefined)?.(),
  );
  expect(report, 'window.__nwE2E.textMetrics is missing — is this the `start:e2e` bundle?').toBeDefined();
  return report!;
}

test.describe('text metrics — the assumption fitFont rests on', () => {
  test('monospace advance is linear in font size, on this runtime', async ({ page }) => {
    await page.goto('/');
    const report = await measure(page);

    expect(report.error ?? '', report.error ?? '').toBe('');
    expect(report.ok).toBe(true);

    const by = new Map(report.linearity.map((l) => [l.label, l]));
    // 1% of slack for sub-pixel rounding; a runtime that hinted advances per size would blow far
    // past it, and that is the case fitFont's single division cannot survive.
    for (const [label, l] of by) {
      expect(l.maxDeviation, `${label}: advance/size varied ${l.maxDeviation} across sizes`)
        .toBeLessThan(0.01);
    }

    const wide = by.get('latinWide')!.medianRatio;
    const narrow = by.get('latinNarrow')!.medianRatio;
    expect(Math.abs(wide - narrow) / wide, `'M' ${wide} vs 'i' ${narrow} per px — not fixed-pitch`)
      .toBeLessThan(0.01);

    // Not asserted, only recorded: the CJK ratio is the number the WeChat report has to be compared
    // against, and it is a property of the installed font rather than of the code.
    // eslint-disable-next-line no-console
    console.log('[text-metrics] chrome:', JSON.stringify({
      resolvedFont: report.resolvedFont, linearity: report.linearity,
    }));
  });

  /**
   * The other thing this runtime's advance widths decide: {@link MONO_CELL}, the per-cell fractions
   * `monospaceWidth()` hardcodes. That helper exists so a layout can BRANCH on width without the
   * branch being decided by `test/ui`'s `chars * 7` stub (see settingsLegalLinks.ui.ts), and it is
   * only sound while those two constants sit just below the real advance:
   *
   *  - above it → the estimate wins the `Math.max` against a real measurement, so a browser lays
   *    out from a guess instead of from the width it can see;
   *  - far below → the estimate stops resembling the runtime it stands in for, and the headless
   *    branch decisions stop resembling the device's.
   *
   * A real font is the only thing that can answer this, which is why it lives here and not in
   * `test/monospaceWidth.test.ts` (that suite owns the arithmetic; this one owns the constants).
   */
  test('MONO_CELL brackets the advance this runtime actually uses', async ({ page }) => {
    await page.goto('/');
    const report = await measure(page);
    expect(report.ok, report.error ?? '').toBe(true);

    const by = new Map(report.linearity.map((l) => [l.label, l]));
    const cases: readonly [string, string, number][] = [
      ['latinWide', 'latin', MONO_CELL.latin],
      ['digits', 'latin', MONO_CELL.latin],
      ['german', 'latin', MONO_CELL.latin],
      ['cjk', 'fullWidth', MONO_CELL.fullWidth],
    ];
    for (const [label, cell, constant] of cases) {
      const measured = by.get(label)!.medianRatio;
      expect(measured, `MONO_CELL.${cell} = ${constant} over-reports "${label}" (${measured} em/char here)`)
        .toBeGreaterThanOrEqual(constant);
      // 25%: wide enough for a different monospace family on a different CI image, narrow enough
      // that "the estimate is a third of the truth" — the failure mode the stub already has — is
      // caught rather than inherited.
      expect(measured, `MONO_CELL.${cell} = ${constant} is far under "${label}" (${measured} em/char here)`)
        .toBeLessThanOrEqual(constant * 1.25);
    }
  });
});

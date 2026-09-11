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

import { test, expect } from '@playwright/test';
import { probeTextMetrics, type TextMetricsReport } from '../../src/render/textMetricsProbe';

test.describe('text metrics — the assumption fitFont rests on', () => {
  test('monospace advance is linear in font size, on this runtime', async ({ page }) => {
    await page.goto('/');
    // The probe function itself is shipped into the page: `page.evaluate` serialises the closure,
    // so the WeChat build and this run measure with the same source, not with two transcriptions
    // of it. (That is also why it takes a factory — see its doc comment.)
    const report: TextMetricsReport = await page.evaluate(
      (src: string) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const fn = new Function(`return (${src});`)() as (
          make: () => CanvasRenderingContext2D | null,
        ) => TextMetricsReport;
        return fn(() => document.createElement('canvas').getContext('2d'));
      },
      probeTextMetrics.toString(),
    );

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
});

/**
 * textMetricsProbe.ts — measures what `measureText` actually returns on a given runtime.
 *
 * ## Why this exists
 *
 * Every width decision in this client is downstream of one 2D-context call. `fitFont`
 * (render/fontScale.ts) shrinks a label to fit by **computing** the size it needs, in one shot
 * rather than iterating, and it may do that only because a monospace advance width is linear in
 * font size. `drawButtonLabel` drops its icon when the text will not fit. The portrait sweep's
 * whole legibility floor is a claim about how large a glyph ends up on screen. All three are
 * statements about `ctx.measureText(...).width` for `fontFamily: 'monospace'` — which is the font
 * every text style in this codebase asks for, and which is not a font but a *request the runtime
 * resolves however it likes*.
 *
 * On Chrome that resolution has been measured, indirectly, by the layout sweep. On WeChat it never
 * has. The mini-game runtime has no DOM, its canvas comes from `wx.createCanvas()` rather than
 * `document.createElement`, and the font it picks for 'monospace' is whatever the phone ships —
 * which on many Android devices is not monospace at all for CJK. If the advance width per
 * character differs, then `fitFont`'s one-shot arithmetic is solving the wrong equation and the
 * legibility floor is guarding the wrong number, and both conclusions have to be re-derived rather
 * than assumed to carry over.
 *
 * ## Why it is a shared function and not two probes
 *
 * The answer that matters is a *difference* between two runtimes, so the two numbers have to be
 * produced by the same code. The caller supplies only the context: `wx.createCanvas()` on WeChat
 * (entries/wechat-probe.ts), `document.createElement('canvas')` in a browser
 * (test/browser/textMetrics.spec.ts). Nothing here touches a platform API.
 *
 * Never imported by a shipped entry — same standing as platform/wechat/hostProbe.ts.
 */

/** Font stack every text style in this codebase asks for (see render/sketchUi.ts, HUDView.ts). */
export const PROBE_FONT_FAMILY = 'monospace';

/**
 * The corpus, chosen so each row isolates one thing that could differ:
 *  · `latinWide`/`latinNarrow` — whether the resolved face is monospace AT ALL (on a true monospace
 *    these two measure identically; on a proportional fallback they do not, and every width budget
 *    computed from a character count is then wrong in a text-dependent direction).
 *  · `digits` — the characters most of the game's numbers are made of.
 *  · `cjk` — full-width glyphs, the widest case, and the one the anti-clip padding exists for.
 *  · `german` — the longest unbreakable token the UI has to survive.
 */
export const PROBE_STRINGS: readonly { label: string; text: string }[] = [
  { label: 'latinWide', text: 'MMMMMMMMMM' },
  { label: 'latinNarrow', text: 'iiiiiiiiii' },
  { label: 'digits', text: '0123456789' },
  { label: 'cjk', text: '不落长夜之城' },
  { label: 'german', text: 'Donaudampfschifffahrt' },
];

/**
 * Sizes spanning the whole `FS` table plus the floor's own reference point (7 CSS px, the number
 * `fontFloorDesignPx` solves backwards from). Linearity is only interesting across a range.
 */
export const PROBE_SIZES: readonly number[] = [7, 11, 13, 16, 18, 20, 24, 32, 60];

export interface TextMetricSample {
  label: string;
  fontSize: number;
  chars: number;
  width: number;
  /** Per-character advance divided by font size — 1.0 means a full-width cell per character. */
  advanceRatio: number;
  ascent: number | null;
  descent: number | null;
}

export interface TextMetricsReport {
  ok: boolean;
  error?: string;
  fontFamily: string;
  /** What the context reports its font as after being asked for `<size>px monospace`. */
  resolvedFont: string | null;
  samples: TextMetricSample[];
  /**
   * Per corpus row: is width proportional to font size? Reported as the spread of `advanceRatio`
   * across `PROBE_SIZES`, relative to its own median.
   *
   * This is the one number `fitFont` rests on. It computes the font size a label needs in a single
   * division — no iteration — which is only correct while this spread is ~0. A runtime that
   * hints or rounds advances per size would make that division a guess, and the failure would be
   * invisible: a label one size too large is not a crash, it is a label that spills.
   */
  linearity: { label: string; medianRatio: number; maxDeviation: number }[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const round = (n: number, dp = 4): number => Number(n.toFixed(dp));

/**
 * Measures the corpus at every size on the context the caller supplies.
 *
 * `makeCtx` is a factory rather than a context so a caller can hand over a runtime that throws
 * on canvas creation — the report then says so instead of the probe dying, which matters because
 * "the probe produced nothing" and "this runtime has no 2D context" are the same on disk and need
 * very different fixes.
 */
export function probeTextMetrics(
  makeCtx: () => CanvasRenderingContext2D | null,
): TextMetricsReport {
  const report: TextMetricsReport = {
    ok: false, fontFamily: PROBE_FONT_FAMILY, resolvedFont: null, samples: [], linearity: [],
  };
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = makeCtx();
  } catch (e) {
    report.error = `context factory threw: ${String(e)}`;
    return report;
  }
  if (!ctx || typeof ctx.measureText !== 'function') {
    report.error = ctx ? 'context has no measureText' : 'context factory returned null';
    return report;
  }

  const ratios = new Map<string, number[]>();
  for (const size of PROBE_SIZES) {
    try {
      ctx.font = `${size}px ${PROBE_FONT_FAMILY}`;
    } catch (e) {
      report.error = `setting ctx.font threw: ${String(e)}`;
      return report;
    }
    if (report.resolvedFont === null) report.resolvedFont = typeof ctx.font === 'string' ? ctx.font : null;
    for (const { label, text } of PROBE_STRINGS) {
      let m: TextMetrics;
      try {
        m = ctx.measureText(text);
      } catch (e) {
        report.error = `measureText threw at ${size}px on ${label}: ${String(e)}`;
        return report;
      }
      const chars = [...text].length;
      const ratio = m.width / (chars * size);
      (ratios.get(label) ?? ratios.set(label, []).get(label)!).push(ratio);
      report.samples.push({
        label,
        fontSize: size,
        chars,
        width: round(m.width, 3),
        advanceRatio: round(ratio),
        // Absent on older runtimes; a null here is itself worth recording, since the CJK anti-clip
        // padding exists precisely because the reported box and the inked box disagree.
        ascent: typeof m.actualBoundingBoxAscent === 'number' ? round(m.actualBoundingBoxAscent, 3) : null,
        descent: typeof m.actualBoundingBoxDescent === 'number' ? round(m.actualBoundingBoxDescent, 3) : null,
      });
    }
  }

  for (const [label, rs] of ratios) {
    const med = median(rs);
    report.linearity.push({
      label,
      medianRatio: round(med),
      maxDeviation: round(med === 0 ? 0 : Math.max(...rs.map((r) => Math.abs(r - med) / med))),
    });
  }
  report.ok = true;
  return report;
}

// Regression coverage for the Home City legibility complaint (2026-08-02): building-grid
// cards and secondary labels ("Lv.N", "/200k", "Heroes N") read as blending into the paper
// background. Root cause, confirmed by WCAG contrast math:
//   - `ui.mid` (secondary text) was 0x888888, ~3.6:1 against `ui.paper` — under the WCAG AA
//     4.5:1 floor for normal-size body text.
//   - CityScene's resource-bar / build-queue panels and idle building-grid cards borrowed
//     `palette.ruleLine` (meant for faint decorative notebook rule lines, ~1.5:1 against
//     `ui.paper`) as their functional card border, so the cards had no visible edge at all.
// The fix darkened `ui.mid` and swapped those borders to `ui.mid`. This test pins the
// contrast math so neither regresses back below the legibility floor — whatever specific
// hex either token holds, the invariant "secondary text/borders must stay legible against
// the paper backgrounds" is what must keep holding.
import { describe, it, expect } from 'vitest';
import { ui } from '../src/render/sketchUi';
import { palette } from '../src/render/theme';

/** WCAG relative luminance of an 0xRRGGBB colour (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
function relativeLuminance(hex: number): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((hex >> 16) & 0xff);
  const g = channel((hex >> 8) & 0xff);
  const b = channel(hex & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours; always >= 1. */
function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// WCAG AA floor for normal-size (< 18pt / < 14pt-bold) text.
const AA_NORMAL_TEXT = 4.5;
// WCAG 1.4.11 floor for non-text UI component boundaries (e.g. a card's border stroke).
const AA_UI_BOUNDARY = 3.0;

describe('sketchUi secondary colour contrast (2026-08-02 Home City legibility fix)', () => {
  it('ui.mid meets the AA body-text floor against the card background (ui.paper)', () => {
    expect(contrastRatio(ui.mid, ui.paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('ui.mid meets the AA body-text floor against the page background (palette.paper)', () => {
    expect(contrastRatio(ui.mid, palette.paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('ui.mid, reused as a card/panel border, meets the non-text UI boundary floor against ui.paper', () => {
    // CityScene's resource bar, build-queue panel, and idle building-grid cards all border
    // with ui.mid (render.ts) — it must actually delineate against the card fill it sits on.
    expect(contrastRatio(ui.mid, ui.paper)).toBeGreaterThanOrEqual(AA_UI_BOUNDARY);
  });

  it('ui.dark (primary text) still clears AA comfortably — sanity check the fix did not touch it', () => {
    expect(contrastRatio(ui.dark, ui.paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('documents why palette.ruleLine is unfit as a functional card border (still fine for its own faint decorative use)', () => {
    // This is the original bug: ruleLine is a deliberately faint decorative tone (printed
    // notebook rule lines), not a legible boundary colour. Anything reusing it as a card
    // border reproduces the exact "card blends into background" complaint.
    expect(contrastRatio(palette.ruleLine, ui.paper)).toBeLessThan(AA_UI_BOUNDARY);
  });
});

import { describe, it, expect } from 'vitest';
import { headerMetrics } from '../src/scenes/LobbyScene/format';

// Design sizes from the layout classes: portrait 1080×1920, landscape 1920×1080.
const PORTRAIT = { w: 1080, h: 1920 };
const LANDSCAPE = { w: 1920, h: 1080 };

describe('headerMetrics (LobbyScene header geometry)', () => {
  it('landscape uses one shared band: chipBandH === tbH', () => {
    const m = headerMetrics(LANDSCAPE.w, LANDSCAPE.h, false);
    expect(m.chipBandH).toBe(m.tbH);
    // Single-row header height is exactly h*0.16 (no extra brand row).
    expect(m.tbH).toBe(Math.round(LANDSCAPE.h * 0.16));
  });

  it('landscape restores the pre-two-row lockup geometry (big logo, mid-band)', () => {
    const m = headerMetrics(LANDSCAPE.w, LANDSCAPE.h, false);
    expect(m.logoSize).toBe(Math.round(m.tbH * 0.9)); // was shrunk to brandRowH*0.9 by the regression
    expect(m.brandMidY).toBe(Math.round(m.tbH * 0.45));
    expect(m.subtitleY).toBe(Math.round(m.tbH * 0.78));
    expect(m.nameMaxFactor).toBe(0.36);
    expect(m.ulH).toBe(Math.round(LANDSCAPE.h * 0.02));
  });

  it('portrait splits into a chip band + a brand row below it', () => {
    const m = headerMetrics(PORTRAIT.w, PORTRAIT.h, true);
    const chipBandH = Math.round(PORTRAIT.h * 0.16);
    const brandRowH = Math.round(PORTRAIT.h * 0.09);
    expect(m.chipBandH).toBe(chipBandH);
    expect(m.tbH).toBe(chipBandH + brandRowH); // taller than the single row
    expect(m.tbH).toBeGreaterThan(m.chipBandH);
    // Brand lockup sits inside the lower row, clear of the chip band.
    expect(m.brandMidY).toBeGreaterThan(m.chipBandH);
    expect(m.subtitleY).toBeGreaterThan(m.chipBandH);
    expect(m.logoSize).toBe(Math.round(brandRowH * 0.9));
    expect(m.nameMaxFactor).toBe(0.5); // chips own half the band each
  });

  it('portrait logo is smaller and header taller than landscape (the two-row trade-off)', () => {
    const p = headerMetrics(PORTRAIT.w, PORTRAIT.h, true);
    const l = headerMetrics(LANDSCAPE.w, LANDSCAPE.h, false);
    // Same nominal design size, forced portrait vs landscape branch.
    const pSame = headerMetrics(1080, 1080, true);
    const lSame = headerMetrics(1080, 1080, false);
    expect(pSame.tbH).toBeGreaterThan(lSame.tbH);
    expect(pSame.logoSize).toBeLessThan(lSame.logoSize);
    // Sanity: both real orientations produce positive, finite geometry.
    for (const m of [p, l]) {
      for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

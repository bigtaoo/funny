import { describe, it, expect } from 'vitest';
import { headerMetrics } from '../src/scenes/LobbyScene/format';

// Design sizes from the layout classes: portrait 1080×1920, landscape 1920×1080.
const PORTRAIT = { w: 1080, h: 1920 };
const LANDSCAPE = { w: 1920, h: 1080 };

describe('headerMetrics (LobbyScene header geometry)', () => {
  it('landscape uses one shared band: chipBandH === tbH', () => {
    const m = headerMetrics(LANDSCAPE.w, LANDSCAPE.h, false);
    expect(m.chipBandH).toBe(m.tbH);
    expect(m.chipBandY).toBe(0);
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

  it('portrait splits into a brand row on top + a chip band below it', () => {
    const m = headerMetrics(PORTRAIT.w, PORTRAIT.h, true);
    const brandRowH = Math.round(PORTRAIT.h * 0.09);
    const chipBandH = Math.round(PORTRAIT.h * 0.12);
    expect(m.chipBandH).toBe(chipBandH);
    expect(m.chipBandY).toBe(brandRowH); // chip band sits below the brand row now
    expect(m.tbH).toBe(chipBandH + brandRowH); // taller than the single row
    expect(m.tbH).toBeGreaterThan(m.chipBandH);
    // Brand lockup sits inside the top row, clear of the chip band below it.
    expect(m.brandMidY).toBeLessThan(m.chipBandY);
    expect(m.subtitleY).toBeLessThanOrEqual(m.chipBandY);
    expect(m.logoSize).toBe(Math.round(brandRowH * 0.9));
    expect(m.nameMaxFactor).toBe(0.5); // profile chip owns half the band, chips the other half
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

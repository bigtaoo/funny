// analytics.ts's percentage formatter, shared by every funnel/cohort table cell (onboarding,
// tutorial, scene step-funnels). renderStepFunnel()/barCell() build DOM and stay untested.
import { describe, it, expect } from 'vitest';
import { pct } from '../src/pages/analytics';

describe('pct', () => {
  it('formats a fraction as a percentage with one decimal place', () => {
    expect(pct(0.5)).toBe('50.0%');
  });

  it('rounds to one decimal place', () => {
    expect(pct(0.12345)).toBe('12.3%');
  });

  it('formats 0 and 1 as the boundary percentages', () => {
    expect(pct(0)).toBe('0.0%');
    expect(pct(1)).toBe('100.0%');
  });
});

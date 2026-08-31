// The voice cap is pure bookkeeping, so it is testable with plain numbers — and worth testing
// hard, because both of its failure directions are silent: too eager and the mix goes quiet after
// N cues, too lax and a burst machine-guns.
//
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { VoiceBudget } from '../../src/audio/VoiceBudget';

/** Claim helper returning [granted, whether this voice was later stolen]. */
function claimer(b: VoiceBudget) {
  const stolen: string[] = [];
  const claim = (name: string, priority: number, now: number, until: number): boolean =>
    b.claim(priority, now, until, () => stolen.push(name));
  return { claim, stolen };
}

describe('VoiceBudget', () => {
  it('grants up to the cap, then refuses an equal-priority newcomer', () => {
    const b = new VoiceBudget(2);
    const { claim, stolen } = claimer(b);
    expect(claim('a', 50, 0, 1)).toBe(true);
    expect(claim('b', 50, 0, 1)).toBe(true);
    // Equal priority loses on purpose: the muzzle already sounding is worth as much as the next
    // one, and stealing it would only add a click.
    expect(claim('c', 50, 0, 1)).toBe(false);
    expect(stolen).toEqual([]);
    expect(b.held).toBe(2);
  });

  it('a higher-priority cue steals the weakest slot rather than being refused', () => {
    const b = new VoiceBudget(2);
    const { claim, stolen } = claimer(b);
    claim('weak', 20, 0, 1);
    claim('mid', 60, 0, 1);
    expect(claim('strong', 90, 0, 1)).toBe(true);
    expect(stolen).toEqual(['weak']);
    expect(b.held).toBe(2);
  });

  it('steals the OLDEST among equally weak voices', () => {
    const b = new VoiceBudget(2);
    const { claim, stolen } = claimer(b);
    claim('first', 20, 0, 1);
    claim('second', 20, 0, 1);
    claim('strong', 50, 0, 1);
    expect(stolen).toEqual(['first']);
  });

  it('a lower-priority cue is refused even when something weaker-than-cap exists', () => {
    const b = new VoiceBudget(1);
    const { claim, stolen } = claimer(b);
    claim('held', 90, 0, 1);
    expect(claim('low', 10, 0, 1)).toBe(false);
    expect(stolen).toEqual([]);
  });

  it('retires voices by TIME, so a later claim reclaims expired slots', () => {
    const b = new VoiceBudget(1);
    const { claim, stolen } = claimer(b);
    claim('short', 50, 0, 0.1);
    // Still sounding at t=0.05 → refused.
    expect(claim('next', 50, 0.05, 0.2)).toBe(false);
    // Finished by t=0.1 (the boundary counts as done) → granted, and NOT stolen: it ended on
    // its own, so nothing should have been cut short.
    expect(claim('next', 50, 0.1, 0.2)).toBe(true);
    expect(stolen).toEqual([]);
    expect(b.held).toBe(1);
  });

  it('purging is not a leak: many sequential short voices never exceed the cap', () => {
    // This is the "fails closed" property the time-based retirement exists for — if purge broke,
    // held would climb and every cue after the 4th would be dropped forever.
    const b = new VoiceBudget(4);
    const { claim } = claimer(b);
    for (let i = 0; i < 200; i++) {
      expect(claim(`v${i}`, 50, i * 0.1, i * 0.1 + 0.05)).toBe(true);
    }
    expect(b.held).toBe(1);
  });

  it('a cap of 0 refuses everything without throwing', () => {
    const b = new VoiceBudget(0);
    const { claim, stolen } = claimer(b);
    expect(claim('a', 999, 0, 1)).toBe(false);
    expect(stolen).toEqual([]);
    expect(b.held).toBe(0);
  });

  it('a stolen voice frees its slot exactly once', () => {
    // Two successive high-priority claims against a cap of 1 must steal one voice each, not
    // double-steal the first (which in CueMixer would call stop() twice on a stopped node).
    const b = new VoiceBudget(1);
    const { claim, stolen } = claimer(b);
    claim('a', 10, 0, 5);
    claim('b', 20, 0, 5);
    claim('c', 30, 0, 5);
    expect(stolen).toEqual(['a', 'b']);
    expect(b.held).toBe(1);
  });
});

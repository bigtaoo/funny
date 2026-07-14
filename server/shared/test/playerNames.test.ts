// Unit tests for playerNames.ts + playerNamePool.ts: the shared guest/bot display-name generator
// and its curated real-nickname pool. We assert the invariants that matter — valid length,
// non-empty, mostly number-free, drawn from the pool, and free of obvious profanity/NPC tells.
import { describe, it, expect } from 'vitest';
import { randomPlayerName } from '../src/playerNames';
import { PLAYER_NAME_POOL } from '../src/playerNamePool';
import { validateDisplayName, MAX_DISPLAY_NAME_LEN } from '../src/password';

// A tell is a word that reads as an assigned NPC role rather than a self-chosen handle, plus a
// baseline of profanity/slur fragments that must never appear in a name shown to players.
const TELLS = [
  'cadet', 'recruit', 'trainee', 'apprentice', 'scholar', 'scribe',
  'fuck', 'shit', 'nigg', 'nugga', 'cunt', 'incel', 'rape', 'nazi', 'slut', 'whore', 'fag',
];

describe('PLAYER_NAME_POOL', () => {
  it('is non-trivial and every entry is a valid, digit-free, length-bounded handle', () => {
    expect(PLAYER_NAME_POOL.length).toBeGreaterThan(200);
    for (const name of PLAYER_NAME_POOL) {
      expect(validateDisplayName(name)).toBeNull();
      expect(name.length).toBeLessThanOrEqual(14); // leaves headroom for the +digit suffix
      expect(/[0-9]/.test(name)).toBe(false); // pool itself carries no numbers
    }
  });

  it('has no duplicate entries (case-insensitive)', () => {
    const seen = new Set(PLAYER_NAME_POOL.map((n) => n.toLowerCase()));
    expect(seen.size).toBe(PLAYER_NAME_POOL.length);
  });

  it('contains no obvious profanity / NPC tells', () => {
    for (const name of PLAYER_NAME_POOL) {
      const low = name.toLowerCase();
      for (const tell of TELLS) expect(low.includes(tell)).toBe(false);
    }
  });
});

describe('randomPlayerName', () => {
  it('always yields a valid, non-empty display name', () => {
    for (let s = 0; s < 500; s++) {
      const name = randomPlayerName((max) => (s * 7 + 3) % max);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(MAX_DISPLAY_NAME_LEN);
      expect(validateDisplayName(name)).toBeNull();
    }
  });

  it('draws its base from the pool and keeps most names number-free', () => {
    let withNumber = 0;
    const N = 600;
    for (let s = 0; s < N; s++) {
      const name = randomPlayerName((max) => (s * 13 + 1) % max);
      const base = name.replace(/[0-9]+$/, '');
      expect(PLAYER_NAME_POOL.includes(base)).toBe(true);
      if (/[0-9]/.test(name)) withNumber++;
    }
    // Numbers are the minority (~1 in 6), not the norm the user complained about.
    expect(withNumber / N).toBeLessThan(0.3);
  });

  it('is deterministic for a given int source', () => {
    const src = () => 0;
    expect(randomPlayerName(src)).toBe(randomPlayerName(src));
  });
});

/**
 * Deterministic Linear Congruential Generator (LCG).
 *
 * Multiplier and increment from Numerical Recipes (Knuth).
 * Produces uint32 values — never calls Math.random().
 * Safe for use in deterministic game logic and replay verification.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    // Ensure uint32; guard against 0 (LCG with state=0 stays 0 for mult=0)
    this.state = (seed >>> 0) || 1;
  }

  /** Advance state and return next uint32 */
  private next(): number {
    // state = (1664525 × state + 1013904223) mod 2^32
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }

  /** Return integer in [0, max) */
  nextInt(max: number): number {
    return (this.next() >>> 0) % max;
  }

  /**
   * Fisher-Yates shuffle in-place.
   * Returns the same array (mutated).
   */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j]!;
      arr[j] = tmp!;
    }
    return arr;
  }
}

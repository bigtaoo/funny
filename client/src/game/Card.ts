import { CARD_DEFINITIONS, CARD_REFRESH_TICKS, HAND_SIZE } from './config';
import { Prng } from './math/prng';
import type { CardDefinition } from './types';

// ─── Draw policy ─────────────────────────────────────────────────────────────

/**
 * Determines which card is drawn next.
 * MVP: uniform random from the full pool.
 * Future: weighted by phase, tier, base level — replace implementation only.
 */
export interface ICardDrawPolicy {
  draw(): CardDefinition;
}

export class UniformCardDrawPolicy implements ICardDrawPolicy {
  constructor(private readonly prng: Prng) {}

  draw(): CardDefinition {
    const idx = this.prng.nextInt(CARD_DEFINITIONS.length);
    return CARD_DEFINITIONS[idx]!;
  }
}

// ─── Hand slot ────────────────────────────────────────────────────────────────

/** One slot in the player's hand. */
export interface HandSlot {
  card: CardDefinition;
  /** Ticks remaining before auto-refresh. Counts down to 0. */
  refreshRemainingTicks: number;
  /** Original duration set when the card was drawn (for client progress bar). */
  refreshDurationTicks: number;
}

// ─── Hand ─────────────────────────────────────────────────────────────────────

export class Hand {
  readonly slots: (HandSlot | null)[];

  constructor() {
    this.slots = new Array(HAND_SIZE).fill(null);
  }

  /** Place a card into a slot with a given refresh timer. */
  drawIntoSlot(index: number, card: CardDefinition, refreshDurationTicks: number): void {
    this.slots[index] = {
      card,
      refreshRemainingTicks: refreshDurationTicks,
      refreshDurationTicks,
    };
  }

  /**
   * Play the card at `index`. Clears the slot and returns the card, or null if empty.
   */
  play(index: number): CardDefinition | null {
    const slot = this.slots[index] ?? null;
    this.slots[index] = null;
    return slot?.card ?? null;
  }

  /**
   * Decrement all occupied slot timers by one tick.
   * Returns the indices of slots whose timer reached 0 (auto-refresh needed).
   */
  tickTimers(): number[] {
    const expired: number[] = [];
    for (let i = 0; i < HAND_SIZE; i++) {
      const slot = this.slots[i];
      if (slot === null) continue;
      slot.refreshRemainingTicks--;
      if (slot.refreshRemainingTicks <= 0) {
        expired.push(i);
      }
    }
    return expired;
  }

  /** Convenience accessor — same card array shape as old API for AI compat. */
  get cards(): (CardDefinition | null)[] {
    return this.slots.map((s) => s?.card ?? null);
  }

  hasCards(): boolean {
    return this.slots.some((s) => s !== null);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the refresh duration for a freshly drawn card.
 * On initial deal, add a random stagger offset so slots don't all expire together.
 *
 * @param staggerTicks  Random offset in [0, CARD_REFRESH_INITIAL_OFFSET_MAX].
 *                      Pass 0 for cards drawn mid-game (after play or expiry).
 */
export function cardRefreshDuration(staggerTicks = 0): number {
  return CARD_REFRESH_TICKS + staggerTicks;
}

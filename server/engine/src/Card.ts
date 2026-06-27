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
  private readonly pool: readonly CardDefinition[];

  constructor(private readonly prng: Prng, pool?: readonly CardDefinition[]) {
    this.pool = pool && pool.length > 0 ? pool : CARD_DEFINITIONS;
  }

  draw(): CardDefinition {
    const idx = this.prng.nextInt(this.pool.length);
    return this.pool[idx]!;
  }
}

/**
 * Scripted draw policy for the专属教学关 `ch0_tutorial` (ONBOARDING_DESIGN §3.3).
 *
 * The first draws deterministically return the teaching cards in beat order
 * (infantry → tower → meteor) so the orientation/cap-point director always finds
 * them in a known hand slot; every later draw pulls deterministically from a
 * filler pool that *excludes* the teaching cards, so refilling a played teaching
 * card never wastes another and never duplicates one. This is a pure-engine,
 * seed-deterministic件 — it never calls Math.random and so preserves replay/裁判.
 *
 * Why not search a "magic seed" of {@link UniformCardDrawPolicy}? The draw
 * *request order* is coupled to the player's click timing, HAND_SIZE, and cooldown
 * constants, so any balance change would silently shuffle the teaching cards out of
 * position (§3.3 note). This policy is immune to all of that.
 */
export class TutorialDrawPolicy implements ICardDrawPolicy {
  private idx = 0;
  /** Stage C: uniform draw over the whole loadout (teaching cards re-included). */
  private freePlay = false;
  private readonly fullPool: readonly CardDefinition[];

  constructor(
    private readonly script: readonly CardDefinition[],
    private readonly filler: readonly CardDefinition[],
    private readonly prng: Prng,
  ) {
    this.fullPool = [...script, ...filler];
  }

  /**
   * 进阶段 C「自由发挥」：从「按拍发牌」切回整副 loadout 的随机循环（含三张引导卡）。
   * 仍是种子化确定性，不调 Math.random —— 由表现层导演在毕业窗触发（ONBOARDING_DESIGN §3.2.1）。
   */
  enterFreePlay(): void {
    this.freePlay = true;
  }

  draw(): CardDefinition {
    if (this.freePlay) {
      const pool = this.fullPool.length > 0 ? this.fullPool : CARD_DEFINITIONS;
      return pool[this.prng.nextInt(pool.length)]!;
    }
    if (this.idx < this.script.length) return this.script[this.idx++]!;
    const pool = this.filler.length > 0 ? this.filler : this.script;
    return pool[this.prng.nextInt(pool.length)]!;
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
      if (!slot) continue;
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

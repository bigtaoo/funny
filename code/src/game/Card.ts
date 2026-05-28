import { CARD_DEFINITIONS, HAND_SIZE } from './config';
import { Prng } from './math/prng';
import { CardDefinition } from './types';

export class Deck {
  private cards: CardDefinition[];

  /**
   * @param prng  Seeded PRNG — deterministic shuffle across all clients.
   *              Each player gets a separate PRNG instance derived from the game seed.
   */
  constructor(prng: Prng) {
    this.cards = prng.shuffle([...CARD_DEFINITIONS]);
  }

  get remaining(): number {
    return this.cards.length;
  }

  draw(): CardDefinition | null {
    return this.cards.pop() ?? null;
  }
}

export class Hand {
  readonly cards: (CardDefinition | null)[];

  constructor() {
    this.cards = new Array(HAND_SIZE).fill(null);
  }

  /**
   * Fill empty slots from deck.
   * Returns an array of { index, card } for each slot that was filled.
   */
  fill(deck: Deck): Array<{ index: number; card: CardDefinition }> {
    const drawn: Array<{ index: number; card: CardDefinition }> = [];
    for (let i = 0; i < this.cards.length; i++) {
      if (this.cards[i] === null && deck.remaining > 0) {
        const card = deck.draw()!;
        this.cards[i] = card;
        drawn.push({ index: i, card });
      }
    }
    return drawn;
  }

  /** Remove card at index and return it, or null if slot is empty. */
  play(index: number): CardDefinition | null {
    const card = this.cards[index] ?? null;
    this.cards[index] = null;
    return card;
  }

  hasCards(): boolean {
    return this.cards.some((c) => c !== null);
  }

  toArray(): CardDefinition[] {
    return this.cards.filter((c): c is CardDefinition => c !== null);
  }
}

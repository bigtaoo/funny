import { CARD_DEFINITIONS, HAND_SIZE } from './config';
import { CardDefinition } from './types';

/** Shuffle array in-place using Fisher-Yates */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Deck {
  private cards: CardDefinition[];

  constructor() {
    this.cards = shuffle([...CARD_DEFINITIONS]);
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

  fill(deck: Deck): void {
    for (let i = 0; i < this.cards.length; i++) {
      if (this.cards[i] === null && deck.remaining > 0) {
        this.cards[i] = deck.draw();
      }
    }
  }

  /** Remove card at index and return it, or null if slot is empty */
  play(index: number): CardDefinition | null {
    const card = this.cards[index] ?? null;
    this.cards[index] = null;
    return card;
  }

  /** True if any card is available */
  hasCards(): boolean {
    return this.cards.some((c) => c !== null);
  }

  /** Cards as flat list (excluding empty slots) */
  toArray(): CardDefinition[] {
    return this.cards.filter((c): c is CardDefinition => c !== null);
  }
}

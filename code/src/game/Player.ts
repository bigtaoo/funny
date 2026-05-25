import {
  BASE_HP,
  COIN_CAP,
  COIN_REGEN_BASE,
  BASE_UPGRADE_REGEN_BONUS,
} from './config';
import { Deck, Hand } from './Card';
import { Side } from './types';

export class Player {
  readonly side: Side;

  coins: number = 0;
  baseHp: number = BASE_HP;
  upgradeLevel: number = 0; // 0 = base, max 3

  readonly deck: Deck;
  readonly hand: Hand;

  constructor(side: Side) {
    this.side = side;
    this.deck = new Deck();
    this.hand = new Hand();
    // Draw initial hand
    this.hand.fill(this.deck);
  }

  get coinRegenRate(): number {
    return COIN_REGEN_BASE + this.upgradeLevel * BASE_UPGRADE_REGEN_BONUS;
  }

  get isDead(): boolean {
    return this.baseHp <= 0;
  }

  /** Add coins, capped at COIN_CAP */
  addCoins(amount: number): void {
    this.coins = Math.min(COIN_CAP, this.coins + amount);
  }

  /** Spend coins. Returns false if insufficient funds */
  spendCoins(amount: number): boolean {
    if (this.coins < amount) return false;
    this.coins -= amount;
    return true;
  }

  takeDamage(amount: number): void {
    this.baseHp = Math.max(0, this.baseHp - amount);
  }
}

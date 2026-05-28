import {
  BASE_HP,
  BASE_UPGRADE_COSTS,
  COIN_CAP,
} from './config';
import { FP_SCALE } from './math/fixed';
import { Deck, Hand } from './Card';
import { Prng } from './math/prng';
import { Side } from './types';

export class Player {
  readonly side: Side;

  /**
   * Internal coin accumulator in fixed-point.
   * ResourceSystem adds fp/tick; integer view is exposed via `coins` getter.
   * Using fp accumulation avoids any float arithmetic in the logic layer.
   */
  private _coins_fp: number = 0;

  baseHp: number = BASE_HP;

  /** 0 = no upgrade, max BASE_UPGRADE_COSTS.length */
  upgradeLevel: number = 0;

  readonly deck: Deck;
  readonly hand: Hand;

  constructor(side: Side, prng: Prng) {
    this.side = side;
    this.deck = new Deck(prng);
    this.hand = new Hand();
    // Draw initial hand (no events emitted here — GameEngine.emitInitialEvents handles that)
    this.hand.fill(this.deck);
  }

  // ── Derived getters ────────────────────────────────────────────────────────

  /**
   * Current integer coin count (floor of fp accumulator / FP_SCALE).
   * This is the value shown to the player and used for spending checks.
   */
  get coins(): number {
    return Math.trunc(this._coins_fp / FP_SCALE);
  }

  get isDead(): boolean {
    return this.baseHp <= 0;
  }

  // ── Mutation helpers ───────────────────────────────────────────────────────

  /**
   * Add coins via fixed-point increment. Called by ResourceSystem each tick.
   * Returns the integer delta (useful for event emission when it changes).
   */
  addCoinsFp(amount_fp: number): number {
    const before = this.coins;
    this._coins_fp = Math.min(COIN_CAP * FP_SCALE, this._coins_fp + amount_fp);
    return this.coins - before;
  }

  /** Deduct integer coins. Returns false if insufficient. */
  spendCoins(amount: number): boolean {
    if (this.coins < amount) return false;
    this._coins_fp -= amount * FP_SCALE;
    return true;
  }

  takeDamage(amount: number): void {
    this.baseHp = Math.max(0, this.baseHp - amount);
  }

  canUpgradeBase(): boolean {
    if (this.upgradeLevel >= BASE_UPGRADE_COSTS.length) return false;
    return this.coins >= BASE_UPGRADE_COSTS[this.upgradeLevel]!;
  }

  get nextUpgradeCost(): number | null {
    if (this.upgradeLevel >= BASE_UPGRADE_COSTS.length) return null;
    return BASE_UPGRADE_COSTS[this.upgradeLevel]!;
  }

  upgradeBase(): boolean {
    if (this.upgradeLevel >= BASE_UPGRADE_COSTS.length) return false;
    const cost = BASE_UPGRADE_COSTS[this.upgradeLevel]!;
    if (!this.spendCoins(cost)) return false;
    this.upgradeLevel++;
    return true;
  }
}

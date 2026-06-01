import {
  BASE_HP,
  BASE_UPGRADE_COSTS,
  COIN_CAP,
} from './config';
import { FP_SCALE } from './math/fixed';
import { Hand, UniformCardDrawPolicy, type ICardDrawPolicy } from './Card';
import { Prng } from './math/prng';
import { Side } from './types';

export class Player {
  readonly side: Side;

  /**
   * Internal coin accumulator in fixed-point.
   * ResourceSystem adds fp/tick; integer view is exposed via `coins` getter.
   */
  private _coins_fp: number = 0;

  baseHp: number = BASE_HP;

  /** 0 = no upgrade, max BASE_UPGRADE_COSTS.length */
  upgradeLevel: number = 0;

  readonly hand: Hand;

  /** Card draw policy — MVP: uniform random. Replace for weighted draws. */
  readonly drawPolicy: ICardDrawPolicy;

  /**
   * Separate PRNG used only for generating initial hand timer stagger offsets.
   * Kept separate so card draws and timer offsets don't interfere with each other.
   */
  readonly timerPrng: Prng;

  constructor(side: Side, cardPrng: Prng, timerPrng: Prng) {
    this.side        = side;
    this.drawPolicy  = new UniformCardDrawPolicy(cardPrng);
    this.timerPrng   = timerPrng;
    this.hand        = new Hand();
    // Hand is intentionally empty here.
    // GameEngine.emitInitialEvents() fills it with timer-staggered cards and emits events.
  }

  // ── Derived getters ────────────────────────────────────────────────────────

  get coins(): number {
    return Math.trunc(this._coins_fp / FP_SCALE);
  }

  get isDead(): boolean {
    return this.baseHp <= 0;
  }

  // ── Mutation helpers ───────────────────────────────────────────────────────

  addCoinsFp(amount_fp: number): number {
    const before = this.coins;
    this._coins_fp = Math.min(COIN_CAP * FP_SCALE, this._coins_fp + amount_fp);
    return this.coins - before;
  }

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

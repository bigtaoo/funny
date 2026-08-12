import {
  BASE_HP,
  BASE_UPGRADE_COSTS,
  INK_CAP,
} from './config';
import { FP_SCALE, toFp, maxFp, subFp, type Fp } from './math/fixed';
import { Hand, UniformCardDrawPolicy, type ICardDrawPolicy } from './Card';
import { Prng } from './math/prng';
import { Side } from './types';

export class Player {
  readonly side: Side;

  /**
   * Internal ink accumulator in fixed-point.
   * ResourceSystem adds fp/tick; integer view is exposed via `ink` getter.
   */
  private _ink_fp: number = 0;

  /** ADR-065: fp. `BASE_HP` (config.ts) is the real-unit constant, converted once here. */
  baseHp_fp: Fp = toFp(BASE_HP);

  /**
   * Base HP ceiling for this player (drives the HP-bar denominator in `base_hp_changed`). Defaults to the
   * global {@link BASE_HP}; a siege level can raise the DEFENDER's ceiling via `defenderBaseLevel`→`base.ts`
   * so an NPC tile's base scales with its level (SLG option 2, 2026-07-17). Set together with `baseHp_fp` at
   * init. ADR-065: fp.
   */
  maxBaseHp_fp: Fp = toFp(BASE_HP);

  /** 0 = no upgrade, max BASE_UPGRADE_COSTS.length */
  upgradeLevel: number = 0;

  readonly hand: Hand;

  /** Card draw policy — MVP: uniform random. Replace for weighted draws (e.g. campaign loadout). */
  drawPolicy: ICardDrawPolicy;

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

  get ink(): number {
    return Math.trunc(this._ink_fp / FP_SCALE);
  }

  get isDead(): boolean {
    return this.baseHp_fp <= 0;
  }

  // ── Mutation helpers ───────────────────────────────────────────────────────

  addInkFp(amount_fp: number): number {
    const before = this.ink;
    this._ink_fp = Math.min(INK_CAP * FP_SCALE, this._ink_fp + amount_fp);
    return this.ink - before;
  }

  spendInk(amount: number): boolean {
    if (this.ink < amount) return false;
    this._ink_fp -= amount * FP_SCALE;
    return true;
  }

  takeDamage(amount: Fp): void {
    this.baseHp_fp = maxFp(toFp(0), subFp(this.baseHp_fp, amount));
  }

  canUpgradeBase(): boolean {
    if (this.upgradeLevel >= BASE_UPGRADE_COSTS.length) return false;
    return this.ink >= BASE_UPGRADE_COSTS[this.upgradeLevel]!;
  }

  get nextUpgradeCost(): number | null {
    if (this.upgradeLevel >= BASE_UPGRADE_COSTS.length) return null;
    return BASE_UPGRADE_COSTS[this.upgradeLevel]!;
  }

  upgradeBase(): boolean {
    if (this.upgradeLevel >= BASE_UPGRADE_COSTS.length) return false;
    const cost = BASE_UPGRADE_COSTS[this.upgradeLevel]!;
    if (!this.spendInk(cost)) return false;
    this.upgradeLevel++;
    return true;
  }
}

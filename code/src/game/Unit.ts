import { UNIT_BLUEPRINTS } from './config';
import { GridPos, Side, UnitState, UnitType } from './types';

let nextId = 0;

export class Unit {
  readonly id: number;
  readonly unitType: UnitType;
  readonly side: Side;

  // Runtime stats
  col: number;
  row: number;       // exact grid row (float during movement)
  rowExact: number;  // sub-cell position for smooth movement
  hp: number;
  maxHp: number;
  attack: number;
  attackInterval: number;
  speed: number;     // grid cells per second (may be modified by haste)
  baseSpeed: number; // original speed before modifiers
  range: number;

  state: UnitState = UnitState.Moving;
  attackCooldown: number = 0; // seconds until next attack

  /** Target unit or building ID this unit is currently attacking */
  targetId: number | null = null;

  constructor(unitType: UnitType, side: Side, col: number, spawnRow: number) {
    this.id = nextId++;
    this.unitType = unitType;
    this.side = side;
    this.col = col;
    this.row = spawnRow;
    this.rowExact = spawnRow;

    const bp = UNIT_BLUEPRINTS[unitType];
    this.hp = bp.hp;
    this.maxHp = bp.hp;
    this.attack = bp.attack;
    this.attackInterval = bp.attackInterval;
    this.speed = bp.speed;
    this.baseSpeed = bp.speed;
    this.range = bp.range;
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }

  get pos(): GridPos {
    return { col: this.col, row: Math.round(this.row) };
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) this.state = UnitState.Dead;
  }

  resetSpeed(): void {
    this.speed = this.baseSpeed;
  }
}

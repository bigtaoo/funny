import { BUILDING_BLUEPRINTS } from './config';
import { BuildingType, Side } from './types';

let nextId = 1000; // start above Unit IDs range to avoid collision

export class Building {
  readonly id: number;
  readonly buildingType: BuildingType;
  readonly side: Side;
  readonly col: number;
  readonly row: number;

  hp: number;
  maxHp: number;
  attack: number;
  attackInterval: number;
  attackRange: number;
  attackCooldown: number = 0;

  /** For barracks: seconds until next unit spawn */
  spawnCooldown: number = 0;

  constructor(buildingType: BuildingType, side: Side, col: number, row: number) {
    this.id = nextId++;
    this.buildingType = buildingType;
    this.side = side;
    this.col = col;
    this.row = row;

    const bp = BUILDING_BLUEPRINTS[buildingType];
    this.hp = bp.hp;
    this.maxHp = bp.hp;
    this.attack = bp.attack ?? 0;
    this.attackInterval = bp.attackInterval ?? Infinity;
    this.attackRange = bp.attackRange ?? 0;
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }

  get isAttacker(): boolean {
    return this.buildingType === BuildingType.Barracks;
  }

  get isDefender(): boolean {
    return this.buildingType === BuildingType.ArrowTower;
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
  }
}

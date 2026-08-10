// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Pure enums shared across the whole engine (units/buildings/spells/cards/sides/phases/states) —
// zero dependencies, zero shared state, the natural first cut for a domain split.

export enum UnitType {
  Infantry = 'infantry',
  ShieldBearer = 'shieldbearer',
  Archer = 'archer',
  /** PvE-only heavy: very high HP, very slow, soaks arrow-tower fire. No card → never in the PvP pool. */
  Ironclad = 'ironclad',
  /** PvE-only rusher: fragile, fast, small radius (packs densely). No card → never in the PvP pool. */
  Runner = 'runner',
  /** PvE-only flying unit: fast, fragile, bypasses ground collision and blocked cells.
   *  Only arrow towers and archer units (canTargetFlying) can hit it. No card → never in PvP. */
  Harpy = 'harpy',
  /** PvE-only support: no attack, emits an aura_heal aura that regenerates nearby ally HP.
   *  Must be prioritised or killed before engaging the main force. No card → never in PvP. */
  Medic = 'medic',
  /** PvE-only rage brawler: normal stats, but attack speed ×1.5 when HP falls below 40%.
   *  Killing it quickly is better than letting it rage. No card → never in PvP. */
  Berserker = 'berserker',
  /** PvE-only bomb unit: dies and spawns 2 Runners, making it worse to ignore.
   *  Kill it with area damage or it becomes a swarm on death. No card → never in PvP. */
  Splitter = 'splitter',
  /** Anna-side vanguard: burstOnSingle deals 2× damage when only one enemy remains. Unlocked via PvE ch2. */
  Max = 'max',
  /** Anna-side sentinel: disciplineArmor=8 reduces every hit by 8 (min 1). Unlocked via PvE ch4. */
  Lena = 'lena',
  /** Anna-side skirmisher: markEnemies marks targets for +25 % bonus damage from all sources. Unlocked via PvE ch6. */
  Mara = 'mara',
}

export enum BuildingType {
  Barracks = 'barracks',
  ArrowTower = 'arrow_tower',
}

export enum SpellType {
  Haste = 'haste',
  Meteor = 'meteor',
  Rockslide = 'rockslide',
  BridgeCollapse = 'bridge_collapse',
}

export enum CardType {
  Unit = 'unit',
  Building = 'building',
  Spell = 'spell',
}

export enum Side {
  Bottom = 'bottom', // local player  — row 0 is home; units move toward row 17
  Top = 'top',       // opponent (AI) — row 17 is home; units move toward row 0
}

export enum GamePhase {
  Idle    = 'idle',
  Playing = 'playing',
  Paused  = 'paused',
  GameOver = 'gameover',
}

export enum UnitState {
  Moving    = 'moving',
  Attacking = 'attacking',
  Waiting   = 'waiting',   // blocked by friendly unit in front
  Crossing  = 'crossing',  // in building row, moving horizontally toward base cols
  Detour    = 'detour',   // mid-lane horizontal redirect (crossWaypoints / blocked auto-detour)
  Dead      = 'dead',
}

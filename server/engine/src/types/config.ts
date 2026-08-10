// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Engine boot-time config: game mode/difficulty, the GameConfig the engine is constructed with,
// and the player command union it consumes each tick. Not to be confused with the top-level
// engine/src/config.ts (balance numbers) — this is the *shape* of engine input, not tuning data.
import type { LevelDefinition } from '../campaign/LevelDefinition';
// Type-only reference (erased at compile time) → does not create a runtime cycle with balance/equipment.ts's runtime reference to UnitType.
import type { EngineCardInstance, EngineEquipInv } from '../balance/equipment';
import type { OwnerId } from './coords';

/**
 * Game mode.
 *   `pvp`      — duel driven by AISystem (the Top side is the local bot).
 *   `campaign` — PvE scripted waves (WaveDirector).
 *   `siege`    — SLG siege battle (S8-3): mechanically identical to `campaign` (the
 *                defender is a scripted `WaveDirector` from a defense-config
 *                `LevelDefinition`, the local player is the attacker), differing
 *                ONLY in the blueprint source — `buildSiegeBlueprints(pveUpgrades)`
 *                instead of `buildCampaignBlueprints`. Same upgrade tree feeds
 *                both PvE and SLG (SLG_DESIGN §6.2); the PvP hard wall is untouched
 *                because `buildPvpBlueprints()` has no upgrade param (§6.1).
 *   `netplay`  — online lockstep PvP: BOTH sides are humans, commands for both
 *                arrive (pre-confirmed, per frame) from the `NetInputSource`.
 *                No local AI and no WaveDirector run — the engine only processes
 *                the confirmed command set, so two clients on the same seed +
 *                same frame stream stay byte-identical (S1-7).
 */
export type GameMode = 'pvp' | 'campaign' | 'netplay' | 'siege';

/**
 * AI skill level for `mode: 'pvp'` (AISystem.ts) — 1 (passive punching bag) to
 * 10 (professional-level play). See AISystem.ts for the full difficulty curve
 * and the fair-play invariant (public-state-only decisions, bounded reaction speed).
 */
export type AIDifficulty = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface GameConfig {
  /** PRNG seed — determines card draws for both players. Required. */
  seed: number;
  players: [PlayerConfig, PlayerConfig];
  /** Defaults to 'pvp'. In 'campaign' the enemy is driven by a WaveDirector. */
  mode?: GameMode;
  /** AI skill level for 'pvp' mode. Defaults to 5 (mid-curve). Ignored by campaign/siege (WaveDirector) and netplay (no AI). */
  difficulty?: AIDifficulty;
  /** Campaign level — required when mode === 'campaign'. */
  level?: LevelDefinition;
  /**
   * Hero Roster card instances (CC-1, CHARACTER_CARDS_DESIGN §2), read ONLY on the PvE-shaped paths
   * (campaign / siege). The hard wall (§5.2): `buildPvpBlueprints()` has no card param,
   * so card progression can't leak into ladder/duel PvP. Pass SaveData.cardInv values with resolved unitType.
   */
  cardInstances?: EngineCardInstance[];
  /**
   * Equipment instance inventory (SaveData.equipmentInv), read ONLY on the PvE-shaped paths (campaign / siege).
   * Used by applyEquipment to resolve gear slot instance IDs within each CardInstance.
   * Same hard wall: buildPvpBlueprints() has no equipment param → PvP equipment contamination is impossible at compile time.
   */
  equipmentInv?: EngineEquipInv;
  /**
   * PvP/netplay deck loadouts (PVP_LOADOUT_DESIGN §6.2).
   * When provided, each player draws only from their specified card subset
   * (filtered against CARD_DEFINITIONS by card id).
   * Server-authoritative: both clients receive identical decks via match_start,
   * guaranteeing lockstep draw consistency. Omit to use the full pool (P1 default).
   */
  decks?: { top: string[]; bottom: string[] };
  /**
   * Academy building seasonal blueprint buffs (SLG_CITY_DESIGN P2 §5): applied only on the 'siege' path
   * as a fractional bonus on top of pveUpgrades. Ignored by PvP/campaign/netplay.
   * {hp: 0.06, damage: 0.045, siege: 0.045} = +6% HP, +4.5% attack, +4.5% siege value to all attacker units.
   */
  siegeAcademy?: { hp: number; damage: number; siege: number };
}

export interface PlayerConfig {
  id: OwnerId;
}

export type PlayerCommand =
  | {
      type: 'play_card';
      owner: OwnerId;
      tick: number;
      handIndex: number;
      col?: number;  // unit/building: target column; spell: center column
      row?: number;  // spell: center row (meteor)
    }
  | {
      type: 'upgrade_base';
      owner: OwnerId;
      tick: number;
    }
  | {
      type: 'refresh_hand';
      owner: OwnerId;
      tick: number;
    };

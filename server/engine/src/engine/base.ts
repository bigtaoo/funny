// Shared foundation for the GameEngine mixin chain (see ../GameEngine.ts assembly).
// Holds the engine's field state + the full constructor (mode setup, PvE level wiring, PvP
// deck policies). Construction is one linear sequence, not a reusable cross-mixin helper, so
// it stays whole here rather than being split further. Domain mixins each live in their own
// sibling file and are chained together in ../GameEngine.ts.
//
// Fields are `protected` (not `private`) so mixin method bodies — moved verbatim from the
// original monolithic GameEngineImpl — keep compiling unchanged.
import {
  BOARD_ROWS,
  CARD_DEFINITIONS,
  SPELL_CARD_DEFS,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
} from '../config';
import { toFp } from '../math/fixed';
import { buildPvpBlueprints, buildCampaignBlueprints, buildSiegeBlueprints } from '../balance/pveUpgrades';
import { UniformCardDrawPolicy, TutorialDrawPolicy } from '../Card';
import { TUTORIAL_LEVEL_ID, TUTORIAL_TEACHING_CARDS } from '../campaign/tutorial';
import { Building } from '../Building';
import { Unit } from '../Unit';
import { Prng } from '../math/prng';
import { GameState } from '../GameState';
import { AISystem } from '../systems/AISystem';
import { WaveDirector } from '../campaign/WaveDirector';
import { EscortUnit } from '../EscortUnit';
import { EscortSystem } from '../systems/EscortSystem';
import type { InputSource } from '../net/InputSource';
import type { LevelDefinition } from '../campaign/LevelDefinition';
import { BuildingProductionSystem } from '../systems/BuildingProductionSystem';
import { CombatSystem } from '../systems/CombatSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { ResourceSystem } from '../systems/ResourceSystem';
import { SpellSystem } from '../systems/SpellSystem';
import { HazardSystem } from '../systems/HazardSystem';
import { TraitSystem } from '../systems/TraitSystem';
import {
  CardDefinition,
  GameConfig,
  GameMode,
  Side,
  UnitType,
  UnitBlueprint,
} from '../types';

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type GameEngineBaseCtor = Constructor<GameEngineBase>;

export class GameEngineBase {
  readonly state: GameState;

  protected readonly resource:   ResourceSystem;
  protected readonly movement:   MovementSystem;
  protected readonly combat:     CombatSystem;
  protected readonly escort:     EscortSystem;
  protected readonly hazard:     HazardSystem;
  protected readonly spell:      SpellSystem;
  protected readonly production: BuildingProductionSystem;
  protected readonly trait:      TraitSystem;
  protected readonly ai:         AISystem;

  protected readonly mode:          GameMode;
  protected readonly level:         LevelDefinition | null;
  protected readonly waveDirector:  WaveDirector | null;

  protected firstStep = true;
  protected accumulatedTime = 0;
  protected currentTick = 0;
  protected readonly input: InputSource;
  /** Spell cards to force-inject into the player's opening hand (levelSpells). */
  protected initialSpellCards: CardDefinition[] = [];
  /** Garrison units (U10): pre-placed defender units awaiting their spawn events. */
  protected readonly garrisonUnits: Unit[] = [];
  /** Attacker army (G3, §16): pre-placed Bottom-side units awaiting their spawn events. */
  protected readonly attackerArmyUnits: Unit[] = [];
  /** Defender buildings (U10): pre-placed buildings awaiting their placed events. */
  protected readonly defenderBuildingList: Building[] = [];
  /**
   * Blueprints used by wave-spawned enemies (§4.10). Defaults to the shared
   * {@link GameState.unitBlueprints}; when a campaign level sets `enemyScale`,
   * it's an independent, progression-free, per-level-scaled set instead.
   */
  protected enemyWaveBlueprints!: Record<UnitType, UnitBlueprint>;

  constructor(config: GameConfig, input: InputSource) {
    this.input      = input;
    this.state      = new GameState(config.seed);
    this.resource   = new ResourceSystem();
    this.movement   = new MovementSystem();
    this.combat     = new CombatSystem();
    this.escort     = new EscortSystem();
    this.hazard     = new HazardSystem();
    this.spell      = new SpellSystem();
    this.production = new BuildingProductionSystem();
    this.trait      = new TraitSystem();
    this.ai         = new AISystem(new Prng(config.seed ^ 0xA1A1A1A1), config.difficulty ?? 5);

    this.mode = config.mode ?? 'pvp';

    // PvE-shaped modes: scripted enemy (WaveDirector) + upgrade-buffed blueprints.
    // `campaign` (single-player PvE) and `siege` (SLG siege battle, S8-3) share the same
    // mechanics; they differ only in which builder injects the upgrade levels.
    const pve = this.mode === 'campaign' || this.mode === 'siege';

    // Hard wall (§5.2 / §6.1): the PvE-shaped paths are the ONLY place upgrades
    // enter the engine. PvP / netplay always get the read-only constants.
    // buildPvpBlueprints' signature has no SaveData/upgrade param, so power can't
    // leak into PvP. `siege` reuses the upgrade tree (SLG_DESIGN §6.2) via a
    // distinctly-named builder, keeping the red line explicit.
    this.state.unitBlueprints =
      this.mode === 'campaign'
        ? buildCampaignBlueprints(config.cardInstances ?? [], config.equipmentInv)
        : this.mode === 'siege'
        ? buildSiegeBlueprints(config.cardInstances ?? [], config.equipmentInv, config.siegeAcademy)
        : buildPvpBlueprints();

    // Enemy (Top side) wave blueprints (§4.10). By default enemies share the
    // player's campaign blueprints. When a campaign level sets `enemyScale`,
    // wave enemies instead use a progression-free base set (so the player's own
    // unit levels / equipment / upgrades can't leak into same-type enemies —
    // matters in ch2 where the bot fields the player's ch1-leveled Tao units)
    // multiplied by the per-level hp / damage factors.
    this.enemyWaveBlueprints = this.state.unitBlueprints;
    const enemyScale = this.mode === 'campaign' ? config.level?.enemyScale : undefined;
    if (enemyScale) {
      const hpMult  = enemyScale.hp     ?? 1;
      const dmgMult = enemyScale.damage ?? 1;
      const scaled = buildPvpBlueprints();
      for (const key of Object.keys(scaled) as UnitType[]) {
        const bp = scaled[key];
        bp.hp     = Math.max(1, Math.round(bp.hp * hpMult));
        bp.attack = Math.max(1, Math.round(bp.attack * dmgMult));
      }
      this.enemyWaveBlueprints = scaled;
    }

    if (pve) {
      if (!config.level) throw new Error(`${this.mode} mode requires a level definition`);
      this.level        = config.level;
      this.waveDirector = new WaveDirector(config.level, new Prng(config.seed ^ 0x5A5A5A5A));

      // Apply level setup: blocked cells, no-build cells, hazards, starting ink.
      const blocked = config.level.board?.cellMask?.blocked;
      if (blocked && blocked.length > 0) this.state.board.setBlocked(blocked);
      const noBuild = config.level.board?.cellMask?.noBuild;
      if (noBuild && noBuild.length > 0) this.state.board.setNoBuild(noBuild);
      const activeLanes = config.level.board?.activeLanes;
      if (activeLanes && activeLanes.length > 0) this.state.board.setActiveLanes(activeLanes);
      if (config.level.hazards && config.level.hazards.length > 0) {
        this.state.hazards = config.level.hazards;
      }
      if (config.level.startInk) {
        this.state.bottomPlayer.addInkFp(toFp(config.level.startInk));
      }

      // Ink regen multiplier for the bottom (human) player.
      if (config.level.inkRegenMult !== undefined) {
        this.state.bottomInkRegenMult = config.level.inkRegenMult;
      }

      // laneLength (§4.9.1): truncate the top of each specified lane so enemies
      // spawn closer to the player's base. Rows above the new spawn row are added
      // to the blocked set (merged with any cellMask.blocked from the level JSON).
      const laneLength = config.level.board?.laneLength;
      if (laneLength) {
        const laneLengthBlocked: { col: number; row: number }[] = [];
        for (const [colStr, len] of Object.entries(laneLength)) {
          const col = Number(colStr);
          const spawnRow = BOARD_ROWS - len;
          for (let row = spawnRow + 1; row <= TOP_SPAWN_ROW; row++) {
            laneLengthBlocked.push({ col, row });
          }
        }
        if (laneLengthBlocked.length > 0) {
          const existing = this.state.board.getBlockedCells();
          this.state.board.setBlocked([...existing, ...laneLengthBlocked]);
        }
      }

      // Escort units (§4.9.3): created here so they're ready for emitInitialEvents.
      if (config.level.escorts) {
        for (const spec of config.level.escorts) {
          this.state.escorts.push(new EscortUnit(spec));
        }
      }

      // SLG defense config (U10) — garrison, defender buildings, base level.
      // These three knobs let a player-authored defense config pre-shape the
      // battle exactly like a hand-crafted campaign level would.

      // Garrison: pre-placed Top-side units at their specified mid-field positions.
      // Tracked in garrisonUnits[] so emitInitialEvents() can emit spawn events.
      if (config.level.garrison) {
        for (const entry of config.level.garrison) {
          const bp = this.state.unitBlueprints[entry.unitType];
          const unit = new Unit(entry.unitType, Side.Top, entry.col, entry.row, bp, entry.initialHp);
          this.state.board.addUnit(unit);
          this.garrisonUnits.push(unit);
        }
      }

      // Attacker army (G3, §16): the attacker's pre-deployed units on the Bottom
      // (owner 0) half. Mirror of the garrison block above — same construction,
      // opposite side. Tracked in attackerArmyUnits[] so emitInitialEvents() can
      // emit owner-0 spawn + move-toward-enemy-base events. troops = HP via
      // entry.initialHp (§16.1). No live card play needed: these advance on tick 1.
      if (config.level.attackerArmy) {
        for (const entry of config.level.attackerArmy) {
          const bp = this.state.unitBlueprints[entry.unitType];
          const unit = new Unit(entry.unitType, Side.Bottom, entry.col, entry.row, bp, entry.initialHp);
          this.state.board.addUnit(unit);
          this.attackerArmyUnits.push(unit);
        }
      }

      // Defender buildings: pre-placed buildings on the Top player's building row.
      // Tracked in defenderBuildingList[] for emitInitialEvents() event emission.
      if (config.level.defenderBuildings) {
        for (const entry of config.level.defenderBuildings) {
          const building = new Building(entry.buildingType, Side.Top, entry.col, TOP_BUILDING_ROW);
          this.state.board.addBuilding(building);
          this.defenderBuildingList.push(building);
        }
      }

      // Defender base level: pre-apply upgrade levels for the Top player.
      // Sets upgradeLevel directly (skips ink cost) — this represents the defender's
      // investment in their base before the attacker arrives.
      if (config.level.defenderBaseLevel && config.level.defenderBaseLevel > 0) {
        this.state.topPlayer.upgradeLevel = config.level.defenderBaseLevel;
      }

      // Loadout / banned cards + level spells (§4.7, §4.9.2).
      // Build a unified card pool for the bottom player's draw policy that
      // respects loadout/ban filters and includes any PvE-only spell cards.
      const { loadout, bannedCards, levelSpells } = config.level;
      const loadoutSet = loadout     ? new Set(loadout)     : null;
      const bannedSet  = bannedCards ? new Set(bannedCards) : null;
      const needsCustomPolicy = loadoutSet || bannedSet || (levelSpells && levelSpells.length > 0);
      if (needsCustomPolicy) {
        const pool = (CARD_DEFINITIONS as readonly CardDefinition[]).filter((c) => {
          if (loadoutSet && !loadoutSet.has(c.id)) return false;
          if (bannedSet  && bannedSet.has(c.id))   return false;
          return true;
        });
        // Append spell card defs to the draw pool so they appear in refreshes too.
        const spellDefs: CardDefinition[] = [];
        if (levelSpells) {
          for (const { cardId, initialCount } of levelSpells) {
            const def = SPELL_CARD_DEFS.get(cardId);
            if (!def) throw new Error(`levelSpells: unknown spell card '${cardId}'`);
            spellDefs.push(def);
            for (let i = 0; i < initialCount; i++) this.initialSpellCards.push(def);
          }
        }
        const finalPool = pool.length > 0 || spellDefs.length > 0
          ? [...pool, ...spellDefs]
          : undefined;
        // Use a separate PRNG so loadout levels are deterministic and don't
        // disturb levels that draw from the full CARD_DEFINITIONS pool.
        const drawPrng = new Prng(config.seed ^ 0xC0FFEE00);
        if (config.level.id === TUTORIAL_LEVEL_ID) {
          // Dedicated tutorial level: scripted draw so the cap-point director always finds the
          // teaching cards in order (ONBOARDING_DESIGN §3.3). The filler pool is
          // the loadout minus the teaching cards so a played teaching card never
          // refills into another teaching card. Stage C swaps this back to a
          // UniformCardDrawPolicy in the render-layer director.
          const teach: CardDefinition[] = [];
          for (const id of TUTORIAL_TEACHING_CARDS) {
            const def = pool.find((c) => c.id === id);
            if (def) teach.push(def);
          }
          const teachSet = new Set<string>(TUTORIAL_TEACHING_CARDS);
          const filler = pool.filter((c) => !teachSet.has(c.id));
          this.state.bottomPlayer.drawPolicy = new TutorialDrawPolicy(teach, filler, drawPrng);
        } else {
          this.state.bottomPlayer.drawPolicy = new UniformCardDrawPolicy(drawPrng, finalPool);
        }
      }
    } else {
      this.level        = null;
      this.waveDirector = null;

      // PvP/netplay dual draw policy (PVP_LOADOUT_DESIGN §6.1–6.2).
      // When the server supplies deck lists, replace each player's default
      // full-pool policy with a filtered one. Fresh PRNG instances use the
      // same seed derivation as GameState so both clients produce byte-identical
      // draw sequences for each side regardless of network arrival order.
      if (config.decks) {
        const buildDeckPolicy = (deckIds: string[], seed: number) => {
          const deckSet = new Set(deckIds);
          const pool = (CARD_DEFINITIONS as readonly CardDefinition[]).filter((c) => deckSet.has(c.id));
          const prng = new Prng(seed);
          return new UniformCardDrawPolicy(prng, pool.length > 0 ? pool : undefined);
        };
        this.state.bottomPlayer.drawPolicy = buildDeckPolicy(config.decks.bottom, config.seed);
        this.state.topPlayer.drawPolicy    = buildDeckPolicy(config.decks.top,    config.seed ^ 0xdeadbeef);
      }
    }
  }
}

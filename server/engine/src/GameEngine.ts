import {
  ATTACK_LANES,
  BOARD_ROWS,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  BRIDGE_COLLAPSE_DURATION_TICKS,
  CARD_DEFINITIONS,
  CARD_REFRESH_INITIAL_OFFSET_MAX,
  CARD_REFRESH_TICKS,
  COUNTDOWN_THRESHOLD_TICKS,
  FORCE_DRAW_THRESHOLD_TICKS,
  HAND_REFRESH_COST,
  HAND_SIZE,
  ROCKSLIDE_DAMAGE,
  SPELL_CARD_DEFS,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
} from './config';
import { toFp, TICK_RATE } from './math/fixed';
import { buildPvpBlueprints, buildCampaignBlueprints, buildSiegeBlueprints } from './balance/pveUpgrades';
import { cardRefreshDuration, UniformCardDrawPolicy, TutorialDrawPolicy } from './Card';
import { TUTORIAL_LEVEL_ID, TUTORIAL_TEACHING_CARDS } from './campaign/tutorial';
import { Building } from './Building';
import { Player } from './Player';
import { Unit } from './Unit';
import { Prng } from './math/prng';
import { GameState } from './GameState';
import { AISystem } from './systems/AISystem';
import { WaveDirector } from './campaign/WaveDirector';
import { EscortUnit } from './EscortUnit';
import { EscortSystem } from './systems/EscortSystem';
import { InputSource, LocalInputSource } from './net/InputSource';
import type { LevelDefinition } from './campaign/LevelDefinition';
import { BuildingProductionSystem } from './systems/BuildingProductionSystem';
import { CombatSystem } from './systems/CombatSystem';
import { MovementSystem } from './systems/MovementSystem';
import { ResourceSystem } from './systems/ResourceSystem';
import { SpellSystem } from './systems/SpellSystem';
import { HazardSystem } from './systems/HazardSystem';
import { TraitSystem } from './systems/TraitSystem';
import {
  CardDefinition,
  CardType,
  GameConfig,
  GameEvent,
  GameMode,
  GamePhase,
  IGameEngine,
  OwnerId,
  ownerToSide,
  PlayerCommand,
  Side,
  SpellType,
  sideToOwner,
  UnitType,
  UnitBlueprint,
} from './types';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a game engine.
 *
 * `input` is the unified input pipeline (M13). Defaults to `LocalInputSource`
 * (single-player / practice: UI commands self-forward to the current tick with
 * zero delay). Online play (S1-7) and replay (S1-RP) inject `NetInputSource` /
 * `ReplayInputSource` here instead — the engine code is unchanged.
 */
export function createGameEngine(config: GameConfig, input?: InputSource): IGameEngine {
  return new GameEngineImpl(config, input ?? new LocalInputSource());
}

// ─── Implementation (not exported) ───────────────────────────────────────────

class GameEngineImpl implements IGameEngine {
  readonly state: GameState;

  private readonly resource:   ResourceSystem;
  private readonly movement:   MovementSystem;
  private readonly combat:     CombatSystem;
  private readonly escort:     EscortSystem;
  private readonly hazard:     HazardSystem;
  private readonly spell:      SpellSystem;
  private readonly production: BuildingProductionSystem;
  private readonly trait:      TraitSystem;
  private readonly ai:         AISystem;

  private readonly mode:          GameMode;
  private readonly level:         LevelDefinition | null;
  private readonly waveDirector:  WaveDirector | null;

  private firstStep = true;
  private accumulatedTime = 0;
  private currentTick = 0;
  private readonly input: InputSource;
  /** Spell cards to force-inject into the player's opening hand (levelSpells). */
  private initialSpellCards: CardDefinition[] = [];
  /** Garrison units (U10): pre-placed defender units awaiting their spawn events. */
  private readonly garrisonUnits: Unit[] = [];
  /** Attacker army (G3, §16): pre-placed Bottom-side units awaiting their spawn events. */
  private readonly attackerArmyUnits: Unit[] = [];
  /** Defender buildings (U10): pre-placed buildings awaiting their placed events. */
  private readonly defenderBuildingList: Building[] = [];
  /**
   * Blueprints used by wave-spawned enemies (§4.10). Defaults to the shared
   * {@link GameState.unitBlueprints}; when a campaign level sets `enemyScale`,
   * it's an independent, progression-free, per-level-scaled set instead.
   */
  private enemyWaveBlueprints!: Record<UnitType, UnitBlueprint>;

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
    this.ai         = new AISystem(new Prng(config.seed ^ 0xA1A1A1A1));

    this.mode = config.mode ?? 'pvp';

    // PvE-shaped modes: scripted enemy (WaveDirector) + upgrade-buffed blueprints.
    // `campaign` (single-player PvE) and `siege` (SLG 围攻, S8-3) share the same
    // mechanics; they differ only in which builder injects the upgrade levels.
    const pve = this.mode === 'campaign' || this.mode === 'siege';

    // Hard wall (§5.2 / §6.1): the PvE-shaped paths are the ONLY place upgrades
    // enter the engine. PvP / netplay always get the read-only constants.
    // buildPvpBlueprints' signature has no SaveData/upgrade param, so power can't
    // leak into PvP. `siege` reuses the upgrade tree (SLG_DESIGN §6.2) via a
    // distinctly-named builder, keeping the red line explicit.
    this.state.unitBlueprints =
      this.mode === 'campaign'
        ? buildCampaignBlueprints(config.pveUpgrades ?? {}, config.equipment, config.unitLevels)
        : this.mode === 'siege'
        ? buildSiegeBlueprints(config.pveUpgrades ?? {}, config.equipment, config.unitLevels)
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
    }
  }

  // ─── Render-facing API ───────────────────────────────────────────────────

  /**
   * Max wall-clock the accumulator may bank, in *catch-up* ticks. Bounds how
   * much real time one tick() call may convert to sim steps, so a long pause
   * (backgrounded tab, GC hitch, or a resolved lockstep stall) can't bank an
   * unbounded burst. At catch-up speed N this still permits N× this many sim
   * steps in a single tick() — that is the intended fast-forward.
   */
  private static readonly MAX_CATCHUP_TICKS = 5;

  /**
   * Catch-up speed multiplier (sim ticks per wall-clock tick) based on how far
   * the confirmed watermark has outrun our playback head. A client that paused
   * (minimized tab → rAF halts) or stalled keeps receiving frame_batches, so on
   * resume the backlog can be huge; draining it at 1× would never sync. Speed up
   * proportionally to the backlog so we converge, then settle back to 1×.
   *
   *   backlog > 30 s → 5×   |   > 10 s → 3×   |   > 1 s → 2×   |   else 1×
   *
   * Only re-times step() calls — never changes which frames run or their order,
   * so lockstep determinism is unaffected.
   */
  private catchUpSpeed(): number {
    const lead = this.input.confirmedLead?.(this.currentTick) ?? 0;
    if (lead > 30 * TICK_RATE) return 5;
    if (lead > 10 * TICK_RATE) return 3;
    if (lead > 1 * TICK_RATE) return 2;
    return 1;
  }

  tick(dt: number): void {
    const tickDt = 1 / TICK_RATE;
    this.accumulatedTime += dt;

    // When playback has fallen behind the confirmed watermark, spend each banked
    // millisecond on more than one sim step so we catch up to the server.
    const speed = this.catchUpSpeed();
    const stepDt = tickDt / speed;

    // Cap banked time — prevents post-pause bursts and the spiral-of-death. The
    // bound is on real time (MAX_CATCHUP_TICKS at 1×); at speed N this still
    // allows N× as many sim steps to drain, which is the catch-up we want.
    const maxAccum = tickDt * GameEngineImpl.MAX_CATCHUP_TICKS;
    if (this.accumulatedTime > maxAccum) this.accumulatedTime = maxAccum;

    // Collect every sim step's events into a per-frame union. The renderer
    // consumes state.events once per render frame, but step() clears + rebuilds
    // the queue each step — so without this a catch-up frame (≥2 steps) would
    // drop all but the last step's events (losing terminal projectile_hit/
    // expired → leaked arrow sprites), and a 0-step frame (render runs faster
    // than TICK_RATE) would re-consume the previous step's events (duplicate
    // projectile_fired → orphaned sprites). We assemble the union here and write
    // it back at the end so state.events means "events produced this frame".
    const frameEvents: GameEvent[] = [];
    while (this.accumulatedTime >= stepDt) {
      // Pull the confirmed command set for this frame from the input pipeline.
      // LocalInputSource never stalls; a net source returns null when the frame
      // is not yet confirmed, in which case we stop advancing (S1-7 buffering).
      const cmds = this.input.take(this.currentTick);
      if (cmds === null) {
        // Lockstep stall: the next frame isn't confirmed yet. Drop banked time
        // back to a single step so that when the frame lands we resume at the
        // natural cadence rather than replaying the whole buffered batch in one
        // render frame — that burst-then-idle is exactly the choppy,
        // 10 Hz-looking stutter. Re-times step() calls only; never changes which
        // frames run or their order, so determinism is unaffected.
        if (this.accumulatedTime > stepDt) this.accumulatedTime = stepDt;
        break;
      }
      this.accumulatedTime -= stepDt;
      const stepEvents = this.step(this.currentTick++, cmds);
      if (stepEvents.length) frameEvents.push(...stepEvents);
    }
    // Always overwrite — on a 0-step frame this clears stale events so the
    // renderer doesn't re-process them.
    this.state.setEvents(frameEvents);
  }

  playCard(handIndex: number, col: number, row?: number): void {
    this.input.submit({ type: 'play_card', owner: 0, tick: this.currentTick, handIndex, col, row });
  }

  upgradeBase(): void {
    this.input.submit({ type: 'upgrade_base', owner: 0, tick: this.currentTick });
  }

  refreshHand(): void {
    this.input.submit({ type: 'refresh_hand', owner: 0, tick: this.currentTick });
  }

  // ─── IGameEngine ─────────────────────────────────────────────────────────

  /**
   * step() execution order:
   *   1. Emit initial events (first call only)
   *   2. AI commands + filtered external commands
   *   3. Process all commands (play_card / upgrade_base)
   *   4. Resources (coin regen)
   *   5. Building production (barracks spawn)
   *   6. Combat (attack, damage, deaths)
   *   7. Movement (advance positions)
   *   8. Spells (duration countdown, expiry)
   *   9. Hand refresh timers
   *  10. Building survival stats
   *  11. Win condition check
   */
  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[] {
    // After game over, step returns early without clearing the event queue: if we cleared it,
    // game_over would remain in state.events and be re-consumed by the render layer every frame
    // (the root cause of duplicate settlement / double-fire analytics bugs). We do NOT clear here —
    // in a catch-up scenario with multiple steps/frames, clearing within the same tick would cause
    // the render layer to miss game_over. The GameRenderer's gameEnded one-shot gate handles it instead.
    if (this.state.phase === GamePhase.GameOver) return [];

    if (this.state.phase === GamePhase.Idle) {
      this.state.phase = GamePhase.Playing;
    }

    this.state.clearEvents();
    this.state.elapsedTicks++;

    if (this.firstStep) {
      this.firstStep = false;
      this.emitInitialEvents();
    }

    // ── Commands ──────────────────────────────────────────────────────────
    // `commands` is the player's confirmed set for this tick, pulled from the
    // InputSource (M13). AI (practice) and WaveDirector (PvE) are the engine's
    // *other* in-tick input sources, generated deterministically from state.
    const externalCmds = commands.filter((c) => c.tick === tick);
    if (this.waveDirector) {
      // PvE-shaped (campaign / siege): process player commands, then spawn the
      // scripted enemy waves directly (bypassing the enemy hand/coin economy).
      for (const cmd of externalCmds) {
        this.processCommand(cmd);
      }
      for (const spawn of this.waveDirector.tick(tick)) {
        this.spawnEnemyUnit(spawn.unitType, spawn.col, spawn.isBoss, spawn.crossWaypoints);
      }
    } else if (this.mode === 'netplay') {
      // Online lockstep PvP (S1-7): both sides are humans. `commands` is the
      // server-confirmed set for this frame (already containing BOTH sides'
      // commands, decoded from frame_batch). No local AI runs — the confirmed
      // stream is the *only* input, which is exactly what keeps two clients on
      // the same seed + same stream byte-identical.
      for (const cmd of externalCmds) {
        this.processCommand(cmd);
      }
    } else {
      // PvP: identical ordering to the original — decideTick is evaluated
      // before player commands are processed, then both are processed in turn.
      const aiCmds = this.ai.decideTick(tick, this.state);
      const allCmds = [...externalCmds, ...aiCmds];
      for (const cmd of allCmds) {
        this.processCommand(cmd);
      }
    }

    // ── Systems ───────────────────────────────────────────────────────────
    this.resource.tick(this.state);
    this.production.tick(this.state);
    this.trait.tick(this.state);
    this.combat.tick(this.state);
    this.escort.tick(this.state);
    this.hazard.tick(this.state);
    this.movement.tick(this.state);
    this.spell.tick(this.state);

    // Expire BridgeCollapse column blocks.
    for (const [col, expiresAt] of this.state.tempBlockedCols) {
      if (this.state.elapsedTicks >= expiresAt) {
        this.state.tempBlockedCols.delete(col);
      }
    }

    // ── Hand refresh timers ───────────────────────────────────────────────
    this.tickHandRefresh(Side.Bottom, 0);
    this.tickHandRefresh(Side.Top, 1);

    // ── Building survival stats ───────────────────────────────────────────
    this.accumulateBuildingSurvival();

    this.checkWinCondition();

    return this.state.events;
  }

  // ─── Initial state events ─────────────────────────────────────────────────

  /**
   * Draw 6 cards per player with staggered timers, emit card_drawn + resource_changed.
   * Called once before the first tick's logic runs.
   */
  private emitInitialEvents(): void {
    for (const side of [Side.Bottom, Side.Top] as const) {
      const player = this.state.getPlayer(side);
      const owner  = sideToOwner(side);

      let slotIdx = 0;

      // Force-inject level-specific spell cards into the first hand slots.
      if (side === Side.Bottom && this.initialSpellCards.length > 0) {
        for (const card of this.initialSpellCards) {
          if (slotIdx >= HAND_SIZE) break;
          const stagger  = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
          const duration = cardRefreshDuration(stagger);
          player.hand.drawIntoSlot(slotIdx, card, duration);
          this.state.pushEvent({
            type:                'card_drawn',
            owner,
            cardType:            card.cardType,
            handIndex:           slotIdx,
            refreshDurationTicks: duration,
          });
          slotIdx++;
        }
      }

      // Fill remaining slots from the normal draw policy.
      for (let i = slotIdx; i < HAND_SIZE; i++) {
        const stagger  = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
        const duration = cardRefreshDuration(stagger);
        const card     = player.drawPolicy.draw();
        player.hand.drawIntoSlot(i, card, duration);
        this.state.pushEvent({
          type:                'card_drawn',
          owner,
          cardType:            card.cardType,
          handIndex:           i,
          refreshDurationTicks: duration,
        });
      }
      this.state.pushEvent({ type: 'resource_changed', owner, ink: player.ink });
    }

    // Emit spawn events for all escort units placed at level start.
    for (const escort of this.state.escorts) {
      this.state.pushEvent({
        type:    'escort_spawned',
        escortId: escort.id,
        col_fp:   escort.col_fp,
        row_fp:   escort.row_fp,
        hp:       escort.hp,
        maxHp:    escort.maxHp,
      });
    }

    // SLG defense config (U10): emit spawn events for pre-placed garrison units.
    for (const unit of this.garrisonUnits) {
      this.state.pushEvent({
        type:      'unit_spawned',
        unitId:    unit.id,
        owner:     1,
        unitType:  unit.unitType,
        col:       unit.col,
        y_fp:      unit.y_fp,
        radius_fp: unit.radius_fp,
      });
      this.state.pushEvent({
        type:     'unit_move_start',
        unitId:   unit.id,
        from:     { col: unit.col, y_fp: unit.y_fp },
        to:       { col: unit.col, y_fp: toFp(BOTTOM_BUILDING_ROW) },
        speed_fp: unit.speed_fp,
      });
    }

    // SLG siege battle (G3, §16): emit spawn + move events for the attacker's
    // pre-deployed army (owner 0 / Bottom). Mirror of the garrison block — these
    // advance toward the defender base (TOP_BUILDING_ROW) on the first tick.
    for (const unit of this.attackerArmyUnits) {
      this.state.pushEvent({
        type:      'unit_spawned',
        unitId:    unit.id,
        owner:     0,
        unitType:  unit.unitType,
        col:       unit.col,
        y_fp:      unit.y_fp,
        radius_fp: unit.radius_fp,
      });
      this.state.pushEvent({
        type:     'unit_move_start',
        unitId:   unit.id,
        from:     { col: unit.col, y_fp: unit.y_fp },
        to:       { col: unit.col, y_fp: toFp(TOP_BUILDING_ROW) },
        speed_fp: unit.speed_fp,
      });
    }

    // SLG defense config (U10): emit placed events for pre-placed defender buildings.
    for (const building of this.defenderBuildingList) {
      this.state.pushEvent({
        type:         'building_placed',
        buildingId:   building.id,
        owner:        1,
        buildingType: building.buildingType,
        col:          building.col,
        row:          building.row,
      });
    }
  }

  // ─── Hand refresh timer tick ──────────────────────────────────────────────

  private tickHandRefresh(side: Side, owner: OwnerId): void {
    const player  = this.state.getPlayer(side);
    const expired = player.hand.tickTimers();

    for (const slotIndex of expired) {
      this.state.pushEvent({ type: 'card_expired', owner, handIndex: slotIndex });
      this.drawIntoSlot(player, owner, slotIndex, CARD_REFRESH_TICKS);
    }
  }

  // ─── Command processing ───────────────────────────────────────────────────

  private processCommand(cmd: PlayerCommand): void {
    const side   = ownerToSide(cmd.owner);
    const player = this.state.getPlayer(side);

    if (cmd.type === 'upgrade_base') {
      const cost = player.nextUpgradeCost;
      if (player.upgradeBase()) {
        if (cost !== null) this.state.stats[cmd.owner].goldSpent += cost;
        this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, ink: player.ink });
      }
      return;
    }

    if (cmd.type === 'refresh_hand') {
      // Pay 10 ink, then redraw every hand slot with freshly-staggered timers —
      // identical to the initial deal (random start within the 30 s refresh window).
      if (!player.spendInk(HAND_REFRESH_COST)) return;
      this.state.stats[cmd.owner].goldSpent += HAND_REFRESH_COST;
      for (let i = 0; i < HAND_SIZE; i++) {
        const stagger  = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
        const duration = cardRefreshDuration(stagger);
        this.drawIntoSlot(player, cmd.owner, i, duration);
      }
      this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, ink: player.ink });
      return;
    }

    if (cmd.type === 'play_card') {
      const slot = player.hand.slots[cmd.handIndex];
      if (!slot || player.ink < slot.card.cost) return;
      const card = slot.card;

      // ── Unit card ────────────────────────────────────────────────────────
      if (card.cardType === CardType.Unit && card.unitType) {
        const col = cmd.col;
        if (col === undefined || !(ATTACK_LANES as readonly number[]).includes(col)) return;
        // In campaign, restrict placement to the active lanes defined by the level.
        const activeLanes = this.level?.board?.activeLanes;
        if (activeLanes && !activeLanes.includes(col)) return;

        // Placement rule: can't spawn into a lane whose spawn cell is already
        // occupied (its troops are "full"). The human UI enforces this in
        // GameRenderer.commitCardPlay; enforcing it here makes the engine the
        // single authority so the AI (and any net-confirmed command) obeys the
        // same rule — no auto-stacking past a packed lane.
        const spawnRow = side === Side.Bottom ? BOTTOM_SPAWN_ROW : TOP_SPAWN_ROW;
        if (this.state.board.isCellOccupiedByUnit(col, spawnRow)) return;

        const unitType = card.unitType;
        const bp = this.state.unitBlueprints[unitType];
        this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
          for (let i = 0; i < bp.spawnCount; i++) {
            const unit = new Unit(unitType, side, col, spawnRow, bp);
            this.state.board.addUnit(unit);
            this.state.stats[cmd.owner].unitsSent++;
            this.state.pushEvent({
              type:      'unit_spawned',
              unitId:    unit.id,
              owner:     cmd.owner,
              unitType:  unit.unitType,
              col:       unit.col,
              y_fp:      unit.y_fp,
              radius_fp: unit.radius_fp,
            });
            this.state.pushEvent({
              type:     'unit_move_start',
              unitId:   unit.id,
              from:     { col: unit.col, y_fp: unit.y_fp },
              to:       { col: unit.col, y_fp: side === Side.Bottom ? toFp(TOP_BUILDING_ROW) : toFp(BOTTOM_BUILDING_ROW) },
              speed_fp: unit.speed_fp,
            });
          }
        });
        return;
      }

      // ── Building card ─────────────────────────────────────────────────────
      if (card.cardType === CardType.Building && card.buildingType) {
        const col = cmd.col;
        if (col === undefined) return;

        const buildingRow = side === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW;
        if (this.state.board.hasBuildingAt(col, buildingRow)) return;
        if (this.state.board.isNoBuild(col, buildingRow)) return;

        const buildingType = card.buildingType;
        this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
          const building = new Building(buildingType, side, col, buildingRow);
          this.state.board.addBuilding(building);
          this.state.pushEvent({
            type:         'building_placed',
            buildingId:   building.id,
            owner:        cmd.owner,
            buildingType: building.buildingType,
            col:          building.col,
            row:          building.row,
          });
        });
        return;
      }

      // ── Spell card ────────────────────────────────────────────────────────
      if (card.cardType === CardType.Spell && card.spellType) {
        if (card.spellType === SpellType.Haste) {
          this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
            this.spell.castHaste(side, this.state);
          });
          return;
        }

        if (card.spellType === SpellType.Meteor && cmd.col !== undefined && cmd.row !== undefined) {
          const col = cmd.col;
          const row = cmd.row;
          this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
            this.spell.castMeteor(side, col, row, this.state);
          });
          return;
        }

        if (card.spellType === SpellType.Rockslide && cmd.col !== undefined) {
          const col = cmd.col;
          this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
            this.spell.castRockslide(side, col, this.state);
          });
          return;
        }

        if (card.spellType === SpellType.BridgeCollapse && cmd.col !== undefined) {
          const col = cmd.col;
          this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
            this.spell.castBridgeCollapse(side, col, this.state, this.state.elapsedTicks);
          });
          return;
        }
      }
    }
  }

  /**
   * Shared bookkeeping for every successful card play: spend the ink, record
   * gold spent, clear the hand slot, emit `card_played`, run the card-specific
   * `effect`, then draw a replacement and emit `resource_changed`.
   *
   * Event order (spend → card_played → effect events → card_drawn →
   * resource_changed) is identical to the previous inline branches, so the
   * golden-replay determinism contract is preserved.
   */
  private consumeCardSlot(
    player: Player,
    owner: OwnerId,
    handIndex: number,
    card: CardDefinition,
    effect: () => void,
  ): void {
    player.spendInk(card.cost);
    this.state.stats[owner].goldSpent += card.cost;
    player.hand.play(handIndex);
    this.state.pushEvent({ type: 'card_played', owner, handIndex });
    effect();
    this.drawIntoSlot(player, owner, handIndex, CARD_REFRESH_TICKS);
    this.state.pushEvent({ type: 'resource_changed', owner, ink: player.ink });
  }

  // ─── Campaign: scripted enemy spawn ────────────────────────────────────────

  /**
   * Spawn a single enemy (Top side, owner 1) unit on `col`, bypassing the
   * hand/ink economy. Emits the same unit_spawned / unit_move_start events as
   * a card play, so the render layer needs no campaign-specific handling.
   */
  private spawnEnemyUnit(unitType: UnitType, col: number, isBoss?: boolean, crossWaypoints?: { atRow: number; toCol: number }[]): void {
    const side: Side = Side.Top;
    const owner: OwnerId = 1;
    const laneLen  = this.level?.board?.laneLength;
    const lane = laneLen?.[String(col)];
    const spawnRow = lane !== undefined ? BOARD_ROWS - lane : TOP_SPAWN_ROW;
    const unit = new Unit(unitType, side, col, spawnRow, this.enemyWaveBlueprints[unitType]);
    if (isBoss) {
      unit.isBoss = true;
      this.state.bossUnitIds.add(unit.id);
    }
    if (crossWaypoints && crossWaypoints.length > 0) {
      unit.pendingWaypoints = crossWaypoints.slice();
    }
    this.state.board.addUnit(unit);
    this.state.stats[owner].unitsSent++;
    this.state.pushEvent({
      type:      'unit_spawned',
      unitId:    unit.id,
      owner,
      unitType:  unit.unitType,
      col:       unit.col,
      y_fp:      unit.y_fp,
      radius_fp: unit.radius_fp,
    });
    this.state.pushEvent({
      type:     'unit_move_start',
      unitId:   unit.id,
      from:     { col: unit.col, y_fp: unit.y_fp },
      to:       { col: unit.col, y_fp: toFp(BOTTOM_BUILDING_ROW) },
      speed_fp: unit.speed_fp,
    });
  }

  /** Whether any living Top-side (enemy) unit is still on the board. */
  private hasLivingEnemyUnits(): boolean {
    for (const unit of this.state.board.units.values()) {
      if (unit.side === Side.Top && !unit.isDead) return true;
    }
    return false;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Draw one card into a hand slot and emit card_drawn. */
  private drawIntoSlot(player: Player, owner: OwnerId, slotIndex: number, duration: number): void {
    const card = player.drawPolicy.draw();
    player.hand.drawIntoSlot(slotIndex, card, duration);
    this.state.pushEvent({
      type:                'card_drawn',
      owner,
      cardType:            card.cardType,
      handIndex:           slotIndex,
      refreshDurationTicks: duration,
    });
  }

  private accumulateBuildingSurvival(): void {
    for (const building of this.state.board.buildings.values()) {
      if (!building.isDead) {
        const owner = this.state.ownerOf(building.side);
        this.state.stats[owner].buildingSurvivalTicks++;
      }
    }
  }

  private checkWinCondition(): void {
    if (this.state.phase === GamePhase.GameOver) return;

    if (this.state.bottomPlayer.isDead) {
      this.state.phase  = GamePhase.GameOver;
      this.state.winner = Side.Top;
      this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
      this.state.pushEvent({ type: 'game_over', winner: 1 });
      return;
    }

    // ── Campaign / siege objectives ──────────────────────────────────────────
    if (this.waveDirector) {
      const objective = this.level!.objective;

      // `escort` impossible-to-complete loss: not enough living escorts remain.
      if (objective.kind === 'escort') {
        const total   = this.state.escorts.length;
        const arrived = this.state.escorts.filter(e => e.status === 'arrived').length;
        const dead    = this.state.escorts.filter(e => e.status === 'dead').length;
        const needed  = objective.required === 'all' ? total
                      : objective.required === 'any' ? 1
                      : objective.required as number;
        if (arrived >= needed) {
          this.state.phase  = GamePhase.GameOver;
          this.state.winner = Side.Bottom;
          this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
          this.state.pushEvent({ type: 'game_over', winner: 0 });
          return;
        }
        if (total - dead < needed - arrived) {
          this.state.phase  = GamePhase.GameOver;
          this.state.winner = Side.Top;
          this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
          this.state.pushEvent({ type: 'game_over', winner: 1 });
          return;
        }
      }

      // `leak_limit`: lose if too many enemies have reached the player's base.
      if (objective.kind === 'leak_limit' && this.state.enemyLeaks > objective.maxLeaks) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Top;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
        this.state.pushEvent({ type: 'game_over', winner: 1 });
        return;
      }

      // Wiping the enemy base always wins (siege: attacker captures the tile).
      if (this.state.topPlayer.isDead) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Bottom;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
        this.state.pushEvent({ type: 'game_over', winner: 0 });
        return;
      }

      // SLG siege battle (G3, §16.1): hard time limit. Reaching battleTimeoutTicks
      // with both bases still standing → the defender (Top / owner 1) wins —
      // "timeout / mutual destruction → attacker loses (defense-favored)". Both base-down cases are handled
      // above, so on arrival here both bases are alive by construction.
      if (this.level!.battleTimeoutTicks !== undefined &&
          this.state.elapsedTicks >= this.level!.battleTimeoutTicks) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Top;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
        this.state.pushEvent({ type: 'game_over', winner: 1 });
        return;
      }

      // Evaluate the win condition.
      let survived = false;
      if (objective.kind === 'timed_defense') {
        survived = this.state.elapsedTicks >= objective.durationTicks;
      } else if (objective.kind === 'survive') {
        survived = this.waveDirector.exhausted && !this.hasLivingEnemyUnits();
      } else if (objective.kind === 'boss') {
        // Win when all spawned boss units are dead (at least one must exist).
        if (this.state.bossUnitIds.size > 0) {
          const anyAlive = Array.from(this.state.bossUnitIds).some((id) => {
            const u = this.state.board.units.get(id);
            return u !== undefined && !u.isDead;
          });
          survived = !anyAlive;
        }
      }
      // `destroy_base` with durationTicks: lose if time expired before base is destroyed.
      if (objective.kind === 'destroy_base' && objective.durationTicks !== undefined &&
          this.state.elapsedTicks >= objective.durationTicks) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Top;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
        this.state.pushEvent({ type: 'game_over', winner: 1 });
        return;
      }

      // `leak_limit`: only the leak check above triggers a loss.

      if (survived) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Bottom;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
        this.state.pushEvent({ type: 'game_over', winner: 0 });
      }
      // Campaign skips the PvP countdown / force-draw timers.
      return;
    }

    if (this.state.topPlayer.isDead) {
      this.state.phase  = GamePhase.GameOver;
      this.state.winner = Side.Bottom;
      this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
      this.state.pushEvent({ type: 'game_over', winner: 0 });
      return;
    }

    if (this.state.elapsedTicks >= FORCE_DRAW_THRESHOLD_TICKS) {
      this.state.phase = GamePhase.GameOver;
      this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
      this.state.pushEvent({ type: 'game_draw' });
      return;
    }

    if (
      !this.state.countdownStarted &&
      this.state.elapsedTicks >= COUNTDOWN_THRESHOLD_TICKS
    ) {
      this.state.countdownStarted = true;
      this.state.pushEvent({ type: 'game_countdown_start' });
    }
  }
}

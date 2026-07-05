// Command-processing domain: the render-facing input API (playCard/upgradeBase/refreshHand,
// part of IGameEngine) plus their tick-time handling (processCommand/consumeCardSlot). Applied
// after CampaignMixin (see ../GameEngine.ts); consumeCardSlot calls HelpersMixin's drawIntoSlot.
import type { Constructor, GameEngineBaseCtor } from './base';
import type { HelpersHandlers } from './helpers';
import {
  ATTACK_LANES,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  CARD_REFRESH_INITIAL_OFFSET_MAX,
  CARD_REFRESH_TICKS,
  HAND_REFRESH_COST,
  HAND_SIZE,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
} from '../config';
import { toFp } from '../math/fixed';
import { cardRefreshDuration } from '../Card';
import { Building } from '../Building';
import type { Player } from '../Player';
import { Unit } from '../Unit';
import {
  CardDefinition,
  CardType,
  OwnerId,
  ownerToSide,
  PlayerCommand,
  Side,
  SpellType,
} from '../types';

/** See helpers.ts HelpersHandlers doc comment for why this is exported. */
export interface CommandsHandlers {
  playCard(handIndex: number, col: number, row?: number): void;
  upgradeBase(): void;
  refreshHand(): void;
  processCommand(cmd: PlayerCommand): void;
  consumeCardSlot(player: Player, owner: OwnerId, handIndex: number, card: CardDefinition, effect: () => void): void;
}

export function CommandsMixin<TBase extends GameEngineBaseCtor & Constructor<HelpersHandlers>>(
  Base: TBase,
): TBase & Constructor<CommandsHandlers> {
  return class extends Base {
    // ─── Render-facing API ───────────────────────────────────────────────────

    playCard(handIndex: number, col: number, row?: number): void {
      this.input.submit({ type: 'play_card', owner: 0, tick: this.currentTick, handIndex, col, row });
    }

    upgradeBase(): void {
      this.input.submit({ type: 'upgrade_base', owner: 0, tick: this.currentTick });
    }

    refreshHand(): void {
      this.input.submit({ type: 'refresh_hand', owner: 0, tick: this.currentTick });
    }

    // ─── Command processing ───────────────────────────────────────────────────

    processCommand(cmd: PlayerCommand): void {
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
    consumeCardSlot(
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
  };
}

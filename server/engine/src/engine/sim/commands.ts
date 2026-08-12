// Command-processing domain: tick-time command handling (processCommand/consumeCardSlot)
// — free-function form of the old CommandsMixin (see claudedocs/server.md
// "engine/GameEngine"). The render-facing playCard/upgradeBase/refreshHand API that used
// to live alongside these moved to the facade (GameEngine.ts) — they only submit into
// the InputSource, which sim/** must never see.
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
} from '../../config';
import { toFp } from '../../math/fixed';
import { cardRefreshDuration } from '../../Card';
import { Building } from '../../Building';
import type { Player } from '../../Player';
import { Unit } from '../../Unit';
import {
  CardDefinition,
  CardType,
  OwnerId,
  ownerToSide,
  PlayerCommand,
  Side,
  SpellType,
} from '../../types';
import type { EngineCtx } from '../ctx';
import { drawIntoSlot } from './hand';

export function processCommand(ctx: EngineCtx, cmd: PlayerCommand): void {
  const { state, level, systems } = ctx;
  const side   = ownerToSide(cmd.owner);
  const player = state.getPlayer(side);

  if (cmd.type === 'upgrade_base') {
    const cost = player.nextUpgradeCost;
    if (player.upgradeBase()) {
      if (cost !== null) state.stats[cmd.owner].goldSpent += cost;
      state.pushEvent({ type: 'base_upgraded', owner: cmd.owner, level: player.upgradeLevel });
      state.pushEvent({ type: 'resource_changed', owner: cmd.owner, ink: player.ink });
    }
    return;
  }

  if (cmd.type === 'refresh_hand') {
    // Pay 10 ink, then redraw every hand slot with freshly-staggered timers — identical
    // to the initial deal (random start within the 30 s refresh window).
    if (!player.spendInk(HAND_REFRESH_COST)) return;
    state.stats[cmd.owner].goldSpent += HAND_REFRESH_COST;
    for (let i = 0; i < HAND_SIZE; i++) {
      const stagger  = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
      const duration = cardRefreshDuration(stagger);
      drawIntoSlot(state, player, cmd.owner, i, duration);
    }
    state.pushEvent({ type: 'resource_changed', owner: cmd.owner, ink: player.ink });
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
      const activeLanes = level?.board?.activeLanes;
      if (activeLanes && !activeLanes.includes(col)) return;

      // Placement rule: can't spawn into a lane whose spawn cell is already occupied
      // (its troops are "full"). The human UI enforces this in GameRenderer.commitCardPlay;
      // enforcing it here makes the engine the single authority so the AI (and any
      // net-confirmed command) obeys the same rule — no auto-stacking past a packed lane.
      const spawnRow = side === Side.Bottom ? BOTTOM_SPAWN_ROW : TOP_SPAWN_ROW;
      if (state.board.isCellOccupiedByUnit(col, spawnRow)) return;

      const unitType = card.unitType;
      const bp = state.unitBlueprints[unitType];
      consumeCardSlot(ctx, player, cmd.owner, cmd.handIndex, card, () => {
        for (let i = 0; i < bp.spawnCount; i++) {
          const unit = new Unit(unitType, side, col, spawnRow, bp, undefined, state.allocUnitId());
          state.board.addUnit(unit);
          state.stats[cmd.owner].unitsSent++;
          state.pushEvent({
            type:      'unit_spawned',
            unitId:    unit.id,
            owner:     cmd.owner,
            unitType:  unit.unitType,
            col:       unit.col,
            y_fp:      unit.y_fp,
            radius_fp: unit.radius_fp,
          });
          state.pushEvent({
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
      if (col === undefined || !(ATTACK_LANES as readonly number[]).includes(col)) return;

      const buildingRow = side === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW;
      if (state.board.hasBuildingAt(col, buildingRow)) return;
      if (state.board.isNoBuild(col, buildingRow)) return;

      const buildingType = card.buildingType;
      consumeCardSlot(ctx, player, cmd.owner, cmd.handIndex, card, () => {
        const building = new Building(buildingType, side, col, buildingRow, undefined, state.allocBuildingId());
        state.board.addBuilding(building);
        state.pushEvent({
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
        consumeCardSlot(ctx, player, cmd.owner, cmd.handIndex, card, () => {
          systems.spell.castHaste(side, state);
        });
        return;
      }

      if (card.spellType === SpellType.Meteor && cmd.col !== undefined && cmd.row !== undefined) {
        const col = cmd.col;
        const row = cmd.row;
        consumeCardSlot(ctx, player, cmd.owner, cmd.handIndex, card, () => {
          systems.spell.castMeteor(side, col, row, state);
        });
        return;
      }

      if (card.spellType === SpellType.Rockslide && cmd.col !== undefined) {
        const col = cmd.col;
        consumeCardSlot(ctx, player, cmd.owner, cmd.handIndex, card, () => {
          systems.spell.castRockslide(side, col, state);
        });
        return;
      }

      if (card.spellType === SpellType.BridgeCollapse && cmd.col !== undefined) {
        const col = cmd.col;
        consumeCardSlot(ctx, player, cmd.owner, cmd.handIndex, card, () => {
          systems.spell.castBridgeCollapse(side, col, state, state.elapsedTicks);
        });
        return;
      }
    }
  }
}

/**
 * Shared bookkeeping for every successful card play: spend the ink, record gold spent,
 * clear the hand slot, emit `card_played`, run the card-specific `effect`, then draw a
 * replacement and emit `resource_changed`.
 *
 * Event order (spend → card_played → effect events → card_drawn → resource_changed) is
 * identical to the previous mixin-chain implementation, so the golden-replay determinism
 * contract is preserved.
 */
export function consumeCardSlot(
  ctx: EngineCtx,
  player: Player,
  owner: OwnerId,
  handIndex: number,
  card: CardDefinition,
  effect: () => void,
): void {
  const { state } = ctx;
  player.spendInk(card.cost);
  state.stats[owner].goldSpent += card.cost;
  player.hand.play(handIndex);
  state.pushEvent({ type: 'card_played', owner, handIndex });
  effect();
  drawIntoSlot(state, player, owner, handIndex, CARD_REFRESH_TICKS);
  state.pushEvent({ type: 'resource_changed', owner, ink: player.ink });
}

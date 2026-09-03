// engineDriver.ts against a STUB @nw/engine. The sibling engineDriver.test.ts drives the real
// engine through whole matches and is the authority on the netplay contract; what it cannot do is
// put the engine into a specific state on demand. Several of BattleEngine's branches only exist for
// states a real 6-card test match never reaches:
//
//   • buildings on the board while the bot is Bottom (the mirrored view has to flip their side too);
//   • AISystem deciding upgrade_base / refresh_hand while the bot is Bottom (nothing to row-flip);
//   • GamePhase.GameOver arriving WITHOUT a game_over event (game_draw and any other terminal path);
//   • a second terminal signal in the same tick (game_over event + GameOver phase);
//   • getResult() / didIWin() before and after the match settles.
//
// So this file replaces only `createGameEngine` and `AISystem` and keeps everything else real —
// BOARD_ROWS, Side and GamePhase in particular, because flipRow/flipSide are the logic under test
// and stubbing their inputs would be testing this file's own arithmetic.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  BOARD_ROWS,
  GamePhase,
  Side,
  createGameEngine,
  type GameEvent,
  type GameState,
  type PlayerCommand,
  type PlayerStats,
} from '@nw/engine';
import { AISystem } from '@nw/engine';
import { BattleEngine } from '../src/engineDriver';
import { decodeSideCommands } from '../src/protoCodec';
import type { MatchStart } from '../src/generated/transport';

vi.mock('@nw/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nw/engine')>();
  return { ...actual, createGameEngine: vi.fn(), AISystem: vi.fn() };
});

const MockCreateGameEngine = createGameEngine as unknown as Mock;
const MockAISystem = AISystem as unknown as Mock;

function matchStart(localSide: 0 | 1): MatchStart {
  return {
    roomId: 'stub-room',
    mode: 1,
    seed: 7,
    startFrame: 0,
    localSide,
    opponentName: 'opp',
    opponentPublicId: '000000001',
    opponentTitle: '',
    opponentAvatarId: '',
    opponentSkins: [],
    topDeck: ['card_top'],
    bottomDeck: ['card_bottom'],
  };
}

const stats = (owner: 0 | 1): PlayerStats => ({
  owner,
  damageDealtToBase: owner,
  damageTakenByBase: 0,
  unitsSent: 0,
  unitsKilled: 0,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 0,
});

interface StubEngine {
  step: Mock;
  state: {
    phase: GamePhase;
    topPlayer: unknown;
    bottomPlayer: unknown;
    unitBlueprints: unknown;
    board: { units: Map<number, unknown>; buildings: Map<number, unknown>; hasBuildingAt: Mock };
    snapshotStats: Mock;
  };
}

function stubEngine(): StubEngine {
  return {
    step: vi.fn<(tick: number, cmds: PlayerCommand[]) => GameEvent[]>(() => []),
    state: {
      phase: GamePhase.Playing,
      topPlayer: { tag: 'real-top' },
      bottomPlayer: { tag: 'real-bottom' },
      unitBlueprints: { tag: 'blueprints' },
      board: { units: new Map(), buildings: new Map(), hasBuildingAt: vi.fn(() => false) },
      snapshotStats: vi.fn(() => [stats(0), stats(1)] as [PlayerStats, PlayerStats]),
    },
  };
}

let engine: StubEngine;
let decideTick: Mock;

beforeEach(() => {
  vi.clearAllMocks();
  engine = stubEngine();
  decideTick = vi.fn<(tick: number, state: GameState) => PlayerCommand[]>(() => []);
  MockCreateGameEngine.mockImplementation(() => engine);
  MockAISystem.mockImplementation(() => ({ decideTick }));
});

/** Confirms enough frames for `advance()` to step exactly tick 0 (playTo = confirmedTo - BUFFER_FRAMES). */
function stepOneTick(driver: BattleEngine): ReturnType<BattleEngine['advance']> {
  driver.ingestFrameBatch({ toFrame: 3, frames: [] });
  return driver.advance();
}

describe('BattleEngine mirrored view (bot is wire side 0 / Bottom)', () => {
  it('hands AISystem the REAL bottom player as its "top", with units, buildings and rows flipped', () => {
    // AISystem only ever decides for the engine's Top side, so a Bottom bot has to be shown a
    // vertically mirrored board. Buildings matter as much as units here: AISystem places units
    // relative to enemy structures, and a building left tagged with its real side turns "attack the
    // enemy tower" into "pile onto my own".
    engine.state.board.units.set(1, { side: Side.Top, isDead: false, col: 2, row: 3, unitType: 'archer' });
    engine.state.board.buildings.set(9, { side: Side.Bottom, isDead: false, buildingType: 'tower' });

    const driver = new BattleEngine(matchStart(0), 5);
    stepOneTick(driver);

    const view = decideTick.mock.calls[0]![1] as unknown as {
      topPlayer: { tag: string };
      unitBlueprints: { tag: string };
      board: {
        units: Map<number, { side: Side; col: number; row: number; unitType: string }>;
        buildings: Map<number, { side: Side; isDead: boolean; buildingType: string }>;
        hasBuildingAt: (col: number, row: number) => boolean;
      };
    };

    expect(view.topPlayer.tag).toBe('real-bottom'); // the bot's own hand, not the opponent's
    expect(view.unitBlueprints.tag).toBe('blueprints'); // passed through, not mirrored
    expect(view.board.units.get(1)).toEqual({
      side: Side.Bottom,
      isDead: false,
      col: 2, // columns are shared and never flip
      row: BOARD_ROWS - 1 - 3,
      unitType: 'archer',
    });
    expect(view.board.buildings.get(9)).toEqual({ side: Side.Top, isDead: false, buildingType: 'tower' });

    view.board.hasBuildingAt(4, 5);
    expect(engine.state.board.hasBuildingAt).toHaveBeenCalledWith(4, BOARD_ROWS - 1 - 5);

    // The real state is untouched — the mirror is a transient read-only view, not a rewrite.
    expect((engine.state.board.units.get(1) as { side: Side; row: number }).side).toBe(Side.Top);
    expect((engine.state.board.units.get(1) as { side: Side; row: number }).row).toBe(3);
    expect((engine.state.board.buildings.get(9) as { side: Side }).side).toBe(Side.Bottom);
  });

  it('flips a decided play_card row back and stamps the bot\'s real owner', () => {
    decideTick.mockReturnValue([{ type: 'play_card', owner: 1, tick: 0, handIndex: 2, col: 4, row: 5 }]);

    const driver = new BattleEngine(matchStart(0), 5);
    const { toSubmit } = stepOneTick(driver);

    expect(toSubmit).toHaveLength(1);
    expect(decodeSideCommands(toSubmit[0]!, 0, 0)).toEqual([
      { type: 'play_card', owner: 0, tick: 0, handIndex: 2, col: 4, row: BOARD_ROWS - 1 - 5 },
    ]);
  });

  it('leaves upgrade_base and refresh_hand alone except for the owner (nothing to un-mirror)', () => {
    // These carry no row, so the flip must be skipped rather than applied to `undefined`.
    decideTick.mockReturnValue([
      { type: 'upgrade_base', owner: 1, tick: 0 },
      { type: 'refresh_hand', owner: 1, tick: 0 },
    ]);

    const driver = new BattleEngine(matchStart(0), 5);
    const { toSubmit } = stepOneTick(driver);

    expect(toSubmit).toHaveLength(2);
    expect(decodeSideCommands(toSubmit[0]!, 0, 0)).toEqual([{ type: 'upgrade_base', owner: 0, tick: 0 }]);
    expect(decodeSideCommands(toSubmit[1]!, 0, 0)).toEqual([{ type: 'refresh_hand', owner: 0, tick: 0 }]);
  });

  it('a play_card with no row is passed through without inventing one', () => {
    decideTick.mockReturnValue([{ type: 'play_card', owner: 1, tick: 0, handIndex: 1, col: 3 }]);

    const driver = new BattleEngine(matchStart(0), 5);
    const { toSubmit } = stepOneTick(driver);

    // protoCodec's `?? 0` fills the wire field; what matters is that flipRow did NOT run on undefined
    // (which would have produced row 17 — a legal-looking coordinate at the far end of the board).
    expect(decodeSideCommands(toSubmit[0]!, 0, 0)).toEqual([
      { type: 'play_card', owner: 0, tick: 0, handIndex: 1, col: 3, row: 0 },
    ]);
  });
});

describe('BattleEngine (bot is wire side 1 / Top) skips mirroring entirely', () => {
  it('passes the real state to AISystem and submits the decided command unchanged', () => {
    engine.state.board.buildings.set(9, { side: Side.Bottom, isDead: false, buildingType: 'tower' });
    decideTick.mockReturnValue([{ type: 'play_card', owner: 1, tick: 0, handIndex: 0, col: 1, row: 2 }]);

    const driver = new BattleEngine(matchStart(1), 5);
    const { toSubmit } = stepOneTick(driver);

    expect(decideTick.mock.calls[0]![1]).toBe(engine.state); // the real state object, not a view
    expect(decodeSideCommands(toSubmit[0]!, 1, 0)).toEqual([
      { type: 'play_card', owner: 1, tick: 0, handIndex: 0, col: 1, row: 2 },
    ]);
  });
});

describe('BattleEngine terminal states', () => {
  it('finalizes with no winner when the phase reaches GameOver without a game_over event', () => {
    // game_draw (and any other terminal path that does not emit game_over) lands here. Without this
    // the bot would keep stepping a finished engine forever and only stop at the 20-minute guard,
    // never reporting a result — the opponent's client, which DID see the draw, reports one, and the
    // missing counterpart reads as a hash mismatch on their ranked match.
    engine.step.mockImplementation(() => {
      engine.state.phase = GamePhase.GameOver;
      return [];
    });

    const driver = new BattleEngine(matchStart(1), 5);
    stepOneTick(driver);

    expect(driver.isGameOver()).toBe(true);
    expect(driver.getResult().winnerSide).toBeNull();
    expect(driver.didIWin()).toBeNull();
    expect(decideTick).not.toHaveBeenCalled(); // no command decided on the tick that ended the match
  });

  it('keeps the first terminal signal when a game_over event and the GameOver phase land on the same tick', () => {
    // Both checks fire in one iteration of the step loop. The event carries the winner; the phase
    // check carries `null`. Second-writer-wins would turn a decided match into a draw.
    engine.step.mockImplementation(() => {
      engine.state.phase = GamePhase.GameOver;
      return [{ type: 'game_over', winner: 1 } as unknown as GameEvent];
    });

    const driver = new BattleEngine(matchStart(1), 5);
    stepOneTick(driver);

    expect(driver.getResult().winnerSide).toBe(1);
    expect(driver.didIWin()).toBe(true);
    expect(engine.state.snapshotStats).toHaveBeenCalledTimes(1); // hashed once, not twice
  });

  it('ignores a duplicate game_over in the same tick rather than re-hashing the result', () => {
    // captureResult is called once per game_over event in the tick, and the engine emits the event
    // list as a batch. Re-entering would re-read snapshotStats() and overwrite the hash the bot is
    // about to report — with the same numbers today, but the guard is what makes that a fact rather
    // than a coincidence of the current event ordering.
    engine.step.mockReturnValue([
      { type: 'game_over', winner: 1 } as unknown as GameEvent,
      { type: 'game_over', winner: 0 } as unknown as GameEvent,
    ]);

    const driver = new BattleEngine(matchStart(1), 5);
    stepOneTick(driver);

    expect(driver.getResult().winnerSide).toBe(1); // the first one wins, not the last
    expect(engine.state.snapshotStats).toHaveBeenCalledTimes(1);
  });

  it('reports a loss when the other wire side won', () => {
    engine.step.mockReturnValue([{ type: 'game_over', winner: 1 } as unknown as GameEvent]);

    const driver = new BattleEngine(matchStart(0), 5);
    stepOneTick(driver);

    expect(driver.getResult().winnerSide).toBe(1);
    expect(driver.didIWin()).toBe(false);
  });

  it('stops stepping once the match is over, even with frames still confirmed ahead', () => {
    engine.step.mockReturnValue([{ type: 'game_over', winner: 1 } as unknown as GameEvent]);

    const driver = new BattleEngine(matchStart(1), 5);
    driver.ingestFrameBatch({ toFrame: 100, frames: [] });
    const first = driver.advance();

    expect(engine.step).toHaveBeenCalledTimes(1);
    expect(first.hasMore).toBe(false); // not "97 frames left" — the match is done
    expect(driver.advance().toSubmit).toEqual([]);
    expect(engine.step).toHaveBeenCalledTimes(1);
  });

  it('throws if the result is read before the match is over', () => {
    // A hard throw rather than a placeholder result: playRankedMatch catches it and fails this one
    // match, whereas a fabricated hash would be reported to meta as this bot's real answer and score
    // a mismatch against a real opponent's honest one.
    const driver = new BattleEngine(matchStart(1), 5);
    expect(() => driver.getResult()).toThrow('getResult() called before game over');
    expect(() => driver.didIWin()).toThrow('getResult() called before game over');
    expect(driver.isGameOver()).toBe(false);
  });
});

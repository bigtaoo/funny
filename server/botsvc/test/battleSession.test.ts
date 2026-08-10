// Orchestration/error-path coverage for playRankedMatch's state machine (battleSession.ts). Unlike
// bot.test.ts (which mocks the WHOLE battleSession module to test BotSession's state transitions one
// layer up), this file mocks ONLY the two real network clients (GatewayClient/GameServerClient) and
// the engine wrapper (BattleEngine) — playRankedMatch's own pump/abort/timeout/onMatchOver/exception
// logic runs for real and is driven end-to-end from fake server pushes.
//
// BattleEngine is a controllable fake here (not the real @nw/engine), not because driving the real
// engine is too costly — engineDriver.test.ts already does that cheaply — but because these tests are
// specifically about battleSession.ts's OWN orchestration timing: forcing an exception out of
// driver.advance() at an exact pump tick, or having onMatchOver race ahead of the local engine's own
// game_over, needs precise per-call control a real engine can't be steered into on demand. The real
// engine IS exercised end-to-end in battleSession.realEngine.test.ts instead.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../src/gatewayClient', () => ({ GatewayClient: vi.fn() }));
vi.mock('../src/gameServerClient', () => ({ GameServerClient: vi.fn() }));
vi.mock('../src/engineDriver', () => ({ BattleEngine: vi.fn() }));

import { GatewayClient } from '../src/gatewayClient';
import { GameServerClient, type GameServerClientHandlers } from '../src/gameServerClient';
import { BattleEngine } from '../src/engineDriver';
import { playRankedMatch } from '../src/battleSession';
import type { FrameBatch, MatchOver, MatchStart } from '../src/generated/transport';

const MockGatewayClient = GatewayClient as unknown as Mock;
const MockGameServerClient = GameServerClient as unknown as Mock;
const MockBattleEngine = BattleEngine as unknown as Mock;

const baseMatchStart: MatchStart = {
  roomId: 'room-1',
  mode: 1,
  seed: 42,
  startFrame: 0,
  localSide: 1,
  opponentName: 'opp',
  opponentPublicId: '000000001',
  opponentTitle: '',
  opponentAvatarId: '',
  opponentSkins: [],
  topDeck: ['card_a'],
  bottomDeck: ['card_b'],
};

function makeGateway() {
  return { enqueueRanked: vi.fn(), close: vi.fn() };
}

function makeGameServer() {
  let handlers: GameServerClientHandlers | undefined;
  const connect = vi.fn((_url: string, _ticket: string, h: GameServerClientHandlers) => {
    handlers = h;
    return new Promise<void>(() => {
      /* real code never awaits the resolved value on the happy path — only .catch() is chained */
    });
  });
  return {
    instance: { connect, submitCmd: vi.fn(), reportResult: vi.fn(), close: vi.fn() },
    getHandlers: (): GameServerClientHandlers => {
      if (!handlers) throw new Error('connect() was never called');
      return handlers;
    },
  };
}

function makeEngine() {
  return {
    ingestFrameBatch: vi.fn(),
    advance: vi.fn().mockReturnValue({ toSubmit: [], hasMore: false }),
    isGameOver: vi.fn().mockReturnValue(false),
    getResult: vi.fn(),
    didIWin: vi.fn(),
  };
}

/** Flushes any pending setImmediate hop (battleSession's pump reschedules via setImmediate while hasMore). */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

let gateway: ReturnType<typeof makeGateway>;
let gameServer: ReturnType<typeof makeGameServer>;
let engine: ReturnType<typeof makeEngine>;

beforeEach(() => {
  vi.clearAllMocks(); // MockGatewayClient/MockGameServerClient/MockBattleEngine are module-level — clear call history between tests.

  gateway = makeGateway();
  gateway.enqueueRanked.mockResolvedValue({ gameUrl: 'ws://game/1', ticket: 'tkt-1' });
  MockGatewayClient.mockImplementation(() => gateway);

  gameServer = makeGameServer();
  MockGameServerClient.mockImplementation(() => gameServer.instance);

  engine = makeEngine();
  MockBattleEngine.mockImplementation(() => engine);
});

function opts(overrides: Partial<Parameters<typeof playRankedMatch>[0]> = {}) {
  return {
    gatewayWsUrl: 'ws://gw',
    jwt: 'jwt-1',
    deck: ['card_a'],
    difficulty: 7 as const,
    ...overrides,
  };
}

describe('playRankedMatch — normal flow', () => {
  it('enqueues, connects, builds the engine on match_start, pumps frame batches, and resolves a win', async () => {
    const onMatched = vi.fn();
    const promise = playRankedMatch(opts({ onMatched }));
    await flush();

    expect(gateway.enqueueRanked).toHaveBeenCalledWith('ws://gw', 'jwt-1', ['card_a']);
    expect(onMatched).toHaveBeenCalledTimes(1);
    expect(gameServer.instance.connect).toHaveBeenCalledWith('ws://game/1', 'tkt-1', expect.any(Object));

    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);
    expect(MockBattleEngine).toHaveBeenCalledWith(baseMatchStart, 7);

    const cmdBytes = new Uint8Array([9, 9]);
    engine.advance.mockReturnValue({ toSubmit: [cmdBytes], hasMore: false });
    engine.isGameOver.mockReturnValue(true);
    engine.getResult.mockReturnValue({ stateHash: 'hash-1', winnerSide: 1 });
    engine.didIWin.mockReturnValue(true);

    const fb: FrameBatch = { toFrame: 3, frames: [] };
    handlers.onFrameBatch(fb);

    await expect(promise).resolves.toEqual({ won: true, stateHash: 'hash-1' });
    expect(engine.ingestFrameBatch).toHaveBeenCalledWith(fb);
    expect(gameServer.instance.submitCmd).toHaveBeenCalledWith(cmdBytes);
    expect(gameServer.instance.reportResult).toHaveBeenCalledWith('hash-1', 1, '');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });

  it('resolves a draw with won: null and reports winnerSide 0 (the wire draw sentinel)', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);

    engine.isGameOver.mockReturnValue(true);
    engine.getResult.mockReturnValue({ stateHash: 'hash-draw', winnerSide: null });
    engine.didIWin.mockReturnValue(null);

    handlers.onFrameBatch({ toFrame: 3, frames: [] });

    await expect(promise).resolves.toEqual({ won: null, stateHash: 'hash-draw' });
    expect(gameServer.instance.reportResult).toHaveBeenCalledWith('hash-draw', 0, '');
  });

  it('resolves a loss with won: false', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);

    engine.isGameOver.mockReturnValue(true);
    engine.getResult.mockReturnValue({ stateHash: 'hash-loss', winnerSide: 0 });
    engine.didIWin.mockReturnValue(false);

    handlers.onFrameBatch({ toFrame: 3, frames: [] });

    await expect(promise).resolves.toEqual({ won: false, stateHash: 'hash-loss' });
  });

  it('drains a multi-chunk backlog across setImmediate hops (hasMore) before resolving', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);

    engine.advance
      .mockReturnValueOnce({ toSubmit: [], hasMore: true })
      .mockReturnValueOnce({ toSubmit: [], hasMore: true })
      .mockReturnValueOnce({ toSubmit: [], hasMore: false });
    engine.isGameOver.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    engine.getResult.mockReturnValue({ stateHash: 'hash-chunked', winnerSide: 1 });
    engine.didIWin.mockReturnValue(true);

    handlers.onFrameBatch({ toFrame: 100, frames: [] });

    await expect(promise).resolves.toEqual({ won: true, stateHash: 'hash-chunked' });
    expect(engine.advance).toHaveBeenCalledTimes(3);
    // ingestFrameBatch is only called once (per onFrameBatch invocation) — the two extra advance()
    // calls came from pump's own setImmediate reschedule loop, not from re-ingesting anything.
    expect(engine.ingestFrameBatch).toHaveBeenCalledTimes(1);
  });
});

describe('playRankedMatch — abort handling', () => {
  it('rejects before ever touching the gameserver when abortSignal is already aborted once matchmaking resolves', async () => {
    const controller = new AbortController();
    controller.abort();
    const onMatched = vi.fn();

    await expect(playRankedMatch(opts({ abortSignal: controller.signal, onMatched }))).rejects.toThrow(
      'match aborted: bot logged out',
    );

    expect(onMatched).not.toHaveBeenCalled();
    expect(MockGameServerClient).not.toHaveBeenCalled();
  });

  it('rejects and closes the gameserver connection when abortSignal fires mid-match', async () => {
    const controller = new AbortController();
    const promise = playRankedMatch(opts({ abortSignal: controller.signal }));
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);

    controller.abort();

    await expect(promise).rejects.toThrow('match aborted: bot logged out');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });

  it('rejects mid-queue abort even before connect() is ever reached (queue-race window)', async () => {
    // enqueueRanked resolves, but the signal was aborted while the queue promise was pending.
    const controller = new AbortController();
    gateway.enqueueRanked.mockImplementation(async () => {
      controller.abort();
      return { gameUrl: 'ws://game/1', ticket: 'tkt-1' };
    });

    await expect(playRankedMatch(opts({ abortSignal: controller.signal }))).rejects.toThrow(
      'match aborted: bot logged out',
    );
    expect(MockGameServerClient).not.toHaveBeenCalled();
  });
});

describe('playRankedMatch — timeout', () => {
  it('rejects once maxMatchMs elapses, and closes the connection', async () => {
    const promise = playRankedMatch(opts({ maxMatchMs: 5 }));
    await expect(promise).rejects.toThrow('match exceeded max wall-clock duration');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });
});

describe('playRankedMatch — server-side onMatchOver (opponent disconnect-forfeit / hash mismatch)', () => {
  it('resolves early without ever pumping the local engine', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart({ ...baseMatchStart, localSide: 1 });

    const matchOver: MatchOver = { winnerSide: 1, reason: 'disconnect', mismatch: false };
    handlers.onMatchOver(matchOver);

    await expect(promise).resolves.toEqual({ won: true, stateHash: '' });
    expect(engine.advance).not.toHaveBeenCalled();
    expect(gameServer.instance.reportResult).not.toHaveBeenCalled();
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });

  it('resolves won: null on a reported hash mismatch, regardless of winnerSide', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart({ ...baseMatchStart, localSide: 1 });

    handlers.onMatchOver({ winnerSide: 1, reason: 'mismatch', mismatch: true });

    await expect(promise).resolves.toEqual({ won: null, stateHash: '' });
  });

  it('resolves won: null when onMatchOver arrives before match_start (myOwner never established)', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();

    handlers.onMatchOver({ winnerSide: 1, reason: 'disconnect', mismatch: false });

    await expect(promise).resolves.toEqual({ won: null, stateHash: '' });
    expect(MockBattleEngine).not.toHaveBeenCalled();
  });

  it('ignores a later frame_batch after onMatchOver already settled the match', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart({ ...baseMatchStart, localSide: 1 });
    handlers.onMatchOver({ winnerSide: 1, reason: 'disconnect', mismatch: false });
    await promise;

    expect(() => handlers.onFrameBatch({ toFrame: 999, frames: [] })).not.toThrow();
    expect(engine.ingestFrameBatch).not.toHaveBeenCalled();
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1); // still just the one finish()
  });
});

describe('playRankedMatch — onDisconnect', () => {
  it('rejects when the gameserver disconnects mid-match', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);

    handlers.onDisconnect(4001);

    await expect(promise).rejects.toThrow('gameserver disconnected mid-match (code 4001)');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });
});

describe('playRankedMatch — exceptions never escape the process (2026-07-14 load-test regression)', () => {
  it('rejects this match (without throwing) when constructing BattleEngine throws inside onMatchStart', async () => {
    MockBattleEngine.mockImplementation(() => {
      throw new Error('stale @nw/engine build: new Prng() blew up');
    });
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();

    expect(() => handlers.onMatchStart(baseMatchStart)).not.toThrow();

    await expect(promise).rejects.toThrow('stale @nw/engine build: new Prng() blew up');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });

  it('rejects this match (without throwing) when driver.ingestFrameBatch throws', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);
    engine.ingestFrameBatch.mockImplementation(() => {
      throw new Error('ingest boom');
    });

    expect(() => handlers.onFrameBatch({ toFrame: 3, frames: [] })).not.toThrow();

    await expect(promise).rejects.toThrow('ingest boom');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
    expect(engine.advance).not.toHaveBeenCalled(); // pump() never even ran — the throw was in ingestFrameBatch
  });

  it('rejects this match (without throwing) when driver.advance throws mid-pump', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);
    engine.advance.mockImplementation(() => {
      throw new Error('advance boom');
    });

    expect(() => handlers.onFrameBatch({ toFrame: 3, frames: [] })).not.toThrow();

    await expect(promise).rejects.toThrow('advance boom');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });

  it('rejects this match (without throwing) when driver.advance throws on a later setImmediate-chunked pump', async () => {
    const promise = playRankedMatch(opts());
    await flush();
    const handlers = gameServer.getHandlers();
    handlers.onMatchStart(baseMatchStart);
    engine.advance
      .mockReturnValueOnce({ toSubmit: [], hasMore: true })
      .mockImplementationOnce(() => {
        throw new Error('advance boom on chunk 2');
      });

    handlers.onFrameBatch({ toFrame: 100, frames: [] });

    await expect(promise).rejects.toThrow('advance boom on chunk 2');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });
});

describe('playRankedMatch — matchmaking / connection failures', () => {
  it('rejects when matchmaking itself fails, without ever constructing a gameserver connection', async () => {
    gateway.enqueueRanked.mockRejectedValue(new Error('room_error: SERVER_FULL no room'));

    await expect(playRankedMatch(opts())).rejects.toThrow('room_error: SERVER_FULL no room');
    expect(MockGameServerClient).not.toHaveBeenCalled();
  });

  it('rejects when the gameserver connection itself fails before match_start', async () => {
    gameServer.instance.connect.mockImplementation(() => Promise.reject(new Error('match_start timed out')));

    await expect(playRankedMatch(opts())).rejects.toThrow('match_start timed out');
    expect(gameServer.instance.close).toHaveBeenCalledTimes(1);
  });
});

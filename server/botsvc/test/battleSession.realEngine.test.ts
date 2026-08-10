// End-to-end coverage of playRankedMatch driving the REAL @nw/engine (via the real, unmocked
// engineDriver.BattleEngine) — only the network layer (GatewayClient/GameServerClient) is faked. This
// complements battleSession.test.ts's mocked-engine orchestration tests: those prove battleSession.ts
// handles abort/timeout/onMatchOver/exceptions correctly with an arbitrary engine; this file proves the
// real engine actually gets constructed, ingests frame batches, decides via AISystem, and reaches
// game_over through playRankedMatch's own pump loop end-to-end, exactly as a real ranked match would.
//
// Mirrors engineDriver.test.ts's own two-BattleEngine relay pattern (Room.ts-style: batch submitted
// commands onto one frame, broadcast an identical FrameBatch to both sides) but with one side being the
// bot INSIDE playRankedMatch (opaque — driven only through the mocked GameServerClient's handlers) and
// the other a raw BattleEngine the test holds directly and treats as "the opponent" (and de facto
// authoritative relay driver, matching what a real gameserver's Room does).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/gatewayClient', () => ({ GatewayClient: vi.fn() }));
vi.mock('../src/gameServerClient', () => ({ GameServerClient: vi.fn() }));

import { GatewayClient } from '../src/gatewayClient';
import { GameServerClient, type GameServerClientHandlers } from '../src/gameServerClient';
import { BattleEngine } from '../src/engineDriver';
import { playRankedMatch, type RankedMatchOutcome } from '../src/battleSession';
import type { FrameBatch, MatchStart } from '../src/generated/transport';

const TOP_DECK = ['infantry_1', 'shieldbearer_1', 'archer_1', 'max_1', 'lena_1', 'mara_1'];
const BOTTOM_DECK = ['runner', 'ironclad', 'berserker', 'infantry_2', 'archer_2', 'shieldbearer_2'];

function matchStart(seed: number, localSide: 0 | 1): MatchStart {
  return {
    roomId: 'test-room',
    mode: 1,
    seed,
    startFrame: 0,
    localSide,
    opponentName: 'opponent',
    opponentPublicId: '000000001',
    opponentTitle: '',
    opponentAvatarId: '',
    opponentSkins: [],
    topDeck: TOP_DECK,
    bottomDeck: BOTTOM_DECK,
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Drives one full real ranked match: `botLocalSide` plays inside the real playRankedMatch (network
 * mocked, engine real); the opposite wire side is a raw BattleEngine the test drives directly as the
 * authoritative "gameserver" relay. Returns once playRankedMatch settles.
 */
async function runRealMatch(
  seed: number,
  botLocalSide: 0 | 1,
  maxRounds = 20_000,
): Promise<{ outcome: RankedMatchOutcome; opponent: BattleEngine; submitCmd: ReturnType<typeof vi.fn> }> {
  const enqueueRanked = vi.fn().mockResolvedValue({ gameUrl: 'ws://game/1', ticket: 'tkt-1' });
  (GatewayClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    enqueueRanked,
    close: vi.fn(),
  }));

  let handlers: GameServerClientHandlers | undefined;
  const submitCmd = vi.fn();
  const close = vi.fn();
  const reportResult = vi.fn();
  const connect = vi.fn((_url: string, _ticket: string, h: GameServerClientHandlers) => {
    handlers = h;
    return new Promise<void>(() => undefined);
  });
  (GameServerClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    connect,
    submitCmd,
    reportResult,
    close,
  }));

  const promise = playRankedMatch({
    gatewayWsUrl: 'ws://gw',
    jwt: 'jwt-1',
    deck: botLocalSide === 1 ? TOP_DECK : BOTTOM_DECK,
    difficulty: 10,
  });
  await flush();
  if (!handlers) throw new Error('connect() was never called');

  const oppSide: 0 | 1 = botLocalSide === 1 ? 0 : 1;
  const opponent = new BattleEngine(matchStart(seed, oppSide), 10);
  handlers.onMatchStart(matchStart(seed, botLocalSide));

  const BATCH_FRAMES = 3;
  let confirmedTo = -1;
  let pendingOpp: Uint8Array[] = [];
  let submitCallsSeen = 0;
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });

  for (let round = 0; round < maxRounds && !settled; round++) {
    const assignFrame = confirmedTo + 1;
    confirmedTo = assignFrame + (BATCH_FRAMES - 1);

    const pendingBot = submitCmd.mock.calls.slice(submitCallsSeen).map((c) => c[0] as Uint8Array);
    submitCallsSeen = submitCmd.mock.calls.length;

    const cmds = [
      ...pendingOpp.map((commands) => ({ side: oppSide, commands })),
      ...pendingBot.map((commands) => ({ side: botLocalSide, commands })),
    ];
    const fb: FrameBatch = { toFrame: confirmedTo, frames: cmds.length > 0 ? [{ frame: assignFrame, cmds }] : [] };

    opponent.ingestFrameBatch(fb);
    pendingOpp = opponent.advance().toSubmit;

    handlers.onFrameBatch(fb);
    await flush();
    await flush();

    if (opponent.isGameOver()) {
      // Feed a few more empty windows so the bot's own engine (fed the identical confirmed stream)
      // gets the chance to reach the same game_over tick before we give up waiting on it.
      for (let extra = 0; extra < 5 && !settled; extra++) {
        const af = confirmedTo + 1;
        confirmedTo = af + (BATCH_FRAMES - 1);
        handlers.onFrameBatch({ toFrame: confirmedTo, frames: [] });
        await flush();
      }
      break;
    }
  }

  const outcome = await promise;
  return { outcome, opponent, submitCmd };
}

describe('playRankedMatch driving the real @nw/engine end-to-end', () => {
  it('bot as Top (localSide 1): resolves with the same stateHash/winner the authoritative engine computed', async () => {
    const { outcome, opponent } = await runRealMatch(1234, 1);

    expect(opponent.isGameOver()).toBe(true);
    const result = opponent.getResult();
    const expectedWon = result.winnerSide === null ? null : result.winnerSide === 1;

    expect(outcome).toEqual({ won: expectedWon, stateHash: result.stateHash });
  }, 20_000);

  it('bot as Bottom (localSide 0): wire-side winner/hash still agree (catches the 2026-07-14 owner-vs-wire-side relabeling bug class)', async () => {
    const { outcome, opponent } = await runRealMatch(4242, 0);

    expect(opponent.isGameOver()).toBe(true);
    const result = opponent.getResult();
    const expectedWon = result.winnerSide === null ? null : result.winnerSide === 0;

    expect(outcome).toEqual({ won: expectedWon, stateHash: result.stateHash });
  }, 20_000);
});

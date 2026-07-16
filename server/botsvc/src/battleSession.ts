// Orchestrates one ranked match end-to-end (BOTSVC_DESIGN §1 B3 / §8): gateway enqueue -> match_found
// -> gameserver connect -> lockstep loop (BattleEngine) -> match_result -> disconnect. This is the one
// entry point `BotSession.tickBattle` calls; everything else in this file is wiring.
import type { AIDifficulty } from '@nw/engine';
import { GatewayClient } from './gatewayClient';
import { GameServerClient } from './gameServerClient';
import { BattleEngine } from './engineDriver';
import type { FrameBatch } from './generated/transport';

export interface PlayRankedMatchOptions {
  gatewayWsUrl: string;
  jwt: string;
  deck: string[];
  difficulty?: AIDifficulty;
  /** Overall wall-clock guard against a stalled/never-ending match (default 20 min). */
  maxMatchMs?: number;
  /** Fired once matchmaking succeeds and the gameserver connection is being established (for caller status/state tracking). */
  onMatched?: () => void;
}

export interface RankedMatchOutcome {
  won: boolean | null;
  stateHash: string;
}

// Max engine frames stepped per synchronous chunk (2 gameserver batches' worth, FRAMES_PER_BATCH=3).
// A behind bot drains its backlog across setImmediate chunks instead of one blocking burst, so ping/
// pong and other matches' frames get serviced in between — see BattleEngine.advance's maxFrames note.
const MAX_FRAMES_PER_ADVANCE = 6;

/** Plays one real ranked match as a bot. Rejects on any matchmaking/connection/protocol failure. */
export async function playRankedMatch(opts: PlayRankedMatchOptions): Promise<RankedMatchOutcome> {
  const gateway = new GatewayClient();
  const { gameUrl, ticket } = await gateway.enqueueRanked(opts.gatewayWsUrl, opts.jwt, opts.deck);
  opts.onMatched?.();

  const game = new GameServerClient();
  let driver: BattleEngine | undefined;
  let myOwner: 0 | 1 | undefined;

  return new Promise<RankedMatchOutcome>((resolve, reject) => {
    let settled = false;
    const maxMatchMs = opts.maxMatchMs ?? 20 * 60_000;
    const timer = setTimeout(() => {
      finish(() => reject(new Error('match exceeded max wall-clock duration')));
    }, maxMatchMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      game.close();
      fn();
    };

    // Steps the engine in bounded chunks, submitting decided commands, and reschedules itself via
    // setImmediate while frames remain — yielding the event loop between chunks so a behind bot's
    // catch-up can't monopolize the loop and starve its own heartbeat (BOTSVC_DESIGN §3.1). Any throw
    // fails just this match (see the file-header note); the driver/settled guards keep a queued
    // continuation from touching a finished match.
    const pump = (): void => {
      if (!driver || settled) return;
      try {
        const { toSubmit, hasMore } = driver.advance(MAX_FRAMES_PER_ADVANCE);
        for (const bytes of toSubmit) game.submitCmd(bytes);
        if (driver.isGameOver()) {
          const result = driver.getResult();
          const won = driver.didIWin();
          // `?? 0` matches client/src/app/nav/result.ts's own draw sentinel (winner ?? 0).
          game.reportResult(result.stateHash, result.winnerSide ?? 0, '');
          finish(() => resolve({ won, stateHash: result.stateHash }));
        } else if (hasMore) {
          setImmediate(pump);
        }
      } catch (err) {
        finish(() => reject(err as Error));
      }
    };

    // These fire synchronously from a WS 'message' event (see envelopeSocket.ts) — an uncaught throw
    // here becomes an uncaughtException that kills the ENTIRE botsvc process, not just this one bot's
    // match (found via the 2026-07-14 1000-bot load test: a stale @nw/engine build made `new Prng()`
    // throw inside onMatchStart and took the whole fleet down). Every path must fail this one match,
    // never the process.
    game
      .connect(gameUrl, ticket, {
        onMatchStart: (matchStart) => {
          try {
            myOwner = matchStart.localSide as 0 | 1;
            driver = new BattleEngine(matchStart, opts.difficulty ?? 5);
          } catch (err) {
            finish(() => reject(err as Error));
          }
        },
        onFrameBatch: (fb: FrameBatch) => {
          if (!driver || settled) return;
          try {
            driver.ingestFrameBatch(fb);
            pump();
          } catch (err) {
            finish(() => reject(err as Error));
          }
        },
        // Server settled the match unilaterally (opponent disconnect-forfeit or hash mismatch) before
        // this bot's own engine reached game_over — no more frame_batches are coming (Room.destroy()
        // never closes the socket), so resolve now instead of hanging until maxMatchMs fires.
        onMatchOver: (m) => {
          if (settled) return;
          const won = m.mismatch || myOwner === undefined ? null : m.winnerSide === myOwner;
          finish(() => resolve({ won, stateHash: '' }));
        },
        onDisconnect: (code) => {
          finish(() => reject(new Error(`gameserver disconnected mid-match (code ${code})`)));
        },
      })
      .catch((err) => finish(() => reject(err)));
  });
}


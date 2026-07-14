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

/** Plays one real ranked match as a bot. Rejects on any matchmaking/connection/protocol failure. */
export async function playRankedMatch(opts: PlayRankedMatchOptions): Promise<RankedMatchOutcome> {
  const gateway = new GatewayClient();
  const { gameUrl, ticket } = await gateway.enqueueRanked(opts.gatewayWsUrl, opts.jwt, opts.deck);
  opts.onMatched?.();

  const game = new GameServerClient();
  let driver: BattleEngine | undefined;

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

    game
      .connect(gameUrl, ticket, {
        onMatchStart: (matchStart) => {
          driver = new BattleEngine(matchStart, opts.difficulty ?? 5);
        },
        onFrameBatch: (fb: FrameBatch) => {
          if (!driver || settled) return;
          driver.ingestFrameBatch(fb);
          const { toSubmit } = driver.advance();
          for (const bytes of toSubmit) game.submitCmd(bytes);
          if (driver.isGameOver()) {
            const result = driver.getResult();
            const won = driver.didIWin();
            // `?? 0` matches client/src/app/nav/result.ts's own draw sentinel (winner ?? 0).
            game.reportResult(result.stateHash, result.winnerSide ?? 0, '');
            finish(() => resolve({ won, stateHash: result.stateHash }));
          }
        },
        onDisconnect: (code) => {
          finish(() => reject(new Error(`gameserver disconnected mid-match (code ${code})`)));
        },
      })
      .catch((err) => finish(() => reject(err)));
  });
}


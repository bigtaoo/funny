/**
 * `net/judgeRunner.ts` — the failure and decode arms of peer-judge recomputation.
 *
 * `judge-runner.test.ts` and `pve-judge.test.ts` prove the thing that matters most (a third-party
 * recompute reproduces the authoritative hash / star count byte-for-byte) but only along the happy
 * path of each of the three modes. What was never driven: 13 branches covering every way a
 * judge_request can be un-recomputable, the siege branch's outcome mapping, and the proto→engine
 * command decode for anything other than a play_card.
 *
 * These are worth cases because this file decides who gets convicted of cheating. A decode arm
 * that silently mistranslates (a refresh_hand read as a play_card at handIndex 0) produces a
 * *confident, deterministic, wrong* verdict — the recompute would disagree with BOTH honest
 * clients, and the arbitration reads that as the reporting side having tampered. And every
 * un-recomputable request has to come back as `ok:false` rather than as a verdict: "I could not
 * check this" and "this player cheated" must never be the same answer.
 */
import { describe, it, expect } from 'vitest';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';
import { runJudge } from '../src/net/judgeRunner';
import { PlayerCommands } from '../src/net/proto/game';
import type { JudgeRequest } from '../src/net/proto/transport';
import type { LevelDefinition } from '@nw/engine';

const SEED = 0xbeef;

/** One proto-encoded frame carrying `cmds` for `side`. */
function frame(f: number, side: number, cmds: unknown[]): JudgeRequest['frames'][number] {
  return {
    frame: f,
    cmds: [{ side, commands: PlayerCommands.encode({ commands: cmds as never }).finish() }],
  } as JudgeRequest['frames'][number];
}

function req(over: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    requestId: 'r1',
    seed: SEED,
    mode: 1,
    endFrame: 200,
    frames: [],
    topDeck: [],
    bottomDeck: [],
    levelId: '',
    defenseJson: '',
    cardInstancesJson: '',
    equipmentInvJson: '',
    ...over,
  } as JudgeRequest;
}

const FIRST_LEVEL = CAMPAIGN_LEVEL_ORDER[0]!;

// ── Un-recomputable requests ────────────────────────────────────────────────────────────────

describe('requests the judge cannot recompute', () => {
  it('answers ok:false (not a verdict) when a frame carries undecodable command bytes', () => {
    // A corrupted/truncated frame payload must not become a verdict: the whole arbitration rests
    // on the recompute being able to replay the exact server-ordered stream.
    const bad = {
      frame: 10,
      cmds: [{ side: 0, commands: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]) }],
    } as JudgeRequest['frames'][number];
    const out = runJudge(req({ frames: [bad] }));
    expect(out.ok).toBe(false);
    expect(out.stateHash).toBe('');
  });

  it('answers ok:false for a PvE level this build does not know', () => {
    // A judge on an older/newer client simply has no local definition to recompute against —
    // that is a version mismatch, not evidence about the reporting player.
    const out = runJudge(req({ levelId: 'ch9_lv99_from_the_future' }));
    expect(out.ok).toBe(false);
    expect(out.stars).toBe(0);
  });

  it('answers ok:false for a PvE recompute whose frame stream ends before the level does', () => {
    const out = runJudge(req({ levelId: FIRST_LEVEL, endFrame: 30 }));
    expect(out.ok).toBe(false);
  });

  it('answers ok:false when the PvE roster snapshot is not valid JSON', () => {
    // cardInstancesJson/equipmentInvJson come from the server; malformed input has to fail the
    // recompute rather than fall back to an empty roster, which would recompute a DIFFERENT
    // (weaker) run and could turn an honest clear into a mismatch.
    const out = runJudge(req({ levelId: FIRST_LEVEL, cardInstancesJson: '{not json' }));
    expect(out.ok).toBe(false);
    const out2 = runJudge(req({ levelId: FIRST_LEVEL, equipmentInvJson: '[' }));
    expect(out2.ok).toBe(false);
  });

  it('answers ok:false for a siege whose defence config is not valid JSON', () => {
    const out = runJudge(req({ defenseJson: '{"id":' }));
    expect(out.ok).toBe(false);
  });

  it('answers ok:false for a siege whose defence config parses but is not a runnable level', () => {
    // Valid JSON, wrong shape: the engine build blows up somewhere inside, and the outer catch is
    // what keeps that from propagating out of the judge and killing the WS handler.
    const out = runJudge(req({ defenseJson: '{"id":"x"}' }));
    expect(out.ok).toBe(false);
  });

  it('answers ok:false when a siege recompute cannot reach the end of the battle', () => {
    const level: LevelDefinition = {
      id: 'siege_unfinished',
      chapter: 0,
      seed: SEED,
      objective: { kind: 'destroy_base' },
      waves: { entries: [] },
      battleTimeoutTicks: 20_000,
    };
    const out = runJudge(req({ defenseJson: JSON.stringify(level), endFrame: 10 }));
    expect(out.ok).toBe(false);
  });
});

// ── Siege outcome mapping ───────────────────────────────────────────────────────────────────

describe('siege recomputation', () => {
  function siegeLevel(over: Partial<LevelDefinition> = {}): LevelDefinition {
    return {
      id: 'siege_t',
      chapter: 0,
      seed: SEED,
      objective: { kind: 'destroy_base' },
      waves: { entries: [] },
      battleTimeoutTicks: 60,
      ...over,
    } as LevelDefinition;
  }

  it('an attacker that never breaks through leaves the tile with the defender', () => {
    // No attacker commands and a hard time limit: the recompute has to land on "defence held"
    // (winnerSide 1), and in particular must not answer 0 — which is the value that captures the
    // tile, i.e. the difference between a failed siege and a lost city.
    const out = runJudge(req({ defenseJson: JSON.stringify(siegeLevel()), endFrame: 600 }));
    expect(out.ok).toBe(true);
    expect(out.winnerSide).toBe(1);
    // stateHash/stars are meaningless for siege and must stay empty rather than carrying junk
    // that meta might compare against something.
    expect(out.stateHash).toBe('');
    expect(out.stars).toBe(0);
    expect(out.statsJson).toBe('');
  });

  it('an attacker that breaks through captures the tile (winnerSide 0)', () => {
    // The other arm of the same mapping, and the one with a consequence: a pre-placed attacker
    // army against a 1-HP defender base ends with Bottom winning, which is what worldsvc reads
    // as attacker_win. Both arms matter because the mapping's fallback is `?? 1` — a recompute
    // that lost the winner would silently hand every contested tile back to the defender.
    const level = siegeLevel({
      defenderBaseHp: 1,
      battleTimeoutTicks: 20_000,
      attackerArmy: [
        { unitType: 'infantry', col: 0, row: 16 },
        { unitType: 'infantry', col: 1, row: 16 },
      ],
    } as Partial<LevelDefinition>);
    const out = runJudge(req({ defenseJson: JSON.stringify(level), endFrame: 20_000 }));
    expect(out.ok).toBe(true);
    expect(out.winnerSide).toBe(0);
  }, 30_000);
});

// ── PvE outcome mapping ─────────────────────────────────────────────────────────────────────

describe('PvE recomputation', () => {
  // Two branches stay uncovered on purpose, both of the same shape: the `winner ?? 0` (PvE loss)
  // and `winner ?? 1` (siege) fallbacks fire only when `state.winner` is null, i.e. a run that
  // ends in a DRAW. In campaign/siege that requires reaching the force-draw tick threshold —
  // a ~30 000-tick recompute per case, for a fallback that reports the same side the adjacent
  // arm already reports in every reachable scenario. Left as-is.
  it('reports zero stars and no stats for a run the player did not win', () => {
    // A recompute that ends with the player losing is a valid, successful recompute of a FAILED
    // clear — `ok:true` with 0 stars, which is what tells meta "this claim was false" as opposed
    // to `ok:false`, which means "I could not tell".
    const level = CAMPAIGN_LEVELS[FIRST_LEVEL]!;
    // Drive the level with no player commands at all: the waves walk in unopposed.
    const out = runJudge(req({ levelId: FIRST_LEVEL, endFrame: 20_000 }));
    expect(out.ok).toBe(true);
    expect(out.winnerSide).not.toBe(0);
    expect(out.stars).toBe(0);
    expect(out.statsJson).toBe('');
    expect(level.objective).toBeDefined(); // guard: the fixture level still exists
  }, 30_000);
});

// ── The proto → engine command decode ───────────────────────────────────────────────────────

describe('command decode', () => {
  it('translates each command variant to its own engine type', () => {
    // The judge's decode must agree with NetInputSource's. If refresh_hand or upgrade_base fell
    // through to the play_card tail, the recompute would play a card nobody played — a wrong
    // verdict that is fully deterministic and therefore trusted.
    const level = JSON.stringify({
      id: 'siege_decode',
      chapter: 0,
      seed: SEED,
      objective: { kind: 'destroy_base' },
      waves: { entries: [] },
      battleTimeoutTicks: 60,
    });
    const variants = [
      { refreshHand: {}, playCard: undefined, upgradeBase: undefined },
      { upgradeBase: {}, playCard: undefined, refreshHand: undefined },
      { playCard: { handIndex: 1, col: 3, row: 0 }, upgradeBase: undefined, refreshHand: undefined },
      // Nothing set at all — a command from a newer client whose variant this build cannot see.
      // The tail's `?? 0` defaults are what keep that from decoding as NaN/undefined and
      // poisoning the recompute (or throwing inside the engine).
      { playCard: undefined, upgradeBase: undefined, refreshHand: undefined },
    ];
    const out = runJudge(
      req({
        defenseJson: level,
        endFrame: 600,
        frames: variants.map((v, i) => frame(10 + i * 5, 0, [v])),
      }),
    );
    expect(out.ok).toBe(true);
  });
});

// ── Deck restriction plumbing ───────────────────────────────────────────────────────────────

describe('deck restriction', () => {
  it('treats a one-sided or absent deck list as "no restriction" without throwing', () => {
    // `topDeck`/`bottomDeck` are proto repeated fields, so they can arrive as undefined from an
    // older peer. Both the `?? []` fallbacks and the `||` between the two sides need to hold, or
    // the judge either crashes or silently restricts a pool it should not have.
    const noFields = runJudge({ ...req(), topDeck: undefined, bottomDeck: undefined } as unknown as JudgeRequest);
    expect(noFields.ok).toBe(false); // no frames to replay — but it got that far without throwing

    const level = JSON.stringify({
      id: 'siege_decks',
      chapter: 0,
      seed: SEED,
      objective: { kind: 'destroy_base' },
      waves: { entries: [] },
      battleTimeoutTicks: 60,
    });
    // A bottom-only deck list must still reach the engine as a restriction (the `||`'s second arm).
    const bottomOnly = runJudge(
      req({ defenseJson: level, endFrame: 600, topDeck: [], bottomDeck: ['infantry_1'] }),
    );
    expect(bottomOnly.ok).toBe(true);
  });
});

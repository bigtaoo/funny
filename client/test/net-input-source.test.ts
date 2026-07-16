// NetInputSource (S1-7) — lockstep online input source.
//
// Two layers of coverage:
//  1. Unit: take()/buffer/watermark/decode semantics in isolation.
//  2. Integration: two real `netplay` engines driven by two NetInputSources
//     through an in-process fake metronome that mirrors gameserver `Room`'s
//     deterministic relay (real game.proto bytes on the wire path). Asserts
//     per-tick state-hash parity (no divergence), jitter absorption, pause on
//     server stop, and no rollback.
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { NetInputSource, type CmdSink } from '../src/game/net/NetInputSource';
import { RecordingInputSource } from '../src/game/net/ReplayInputSource';
import type { GameConfig, IGameEngine } from '../src/game/types';
import { PlayerCommands } from '../src/net/proto/game';
import type { FrameCmds, ServerMsg, SideCmd } from '../src/net/proto/transport';

const TICK_DT = 1 / 30;
const FRAMES_PER_BATCH = 3;

// ── helpers: build the bytes / messages the server would put on the wire ──────

/** Encode a single play_card action as game.proto PlayerCommands opaque bytes. */
function encPlay(handIndex: number, col: number, row = 0): Uint8Array {
  return PlayerCommands.encode(
    PlayerCommands.fromPartial({ commands: [{ playCard: { handIndex, col, row } }] }),
  ).finish();
}

function frameBatchMsg(toFrame: number, frames: FrameCmds[] = []): ServerMsg {
  return { frameBatch: { toFrame, frames } } as ServerMsg;
}

function matchStartMsg(seed: number, localSide: number, startFrame = 0): ServerMsg {
  return {
    matchStart: { roomId: 'room-1', mode: 0, seed, startFrame, localSide, opponentName: '', opponentPublicId: '', opponentTitle: '', topDeck: [], bottomDeck: [] },
  } as ServerMsg;
}

const noopSink: CmdSink = { submitCmd: () => {} };

// ─────────────────────────────────────────────────────────────────────────────
describe('NetInputSource — take() / buffer / watermark', () => {
  it('stalls (null) before match_start', () => {
    const ni = new NetInputSource(noopSink);
    expect(ni.take(0)).toBeNull();
  });

  it('releases the start frame immediately, then stalls until confirmed', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: FRAMES_PER_BATCH });
    ni.handleServerMsg(matchStartMsg(123, 0));
    expect(ni.take(0)).toEqual([]); // startFrame playable (empty cmd set)
    expect(ni.take(1)).toBeNull(); // confirmedTo=0, playTo=0
  });

  it('holds playback one batch behind the watermark (jitter cushion)', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: FRAMES_PER_BATCH });
    ni.handleServerMsg(matchStartMsg(1, 0));
    ni.handleServerMsg(frameBatchMsg(6)); // confirmedTo=6 → playTo = 6-3 = 3
    expect(ni.take(1)).toEqual([]);
    expect(ni.take(2)).toEqual([]);
    expect(ni.take(3)).toEqual([]);
    expect(ni.take(4)).toBeNull(); // beyond the cushion → stall
  });

  it('bufferFrames=0 plays to the edge of the watermark', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: 0 });
    ni.handleServerMsg(matchStartMsg(1, 0));
    ni.handleServerMsg(frameBatchMsg(6)); // playTo = 6
    expect(ni.take(6)).toEqual([]);
    expect(ni.take(7)).toBeNull();
  });

  it('confirmedLead reports the releasable backlog ahead of a frame', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: FRAMES_PER_BATCH });
    expect(ni.confirmedLead(0)).toBe(0); // before match_start
    ni.handleServerMsg(matchStartMsg(1, 0));
    ni.handleServerMsg(frameBatchMsg(903)); // playTo = 903 - 3 = 900
    expect(ni.confirmedLead(0)).toBe(900); // 30 s of backlog at 30 Hz
    expect(ni.confirmedLead(900)).toBe(0); // caught up to the head
    expect(ni.confirmedLead(950)).toBe(0); // never negative past the head
  });

  it('decodes non-empty frames back into PlayerCommand[] (owner=side, tick=frame)', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: 0 });
    ni.handleServerMsg(matchStartMsg(1, 0));
    const frame: FrameCmds = {
      frame: 3,
      // server orders by side asc — preserve it on decode
      cmds: [
        { side: 0, commands: encPlay(2, 1) },
        { side: 1, commands: encPlay(5, 8, 4) },
      ] as SideCmd[],
    };
    ni.handleServerMsg(frameBatchMsg(3, [frame]));
    expect(ni.take(3)).toEqual([
      { type: 'play_card', owner: 0, tick: 3, handIndex: 2, col: 1, row: 0 },
      { type: 'play_card', owner: 1, tick: 3, handIndex: 5, col: 8, row: 4 },
    ]);
  });

  it('decodes an upgrade_base command', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: 0 });
    ni.handleServerMsg(matchStartMsg(1, 0));
    const bytes = PlayerCommands.encode(
      PlayerCommands.fromPartial({ commands: [{ upgradeBase: {} }] }),
    ).finish();
    ni.handleServerMsg(frameBatchMsg(3, [{ frame: 3, cmds: [{ side: 1, commands: bytes }] }]));
    expect(ni.take(3)).toEqual([{ type: 'upgrade_base', owner: 1, tick: 3 }]);
  });

  it('never retracts the watermark (no rollback) on a stale/duplicate batch', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: 0 });
    ni.handleServerMsg(matchStartMsg(1, 0));
    ni.handleServerMsg(frameBatchMsg(9));
    ni.handleServerMsg(frameBatchMsg(6)); // stale, lower watermark
    expect(ni.take(9)).toEqual([]); // still releasable — watermark held at 9
    expect(ni.resumeFrame()).toBe(9);
  });

  it('conn_resync merges the replayed log and jumps the watermark forward', () => {
    const ni = new NetInputSource(noopSink, { bufferFrames: 0 });
    ni.handleServerMsg(matchStartMsg(7, 1));
    ni.handleServerMsg(frameBatchMsg(3));
    // reconnect: server replays non-empty frame 6 and says cur_frame=9
    ni.handleServerMsg({
      connResync: {
        seed: 7,
        startFrame: 0,
        log: [{ frame: 6, cmds: [{ side: 0, commands: encPlay(1, 2) }] }],
        curFrame: 9,
      },
    } as ServerMsg);
    expect(ni.take(6)).toEqual([
      { type: 'play_card', owner: 0, tick: 6, handIndex: 1, col: 2, row: 0 },
    ]);
    expect(ni.take(9)).toEqual([]);
    expect(ni.resumeFrame()).toBe(9);
  });
});

describe('NetInputSource — submit()', () => {
  it('encodes the action as opaque PlayerCommands bytes (no frame, owner ignored)', () => {
    const sent: Uint8Array[] = [];
    const ni = new NetInputSource({ submitCmd: (b) => sent.push(b) });
    ni.submit({ type: 'play_card', owner: 0, tick: 999, handIndex: 3, col: 7, row: 2 });
    ni.submit({ type: 'upgrade_base', owner: 0, tick: 999 });
    expect(sent).toHaveLength(2);
    expect(PlayerCommands.decode(sent[0]!).commands).toEqual([
      { playCard: { handIndex: 3, col: 7, row: 2 }, upgradeBase: undefined },
    ]);
    expect(PlayerCommands.decode(sent[1]!).commands).toEqual([
      { playCard: undefined, upgradeBase: {} },
    ]);
  });
});

// ── Integration: two engines, one server, identical evolution ────────────────

/** Mirrors gameserver Room's deterministic relay (M14): 10 Hz batches of 3. */
class FakeServer {
  private curFrame = 0;
  private pending: SideCmd[] = [];
  private subs: ((m: ServerMsg) => void)[] = [];

  subscribe(fn: (m: ServerMsg) => void): void {
    this.subs.push(fn);
  }

  /** A per-side outbound sink — tags submissions with that connection's side. */
  sinkFor(side: number): CmdSink {
    return { submitCmd: (commands) => this.pending.push({ side, commands }) };
  }

  matchStart(seed: number): void {
    // localSide is per-client; subs[0] is side 0, subs[1] is side 1.
    this.subs.forEach((fn, i) => fn(matchStartMsg(seed, i)));
  }

  /** One metronome tick: advance 3 frames, fold pending cmds onto to_frame. */
  tick(): void {
    this.curFrame += FRAMES_PER_BATCH;
    const frames: FrameCmds[] = [];
    if (this.pending.length > 0) {
      const cmds = [...this.pending].sort((a, b) => a.side - b.side); // stable
      frames.push({ frame: this.curFrame, cmds });
      this.pending = [];
    }
    const msg = frameBatchMsg(this.curFrame, frames);
    for (const fn of this.subs) fn(msg);
  }
}

function netConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' };
}

/**
 * Record the merged frame stream the server would broadcast, given a per-batch
 * script of submissions from both sides. Capturing the stream once and replaying
 * it into engines *sequentially* sidesteps the module-global unit/building id
 * counter (reset per `GameState`): two engines run concurrently in one process
 * would interleave id allocation, whereas real clients each own their process.
 */
type Submit = { side: number; bytes: Uint8Array };
function recordFrameStream(script: (batch: number) => Submit[], batches: number): ServerMsg[] {
  const server = new FakeServer();
  const frames: ServerMsg[] = [];
  server.subscribe((m) => {
    if (m.frameBatch) frames.push(m);
  });
  for (let b = 0; b < batches; b++) {
    for (const s of script(b)) server.sinkFor(s.side).submitCmd(s.bytes);
    server.tick();
  }
  return frames;
}

/** Replay a recorded frame stream into a fresh engine; return its fingerprint. */
function replayFingerprint(seed: number, localSide: number, frames: ServerMsg[]): unknown {
  const ni = new NetInputSource(noopSink);
  ni.handleServerMsg(matchStartMsg(seed, localSide));
  const eng = createGameEngine(netConfig(seed), ni);
  for (const fb of frames) {
    ni.handleServerMsg(fb);
    for (let f = 0; f < FRAMES_PER_BATCH; f++) eng.tick(TICK_DT);
  }
  // Drain the one-batch cushion still buffered after the last broadcast.
  for (let i = 0; i < FRAMES_PER_BATCH * 2; i++) eng.tick(TICK_DT);
  return fingerprint(eng);
}

/** Deep-comparable fingerprint of the full game state (same shape both clients). */
function fingerprint(engine: IGameEngine): unknown {
  const s = engine.state;
  const units = Array.from(s.board.units.values())
    .map((u) => `${u.id}:${u.unitType}:${u.side}:${u.col}:${u.y_fp}:${u.x_fp}:${u.hp}:${u.state}`)
    .sort();
  const buildings = Array.from(s.board.buildings.values())
    .map((b) => `${b.id}:${b.buildingType}:${b.side}:${b.col}:${b.row}:${b.hp}`)
    .sort();
  return {
    elapsedTicks: s.elapsedTicks,
    phase: s.phase,
    winner: s.winner,
    bottomBaseHp: s.bottomPlayer.baseHp,
    topBaseHp: s.topPlayer.baseHp,
    bottomInk: s.bottomPlayer.ink,
    topInk: s.topPlayer.ink,
    units,
    buildings,
    stats: s.snapshotStats(),
  };
}

// A scripted duel: side 0 and side 1 each tap cards on different beats/lanes,
// plus an upgrade. The FakeServer merges + side-orders them into the stream.
const upgradeBytes = PlayerCommands.encode(
  PlayerCommands.fromPartial({ commands: [{ upgradeBase: {} }] }),
).finish();
function duelScript(b: number): Submit[] {
  const out: Submit[] = [];
  if (b % 9 === 4) {
    out.push({ side: 0, bytes: encPlay(0, 1) }); // bottom → lane 1
    out.push({ side: 1, bytes: encPlay(0, 8) }); // top → lane 8
  }
  if (b % 13 === 7) out.push({ side: 0, bytes: upgradeBytes });
  return out;
}

describe('NetInputSource — two-client lockstep determinism', () => {
  it('both clients evolve byte-identically from the same seed + frame stream', () => {
    const SEED = 0xc0ffee;
    const frames = recordFrameStream(duelScript, 70); // ~7s of play

    // Same stream → both clients (each its own localSide) reach the same state,
    // at every horizon checked. Sequential replay keeps id allocation in step.
    for (const horizon of [10, 30, 70]) {
      const sub = frames.slice(0, horizon);
      expect(replayFingerprint(SEED, 0, sub)).toEqual(replayFingerprint(SEED, 1, sub));
    }

    // The sim actually did something (not a trivial all-empty match).
    const ni = new NetInputSource(noopSink);
    ni.handleServerMsg(matchStartMsg(SEED, 0));
    const eng = createGameEngine(netConfig(SEED), ni);
    for (const fb of frames) {
      ni.handleServerMsg(fb);
      for (let f = 0; f < FRAMES_PER_BATCH; f++) eng.tick(TICK_DT);
    }
    for (let i = 0; i < FRAMES_PER_BATCH * 2; i++) eng.tick(TICK_DT);
    expect(eng.state.stats[0].unitsSent + eng.state.stats[1].unitsSent).toBeGreaterThan(0);
    expect(eng.state.elapsedTicks).toBeGreaterThan(0);
  });

  it('engine.playCard in netplay routes through submit() to the server', () => {
    const sent: Uint8Array[] = [];
    const ni = new NetInputSource({ submitCmd: (b) => sent.push(b) });
    ni.handleServerMsg(matchStartMsg(1, 0));
    const eng = createGameEngine(netConfig(1), ni);
    eng.tick(TICK_DT); // play the initial frame
    eng.playCard(2, 7);
    eng.upgradeBase();
    expect(sent).toHaveLength(2);
    expect(PlayerCommands.decode(sent[0]!).commands[0]!.playCard).toEqual({
      handIndex: 2,
      col: 7,
      row: 0,
    });
    expect(PlayerCommands.decode(sent[1]!).commands[0]!.upgradeBase).toBeDefined();
  });

  it('pauses when the server stops sending, resumes (catches up) when it continues', () => {
    const SEED = 42;
    const server = new FakeServer();
    const ni = new NetInputSource(server.sinkFor(0));
    server.subscribe((m) => ni.handleServerMsg(m));
    server.matchStart(SEED);
    const eng = createGameEngine(netConfig(SEED), ni);

    // Warm up a few batches.
    for (let b = 0; b < 6; b++) {
      server.tick();
      for (let f = 0; f < FRAMES_PER_BATCH; f++) eng.tick(TICK_DT);
    }
    const stalledAt = eng.state.elapsedTicks;
    expect(stalledAt).toBeGreaterThan(0);

    // Server goes silent — keep ticking wall-clock; engine must not advance.
    for (let i = 0; i < 30; i++) eng.tick(TICK_DT);
    expect(eng.state.elapsedTicks).toBe(stalledAt);

    // Server resumes with a burst of batches; engine fast-forwards to catch up.
    for (let b = 0; b < 4; b++) server.tick();
    for (let i = 0; i < 30; i++) eng.tick(TICK_DT);
    expect(eng.state.elapsedTicks).toBeGreaterThan(stalledAt);
  });

  // The lockstep buffer can pile up when a tab is backgrounded/minimised (rAF
  // halts so the engine stops draining) or after a long stall resolves. Catch-up
  // speeds the sim up proportionally to that backlog so it re-syncs, then settles.
  it('scales catch-up speed with the confirmed backlog (1×/3×/5×/10×)', () => {
    const SEED = 99;
    // Drive F render-frames while continuously topping the watermark so the
    // backlog stays pinned at ~targetLead (and thus one speed tier the whole
    // run), then return total sim ticks advanced. Measuring the rate over many
    // frames lets the per-frame FP remainder (stepDt rarely divides TICK_DT
    // evenly) carry forward and average out, so total ≈ F × speed.
    const F = 60;
    const ticksAtLead = (targetLead: number): number => {
      const ni = new NetInputSource(noopSink);
      ni.handleServerMsg(matchStartMsg(SEED, 0));
      const eng = createGameEngine(netConfig(SEED), ni);
      let total = 0;
      for (let i = 0; i < F; i++) {
        // playTo = toFrame − bufferFrames; hold lead ≈ targetLead at the head.
        ni.handleServerMsg(frameBatchMsg(eng.state.elapsedTicks + targetLead + FRAMES_PER_BATCH));
        const before = eng.state.elapsedTicks;
        eng.tick(TICK_DT);
        total += eng.state.elapsedTicks - before;
      }
      return total;
    };

    expect(ticksAtLead(3)).toBe(F); //                        lead 3   (≤ buffer)      → 1× (exact)
    expect(Math.abs(ticksAtLead(15) - 3 * F)).toBeLessThanOrEqual(2);  // (>0.2 s, ≤1 s) → 3×
    expect(Math.abs(ticksAtLead(60) - 5 * F)).toBeLessThanOrEqual(2);  // (>1 s, ≤3 s)   → 5×
    expect(Math.abs(ticksAtLead(150) - 10 * F)).toBeLessThanOrEqual(2); // (>3 s)        → 10×
  });

  it('catches up a 30 s+ backlog and settles back to 1× once synced', () => {
    const SEED = 123;
    const ni = new NetInputSource(noopSink);
    ni.handleServerMsg(matchStartMsg(SEED, 0));
    const eng = createGameEngine(netConfig(SEED), ni);
    ni.handleServerMsg(frameBatchMsg(1200)); // playTo = 1197 (~40 s backlog)

    // elapsedTicks == the engine's internal currentTick (both ++ per step).
    let renderFrames = 0;
    while (ni.confirmedLead(eng.state.elapsedTicks) > 3 && renderFrames < 2000) {
      eng.tick(TICK_DT);
      renderFrames++;
    }
    // Converged well under the wall (at 1× it would take ~1200 frames; the
    // 10×/5×/3× tiers cut that to a couple hundred), draining all the way down to
    // the jitter buffer (≤ CATCHUP_MIN_LEAD) rather than sticking ~1 s behind.
    expect(renderFrames).toBeLessThan(2000);
    expect(ni.confirmedLead(eng.state.elapsedTicks)).toBeLessThanOrEqual(3);

    // Back inside the buffer ⇒ 1× again: a single render frame advances at most one tick.
    const before = eng.state.elapsedTicks;
    eng.tick(TICK_DT);
    expect(eng.state.elapsedTicks - before).toBeLessThanOrEqual(1);
  });

  it('catches up THROUGH a RecordingInputSource wrapper (prod netplay wiring)', () => {
    // Regression for the "追帧根本没生效" bug: online matches build the engine with
    // `new RecordingInputSource(session.input)` (nav/result.ts), so the engine's input
    // is the recorder wrapper, not the NetInputSource directly. `confirmedLead` is an
    // OPTIONAL method on InputSource; when the wrapper didn't forward it, catchUpSpeed()
    // saw `undefined ?? 0` and stayed pinned at 1× for the entire match — a backgrounded
    // tab's backlog never drained (a placed card only surfaced seconds later). This drives
    // the identical 40 s-backlog scenario as the test above but THROUGH the recorder, so it
    // fails if the wrapper ever drops confirmedLead again.
    const SEED = 123;
    const ni = new NetInputSource(noopSink);
    ni.handleServerMsg(matchStartMsg(SEED, 0));
    const rec = new RecordingInputSource(ni); // exactly how nav/result.ts wires it
    const eng = createGameEngine(netConfig(SEED), rec);
    ni.handleServerMsg(frameBatchMsg(1200)); // playTo = 1197 (~40 s backlog)

    let renderFrames = 0;
    while (ni.confirmedLead(eng.state.elapsedTicks) > 3 && renderFrames < 2000) {
      eng.tick(TICK_DT);
      renderFrames++;
    }
    // With confirmedLead forwarded, the 10×/5×/3× tiers drain ~40 s in a few hundred
    // frames. Pinned at 1× (the bug) it needs ~1200 frames — assert convergence well
    // under a pure-1× rate so the regression bites, not just under the 2000 wall.
    expect(renderFrames).toBeLessThan(600);
    expect(ni.confirmedLead(eng.state.elapsedTicks)).toBeLessThanOrEqual(3);
    // Passthrough stayed transparent: the recorder captured every fast-forwarded frame.
    expect(rec.frameCount).toBe(eng.state.elapsedTicks);
  });

  it('absorbs <100ms jitter without stalling (one-batch cushion)', () => {
    const SEED = 7;
    const server = new FakeServer();
    const ni = new NetInputSource(server.sinkFor(0)); // default bufferFrames=3
    server.subscribe((m) => ni.handleServerMsg(m));
    server.matchStart(SEED);
    const eng = createGameEngine(netConfig(SEED), ni);

    // Prime two batches so the one-batch cushion is filled.
    server.tick();
    server.tick();
    for (let f = 0; f < FRAMES_PER_BATCH; f++) eng.tick(TICK_DT);
    const before = eng.state.elapsedTicks;

    // A batch is "late": wall clock advances one extra batch interval before the
    // next batch arrives. Thanks to the cushion the engine still has frames to
    // play and keeps advancing rather than freezing.
    for (let f = 0; f < FRAMES_PER_BATCH; f++) eng.tick(TICK_DT);
    expect(eng.state.elapsedTicks).toBeGreaterThan(before);
  });
});

/**
 * analyticsIdleWatch.test.ts — `churn_signal{reason:'idle_10min'}`.
 *
 * ANALYTICS_DESIGN §5.6 has promised this signal since the beginning and §12.2/§12.6 deferred it
 * twice with the same note: "no easy approximation, it would fire on the wrong things". So the
 * cases below are mostly about when it must NOT fire — a repeat every minute for one AFK player, a
 * ten-minute claim from a watch that started twenty seconds ago, and the backgrounded tab that
 * `churn_signal{reason:'background'}` has already reported.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
let lifecycle: ((state: 'visible' | 'hidden' | 'exit') => void) | null = null;

vi.mock('../src/analytics/index', () => ({
  track: (event: string, props: Record<string, unknown> = {}) => { tracked.push({ event, props }); },
  currentScene: () => 'LobbyScene',
}));
vi.mock('../src/platform/appLifecycle', () => ({
  onAppLifecycleChange: (cb: (state: 'visible' | 'hidden' | 'exit') => void) => { lifecycle = cb; },
}));

const MIN = 60_000;

/** A hand-driven watch: `tick()` runs one check, `clock` is wall time, `idle` is the injected probe. */
async function harness() {
  vi.resetModules();
  tracked.length = 0;
  lifecycle = null;
  const { startIdleWatch } = await import('../src/analytics/idleWatch');
  let fire: (() => void) | null = null;
  const state = { clock: 0, idle: 0 };
  const stop = startIdleWatch(
    { msSinceActivity: () => state.idle },
    {
      now: () => state.clock,
      setInterval: (fn) => { fire = fn; return 1; },
      clearInterval: () => { fire = null; },
    },
  );
  return {
    state,
    stop,
    tick: () => fire?.(),
    /** Advance both the wall clock and the idle probe — i.e. nobody touched anything. */
    idleFor: (ms: number) => { state.clock += ms; state.idle += ms; },
    /** The player did something: the probe resets, the clock does not. */
    touch: () => { state.idle = 0; },
  };
}

const signals = () => tracked.filter((e) => e.event === 'churn_signal' && e.props.reason === 'idle_10min');

describe('idle watch', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('reports once the player has been still for ten minutes, with the scene they left it on', async () => {
    const h = await harness();
    h.idleFor(9 * MIN);
    h.tick();
    expect(signals()).toHaveLength(0);
    h.idleFor(1 * MIN);
    h.tick();
    expect(signals()).toHaveLength(1);
    expect(signals()[0].props).toMatchObject({ reason: 'idle_10min', scene: 'LobbyScene', idle_sec: 600 });
  });

  it('does not repeat every minute for the same idle stretch', async () => {
    const h = await harness();
    h.idleFor(10 * MIN);
    h.tick();
    h.idleFor(MIN); h.tick();
    h.idleFor(MIN); h.tick();
    h.idleFor(30 * MIN); h.tick();
    expect(signals()).toHaveLength(1);
  });

  it('re-arms once the player comes back, so a second absence is reported too', async () => {
    const h = await harness();
    h.idleFor(10 * MIN);
    h.tick();
    h.touch();
    h.tick();
    h.idleFor(10 * MIN);
    h.tick();
    expect(signals()).toHaveLength(2);
  });

  it('claims no idle time from before the watch existed', async () => {
    const h = await harness();
    // The probe reports a stale renderPolicy value (nothing has ever called holdRenderActive), but
    // the watch has only been running for a minute and may say nothing about the rest.
    h.state.idle = 60 * MIN;
    h.state.clock = MIN;
    h.tick();
    expect(signals()).toHaveLength(0);
  });

  it('stays quiet while the app is in the background — that departure is already reported', async () => {
    const h = await harness();
    lifecycle!('hidden');
    h.idleFor(30 * MIN);
    h.tick();
    expect(signals()).toHaveLength(0);
  });

  it('does not fire the moment a long-backgrounded tab comes back', async () => {
    const h = await harness();
    lifecycle!('hidden');
    h.idleFor(30 * MIN);
    h.tick();
    lifecycle!('visible');
    h.tick();
    expect(signals()).toHaveLength(0);
    // ...and the clock starts again from the return, not from the last touch before the background.
    h.idleFor(10 * MIN);
    h.tick();
    expect(signals()).toHaveLength(1);
  });

  it('stops checking once stopped', async () => {
    const h = await harness();
    h.stop();
    h.idleFor(30 * MIN);
    h.tick();
    expect(signals()).toHaveLength(0);
  });
});

// BOTSVC_DESIGN §3.5: how a BotSession plays PvE — when a run starts, what it reports, and what it
// does not do. The level itself (pve.ts playLevel) is injected here; pve.test.ts plays real levels.
import { describe, it, expect, vi } from 'vitest';
import { BotSession, DEFAULT_PVE_OPTIONS, pveDifficulty, type PveOptions } from '../src/bot';
import { BotApiError } from '../src/apiError';
import type { PveRunResult } from '../src/pve';
import type { BotIdentity } from '../src/pool';
import { PVE_PEAK_START_UTC_H, utcDayStart } from '../src/rotation';

vi.mock('../src/battleSession', () => ({ playRankedMatch: vi.fn() }));

const identity: BotIdentity = { deviceId: 'bot-0001', paymentTier: 'free' };
const DAY = utcDayStart(Date.UTC(2026, 8, 26, 12));
const HOUR = 3_600_000;
/** Every draw 0: one run a day, in the evening window, at its very start. */
const EVENING_RUN_AT = DAY + PVE_PEAK_START_UTC_H * HOUR;

const WIN: PveRunResult = {
  levelId: 'ch1_lv1',
  won: true,
  stars: 2,
  endFrame: 1800,
  frames: [{ frame: 3, cmds: [{ side: 0, commands: 'AA==' }] }],
  stats: { 'kill.infantry': 4 },
};

function fakeMeta(over: Record<string, unknown> = {}): any {
  return {
    deviceLogin: vi.fn().mockResolvedValue({ token: 't', accountId: 'a1', isNew: false }),
    getSave: vi.fn().mockResolvedValue({
      progress: { cleared: [], stars: {} },
      cardInv: { c1: { id: 'c1', defId: 'lichuang', level: 3, xp: 0, gear: {} } },
      equipmentInv: {},
    }),
    pveEnter: vi.fn().mockResolvedValue(undefined),
    pveClear: vi.fn().mockResolvedValue({ capped: false }),
    pveVerify: vi.fn().mockResolvedValue({ verified: true }),
    ...over,
  };
}

function pveOpts(over: Partial<PveOptions> = {}): PveOptions {
  return {
    enabled: true,
    random: () => 0,
    sleep: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(WIN),
    ...over,
  };
}

async function session(meta = fakeMeta(), opts = pveOpts()): Promise<BotSession> {
  const commercial = { buyMonthlyCard: vi.fn(), buyStarterGrowth: vi.fn() };
  const s = new BotSession(
    identity, meta, {} as any, commercial as any, {} as any,
    { gatewayWsUrl: 'ws://unused', chancePerTick: 0 }, { intervalMs: 0 }, undefined, opts,
  );
  await s.login();
  return s;
}

describe('BotSession.pveDueAt — the day plan', () => {
  it('plans today on first ask and keeps that plan for the rest of the day', () => {
    const random = vi.fn(() => 0);
    const s = new BotSession(identity, fakeMeta(), {} as any, {} as any, {} as any,
      { gatewayWsUrl: '', chancePerTick: 0 }, undefined, undefined, pveOpts({ random }));
    expect(s.pveDueAt(DAY + HOUR)).toBe(EVENING_RUN_AT);
    const draws = random.mock.calls.length;
    expect(s.pveDueAt(DAY + 2 * HOUR)).toBe(EVENING_RUN_AT);
    expect(random.mock.calls.length).toBe(draws);
  });

  it('a new UTC day replans, dropping what the old day left unplayed', () => {
    const s = new BotSession(identity, fakeMeta(), {} as any, {} as any, {} as any,
      { gatewayWsUrl: '', chancePerTick: 0 }, undefined, undefined, pveOpts());
    expect(s.pveDueAt(DAY)).toBe(EVENING_RUN_AT);
    expect(s.pveDueAt(DAY + 24 * HOUR)).toBe(EVENING_RUN_AT + 24 * HOUR);
  });

  it('disabled: never due', () => {
    const s = new BotSession(identity, fakeMeta(), {} as any, {} as any, {} as any,
      { gatewayWsUrl: '', chancePerTick: 0 }, undefined, undefined, pveOpts({ enabled: false }));
    expect(s.pveDueAt(DAY + 23 * HOUR)).toBe(Infinity);
  });
});

describe('BotSession.tickPve — when a run starts', () => {
  it('nothing before the planned time', async () => {
    const meta = fakeMeta();
    const s = await session(meta);
    await s.tickPve(EVENING_RUN_AT - 1);
    expect(meta.getSave).not.toHaveBeenCalled();
    expect(s.state).toBe('lobby_idle');
  });

  it('once it is due: one run, and the plan is used up', async () => {
    const meta = fakeMeta();
    const s = await session(meta);
    await s.tickPve(EVENING_RUN_AT);
    expect(meta.pveEnter).toHaveBeenCalledTimes(1);
    expect(s.pveDueAt(EVENING_RUN_AT)).toBe(Infinity);
    await s.tickPve(EVENING_RUN_AT + HOUR);
    expect(meta.pveEnter).toHaveBeenCalledTimes(1);
  });

  it('not logged in, or busy with something else: no run, and the run stays owed', async () => {
    const meta = fakeMeta();
    const offline = new BotSession(identity, meta, {} as any, {} as any, {} as any,
      { gatewayWsUrl: '', chancePerTick: 0 }, undefined, undefined, pveOpts());
    await offline.tickPve(EVENING_RUN_AT);
    const busy = await session(meta);
    busy.state = 'in_battle';
    await busy.tickPve(EVENING_RUN_AT);
    expect(meta.getSave).not.toHaveBeenCalled();
    expect(offline.pveDueAt(EVENING_RUN_AT)).toBe(EVENING_RUN_AT);
    expect(busy.pveDueAt(EVENING_RUN_AT)).toBe(EVENING_RUN_AT);
  });

  it('holds the bot in in_pve for the run, so it does not also queue for ranked', async () => {
    let release!: () => void;
    const sleep = vi.fn(() => new Promise<void>((r) => (release = r)));
    const s = await session(fakeMeta(), pveOpts({ sleep }));
    const run = s.tickPve(EVENING_RUN_AT);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    expect(s.state).toBe('in_pve');
    release();
    await run;
    expect(s.state).toBe('lobby_idle');
  });
});

describe('BotSession.tickPve — what a run reports', () => {
  it('enters the frontier level, plays it with its own cards, waits out the level, reports the clear', async () => {
    const meta = fakeMeta();
    const opts = pveOpts();
    const s = await session(meta, opts);
    const t0 = Date.now();
    await s.tickPve(EVENING_RUN_AT);
    expect(meta.pveEnter).toHaveBeenCalledWith('t', 'ch1_lv1');
    const [level, cards, run] = (opts.play as any).mock.calls[0];
    expect(level.id).toBe('ch1_lv1');
    expect(cards.cardInstances).toEqual([{ id: 'c1', defId: 'lichuang', unitType: 'infantry', level: 3, gear: {} }]);
    expect(run.difficulty).toBe(pveDifficulty(identity.deviceId));
    // 1800 frames at 30 Hz: the clear goes in a minute after entering, not milliseconds after.
    const waited = (opts.sleep as any).mock.calls[0][0];
    expect(waited).toBeGreaterThan(60_000 - (Date.now() - t0) - 50);
    expect(waited).toBeLessThanOrEqual(60_000);
    expect(meta.pveClear).toHaveBeenCalledWith('t', 'ch1_lv1', 2, WIN.stats);
    expect(meta.pveVerify).not.toHaveBeenCalled();
    expect(s.pveCounters).toEqual({ entered: 1, cleared: 1, lost: 0, spotChecked: 0, verified: 0 });
  });

  it('a spot-checked clear sends its frames to /pve/verify', async () => {
    const meta = fakeMeta({ pveClear: vi.fn().mockResolvedValue({ capped: false, needsReplay: true, verifyId: 'v9' }) });
    const s = await session(meta);
    await s.tickPve(EVENING_RUN_AT);
    expect(meta.pveVerify).toHaveBeenCalledWith('t', 'v9', WIN.endFrame, WIN.frames);
    expect(s.pveCounters).toMatchObject({ spotChecked: 1, verified: 1 });
  });

  it('a rejected spot check is counted, not hidden', async () => {
    const meta = fakeMeta({
      pveClear: vi.fn().mockResolvedValue({ capped: false, needsReplay: true, verifyId: 'v9' }),
      pveVerify: vi.fn().mockResolvedValue({ verified: false }),
    });
    const s = await session(meta);
    await s.tickPve(EVENING_RUN_AT);
    expect(s.pveCounters).toMatchObject({ spotChecked: 1, verified: 0 });
  });

  it('a loss reports nothing (stamina stays spent), like the client', async () => {
    const meta = fakeMeta();
    const s = await session(meta, pveOpts({ play: vi.fn().mockResolvedValue({ ...WIN, won: false, stars: 0 }) }));
    await s.tickPve(EVENING_RUN_AT);
    expect(meta.pveEnter).toHaveBeenCalled();
    expect(meta.pveClear).not.toHaveBeenCalled();
    expect(s.pveCounters).toMatchObject({ entered: 1, cleared: 0, lost: 1 });
  });

  it('out of stamina: does not play, and it is not an error', async () => {
    const opts = pveOpts();
    const meta = fakeMeta({ pveEnter: vi.fn().mockRejectedValue(new BotApiError('INSUFFICIENT_STAMINA', 'no')) });
    const s = await session(meta, opts);
    await expect(s.tickPve(EVENING_RUN_AT)).resolves.toBeUndefined();
    expect(opts.play).not.toHaveBeenCalled();
    expect(s.pveCounters.entered).toBe(0);
  });

  it('any other failure propagates, for the scheduler to count', async () => {
    const meta = fakeMeta({ pveEnter: vi.fn().mockRejectedValue(new BotApiError('LEVEL_LOCKED', 'no')) });
    const s = await session(meta);
    await expect(s.tickPve(EVENING_RUN_AT)).rejects.toThrow(/LEVEL_LOCKED/);
    expect(s.state).toBe('lobby_idle');
  });

  it('logging out mid-level abandons the run: no clear, no error', async () => {
    const meta = fakeMeta();
    const s = await session(meta, pveOpts({ sleep: DEFAULT_PVE_OPTIONS.sleep }));
    const run = s.tickPve(EVENING_RUN_AT);
    await vi.waitFor(() => expect(meta.pveEnter).toHaveBeenCalled());
    s.logout();
    await expect(run).resolves.toBeUndefined();
    expect(meta.pveClear).not.toHaveBeenCalled();
    expect(s.state).toBe('offline');
  });

  it('nothing it may enter: no stamina spent', async () => {
    // The whole campaign cleared and 3-starred: no frontier and nothing to improve.
    const { CAMPAIGN_LEVEL_ORDER } = await import('@nw/engine');
    const meta = fakeMeta();
    meta.getSave.mockResolvedValue({
      progress: { cleared: [...CAMPAIGN_LEVEL_ORDER], stars: Object.fromEntries(CAMPAIGN_LEVEL_ORDER.map((id) => [id, 3])) },
    });
    const s = await session(meta);
    await s.tickPve(EVENING_RUN_AT);
    expect(meta.pveEnter).not.toHaveBeenCalled();
  });
});

describe('pveDifficulty', () => {
  it('is fixed per bot and spread over 6..10', () => {
    expect(pveDifficulty('bot-0042')).toBe(pveDifficulty('bot-0042'));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => pveDifficulty(`bot-${String(i).padStart(4, '0')}`)));
    expect([...seen].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10]);
  });
});

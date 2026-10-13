import { describe, it, expect, vi } from 'vitest';
import {
  runRewardLoop, rewardLoopDetour, REWARD_LOOP_LEVEL, FIRST_GACHA_FEAT, FIRST_DAILY_FEAT,
  type RewardLoopDeps,
} from '../src/app/nav/firstRewardLoop';

const anon = vi.hoisted(() => [] as string[]);
vi.mock('../src/analytics', () => ({
  track: vi.fn(),
  countAnonymousFunnelStep: vi.fn((step: string) => { anon.push(step); }),
}));

/** Minimal SaveManager stand-in: just the fields the loop reads/writes. */
function fakeSave(cleared: string[], coins: number) {
  const seen = new Set<string>();
  const save = { progress: { cleared }, wallet: { coins } };
  return {
    seen,
    save,
    get: () => save,
    featSeen: (id: string) => seen.has(id),
    markFeatSeen: (id: string) => { seen.add(id); },
    adoptServer: (s: { wallet: { coins: number } }) => { save.wallet.coins = s.wallet.coins; },
  };
}

const welcomeMail = { mailId: 'm1', subject: 'mail.welcome.author.subject', claimed: false, attachments: [{ kind: 'coins', amount: 1000 }] };

function deps(sm: ReturnType<typeof fakeSave>, mail: unknown[] = [welcomeMail], inLobby = true) {
  const d = {
    saveManager: sm as unknown as RewardLoopDeps['saveManager'],
    client: {
      getMail: vi.fn(async () => ({ mail })),
      claimMail: vi.fn(async () => ({ save: { wallet: { coins: sm.save.wallet.coins + 1000 } } })),
    } as unknown as RewardLoopDeps['client'],
    showGuide: vi.fn((_t: string, _b: string, onDismiss: () => void) => onDismiss()),
    goGacha: vi.fn(),
    goDaily: vi.fn(),
    stillInLobby: () => inLobby,
  };
  return d;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('first-session reward loop (ONBOARDING_DESIGN §14.2)', () => {
  it('detours only the first clear of the loop level, and only until the gift step ran', () => {
    const sm = fakeSave([], 0);
    const save = sm as unknown as RewardLoopDeps['saveManager'];
    expect(rewardLoopDetour(save, REWARD_LOOP_LEVEL, true)).toBe(true);
    expect(rewardLoopDetour(save, REWARD_LOOP_LEVEL, false)).toBe(false);
    expect(rewardLoopDetour(save, 'ch1_lv1', true)).toBe(false);
    sm.markFeatSeen(FIRST_GACHA_FEAT);
    expect(rewardLoopDetour(save, REWARD_LOOP_LEVEL, true)).toBe(false);
  });

  it('does nothing before the loop level is cleared', async () => {
    const sm = fakeSave(['ch1_lv1'], 0);
    const d = deps(sm);
    runRewardLoop(d);
    await flush();
    expect(d.client.getMail).not.toHaveBeenCalled();
    expect(d.showGuide).not.toHaveBeenCalled();
  });

  it('first arrival claims the welcome mail and walks into the gacha; the next opens the daily; then nothing', async () => {
    const sm = fakeSave(['ch1_lv1', REWARD_LOOP_LEVEL], 0);
    const d = deps(sm);

    runRewardLoop(d);
    await flush();
    expect(d.client.claimMail).toHaveBeenCalledWith('m1');
    expect(sm.save.wallet.coins).toBe(1000);
    expect(d.showGuide).toHaveBeenCalledWith('onboard.gift.title', 'onboard.gift.body', expect.any(Function));
    expect(d.goGacha).toHaveBeenCalledOnce();
    expect(sm.featSeen('shop')).toBe(true);

    runRewardLoop(d);
    expect(d.showGuide).toHaveBeenLastCalledWith('onboard.daily.title', 'onboard.daily.body', expect.any(Function));
    expect(d.goDaily).toHaveBeenCalledOnce();
    expect(sm.featSeen(FIRST_DAILY_FEAT)).toBe(true);
    expect(sm.featSeen('daily')).toBe(true);

    runRewardLoop(d);
    await flush();
    expect(d.showGuide).toHaveBeenCalledTimes(2);
    // ONBOARDING_DESIGN §14.3: each card and each tap-through ticks the anonymous funnel.
    expect(anon).toEqual(['gift_shown', 'gift_gacha', 'daily_shown', 'daily_open']);
  });

  it('skips the gift card when the player already left the lobby, or cannot afford a pull', async () => {
    const left = fakeSave([REWARD_LOOP_LEVEL], 0);
    const dLeft = deps(left, [welcomeMail], false);
    runRewardLoop(dLeft);
    await flush();
    expect(dLeft.client.claimMail).toHaveBeenCalled(); // the coins are still credited
    expect(dLeft.showGuide).not.toHaveBeenCalled();

    const broke = fakeSave([REWARD_LOOP_LEVEL], 0);
    const dBroke = deps(broke, []); // welcome mail already claimed/spent elsewhere
    runRewardLoop(dBroke);
    await flush();
    expect(dBroke.showGuide).not.toHaveBeenCalled();
    expect(broke.featSeen(FIRST_GACHA_FEAT)).toBe(true); // the step is spent either way
  });

  it('a failing mail fetch still falls through to the coin check', async () => {
    const sm = fakeSave([REWARD_LOOP_LEVEL], 500);
    const d = deps(sm);
    (d.client.getMail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    runRewardLoop(d);
    await flush();
    expect(d.goGacha).toHaveBeenCalledOnce();
  });
});

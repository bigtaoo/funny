import { describe, it, expect, vi } from 'vitest';
import { runHeroGift, type HeroGiftDeps } from '../src/app/nav/heroGift';

vi.mock('../src/analytics', () => ({ track: vi.fn() }));

type Gift = { defId: string; claimableAt: number; claimedAt?: number };

function deps(gift: Gift | undefined, now: number, opts: { fail?: boolean; inLobby?: boolean } = {}) {
  const save: { heroGift?: Gift } = gift ? { heroGift: gift } : {};
  const d = {
    saveManager: {
      get: () => save,
      adoptServer: (s: { heroGift?: Gift }) => { save.heroGift = s.heroGift; },
    } as unknown as HeroGiftDeps['saveManager'],
    client: {
      claimHeroGift: vi.fn(async () => {
        if (opts.fail) throw new Error('offline');
        return { save: { heroGift: { ...gift!, claimedAt: now } } };
      }),
    } as unknown as HeroGiftDeps['client'],
    showGuide: vi.fn((_t: string, _b: string, onDismiss: () => void) => onDismiss()),
    goRoster: vi.fn(),
    stillInLobby: () => opts.inLobby ?? true,
    now: () => now,
  };
  return { d, save };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('next-day hero gift (ONBOARDING_DESIGN §17.4)', () => {
  it('does nothing without a gift, before it is due, or once claimed', () => {
    for (const [gift, now] of [
      [undefined, 10],
      [{ defId: 'max', claimableAt: 100 }, 99],
      [{ defId: 'max', claimableAt: 100, claimedAt: 120 }, 200],
    ] as const) {
      const { d } = deps(gift as Gift | undefined, now);
      expect(runHeroGift(d)).toBe(false);
      expect(d.client.claimHeroGift).not.toHaveBeenCalled();
    }
  });

  it('claims once due, adopts the save, shows the guide and opens the roster', async () => {
    const { d, save } = deps({ defId: 'max', claimableAt: 100 }, 100);
    expect(runHeroGift(d)).toBe(true);
    await flush();
    expect(save.heroGift?.claimedAt).toBe(100);
    expect(d.showGuide).toHaveBeenCalledWith('heroGift.claimed.title', 'heroGift.claimed.body', expect.any(Function));
    expect(d.goRoster).toHaveBeenCalledOnce();
  });

  it('a failed claim shows nothing (the next arrival retries)', async () => {
    const { d } = deps({ defId: 'max', claimableAt: 100 }, 150, { fail: true });
    expect(runHeroGift(d)).toBe(true);
    await flush();
    expect(d.showGuide).not.toHaveBeenCalled();
  });

  it('no guide once the player has left the lobby', async () => {
    const { d } = deps({ defId: 'max', claimableAt: 100 }, 150, { inLobby: false });
    runHeroGift(d);
    await flush();
    expect(d.showGuide).not.toHaveBeenCalled();
  });
});

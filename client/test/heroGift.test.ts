import { describe, it, expect, vi } from 'vitest';
import { runHeroGift, pendingHeroGiftAt, type HeroGiftDeps } from '../src/app/nav/heroGift';
import { formatGiftCountdown, tickHeroGiftSticker } from '../src/scenes/LobbyScene/heroGiftSticker';
import type { LobbySceneCore } from '../src/scenes/LobbyScene/core';
import type { SaveData } from '../src/game/meta/SaveData';

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

describe('lobby countdown sticker (ONBOARDING_DESIGN §17.4)', () => {
  it('pending only while earned and unclaimed', () => {
    expect(pendingHeroGiftAt({} as SaveData)).toBeNull();
    expect(pendingHeroGiftAt({ heroGift: { defId: 'max', claimableAt: 5 } } as SaveData)).toBe(5);
    expect(pendingHeroGiftAt({ heroGift: { defId: 'max', claimableAt: 5, claimedAt: 6 } } as SaveData)).toBeNull();
  });

  it('formats h:mm:ss, rounding a partial second up so it never shows 0:00:00 early', () => {
    expect(formatGiftCountdown(23 * 3600_000 + 59 * 60_000 + 59_000)).toBe('23:59:59');
    expect(formatGiftCountdown(61_000)).toBe('0:01:01');
    expect(formatGiftCountdown(1)).toBe('0:00:01');
  });

  it('ticks the label, then hides and fires the claim exactly once at zero', () => {
    let now = 0;
    const onHeroGiftDue = vi.fn();
    const label = { text: '' };
    const layer = { visible: true };
    const core = {
      heroGiftLabel: label, heroGiftLayer: layer, heroGiftAt: 2_000,
      cb: { now: () => now, onHeroGiftDue },
    } as unknown as LobbySceneCore;
    tickHeroGiftSticker(core);
    expect(label.text).toContain('0:00:02');
    now = 1_500;
    tickHeroGiftSticker(core);
    expect(label.text).toContain('0:00:01');
    now = 2_000;
    tickHeroGiftSticker(core);
    tickHeroGiftSticker(core);
    expect(layer.visible).toBe(false);
    expect(onHeroGiftDue).toHaveBeenCalledTimes(1);
  });
});

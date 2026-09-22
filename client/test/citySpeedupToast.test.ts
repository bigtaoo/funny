// The coin-paid speed-ups (CityScene/actions.ts doSpeedup / doSpeedupTraining) both used to confirm
// with the same bare `city.speedupDone` ("Sped up"). The build queue holds several entries and the
// card that was tapped is behind the confirm dialog by then, so that sentence never said which one
// moved — the player had to go back and read the queue to find out what the coins bought. Since
// 2026-09-22 they name their target, matching the shops' "Purchased: <item>" wording.
//
// Driven through the exported free functions with a hand-rolled ActionsHost (they take one
// explicitly — see actions.ts's header), so no PIXI and no scene: plain `npx vitest run`.
import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../src/i18n';
import { doSpeedup, doSpeedupTraining, type ActionsHost } from '../src/scenes/CityScene/actions';
import { BusyTracker } from '../src/ui/busyTracker';
import type { PlayerWorldView, BuildingKey } from '../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function buildHost(queueKey: BuildingKey = 'graphiteMill') {
  const toasts: string[] = [];
  const speedupBuild = vi.fn(async () => ({}) as PlayerWorldView);
  const speedupTraining = vi.fn(async () => ({}) as PlayerWorldView);
  const refreshWallet = vi.fn(async () => {});
  const host: ActionsHost = {
    bt: new BusyTracker(),
    teams: [],
    me: {
      buildQueue: [{ key: queueKey, completeAt: Date.now() + 600_000 }],
    } as unknown as PlayerWorldView,
    setMe() {},
    requestRender() {},
    showToast: (msg: string) => { toasts.push(msg); },
    cb: {
      worldId: 'world:1:0',
      worldApi: { speedupBuild, speedupTraining },
      refreshWallet,
    },
  } as unknown as ActionsHost;
  return { host, toasts, speedupBuild, speedupTraining, refreshWallet };
}

describe('CityScene coin speed-ups name what the coins bought', () => {
  it('a build speed-up names the building from the queue entry it acted on', async () => {
    const { host, toasts, speedupBuild } = buildHost('graphiteMill');

    await doSpeedup(host, 'graphiteMill');

    expect(speedupBuild).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([t('city.speedupDoneNamed', { name: t('city.bld.graphiteMill') })]);
    // Not the old bare wording, and not some other building's name.
    expect(toasts[0]).toContain(t('city.bld.graphiteMill'));
    expect(toasts[0]).not.toBe(t('city.bld.desk'));
  });

  it('the name follows the key, so two different builds do not read alike', async () => {
    const a = buildHost('wall');
    await doSpeedup(a.host, 'wall');
    const b = buildHost('academy');
    await doSpeedup(b.host, 'academy');

    expect(a.toasts[0]).not.toBe(b.toasts[0]);
  });

  it('a training speed-up names the training queue', async () => {
    const { host, toasts, speedupTraining } = buildHost();

    await doSpeedupTraining(host, 40);

    expect(speedupTraining).toHaveBeenCalledWith('world:1:0', 40);
    expect(toasts).toEqual([t('city.speedupDoneNamed', { name: t('city.bld.trainTroops') })]);
  });

  it('a failed speed-up still reads as an error, not as a named success', async () => {
    const { host, toasts } = buildHost();
    (host.cb.worldApi as unknown as { speedupBuild: unknown }).speedupBuild = vi.fn(async () => {
      throw new Error('nope');
    });

    await doSpeedup(host, 'graphiteMill');

    expect(toasts).toEqual([t('city.err.generic')]);
  });
});

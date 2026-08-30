/**
 * sectLoadDecouple.test.ts — SectScene's entry cost (sect-incremental-repaint, 2026-08-25).
 *
 * Tapping the social hub's Sect tab used to pay for everything twice: FriendsScene's own
 * loadSLGStatus had just fetched GET /social/family/mine AND GET /sect/:id (for the tab's sect
 * name), and SectScene then re-issued both behind its own loading screen — after which it still
 * held the page blank until the channel round-trip landed on top. FamilyScene had already been
 * fixed this way (see familyLoadDecouple.test.ts); this pins the same two contracts for sects:
 * use what the opener handed over, and paint the roster before the channel resolves.
 */
import { describe, it, expect, vi } from 'vitest';
import { DataPanel } from '../src/scenes/SectScene/data';
import type { SectSceneCore } from '../src/scenes/SectScene/core';

const FAM = {
  familyId: 'fam_mine',
  name: 'Clan',
  tag: 'CLN',
  sectId: 'sect_1',
  leaderId: 'me',
  members: [{ accountId: 'me', role: 'leader', joinedAt: 0 }],
};

function sectDetail(sectId: string) {
  return {
    sectId, name: 'Sect', tag: 'SCT', leaderId: 'me', leaderFamilyId: 'fam_mine',
    memberFamilyCount: 1, prosperity: 7, allySectIds: [],
    memberFamilies: [{ familyId: 'fam_mine', name: 'Clan', tag: 'CLN', memberCount: 1, territoryCount: 0 }],
  };
}
const SECT = sectDetail('sect_1');

/** Bare-bones stand-in for SectSceneCore — only the fields loadData()/applySect() touch. */
function fakeCore(cb: Record<string, unknown> = {}): SectSceneCore {
  return {
    destroyed: false,
    mode: 'loading',
    inFamily: false,
    myFamilyId: null,
    myFamilyRole: null,
    sect: null,
    messages: [],
    cb: {
      myAccountId: 'me',
      worldId: 'world:1:0',
      worldApi: {
        getMyFamily: vi.fn().mockResolvedValue(FAM),
        getSect: vi.fn().mockImplementation(async (id: string) => sectDetail(id)),
        getSectChannel: vi.fn().mockResolvedValue([]),
      },
      ...cb,
    },
    render: vi.fn(),
  } as unknown as SectSceneCore;
}

const api = (core: SectSceneCore): Record<string, ReturnType<typeof vi.fn>> =>
  core.cb.worldApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('SectScene loadData() — hub hand-off', () => {
  it('uses the handed-over family + sect instead of re-fetching either', async () => {
    const core = fakeCore({ preloadedFamily: FAM, preloadedSect: SECT });
    await new DataPanel(core).loadData();

    expect(api(core).getMyFamily).not.toHaveBeenCalled();
    expect(api(core).getSect).not.toHaveBeenCalled();
    expect(core.mode).toBe('mySect');
    expect(core.sect).toBe(SECT);
    expect(core.myFamilyRole).toBe('leader');
    // The channel is a separate round-trip nobody prefetched — it still has to happen.
    expect(api(core).getSectChannel).toHaveBeenCalledTimes(1);
  });

  it('keeps the full family detail on core.family (not just the derived myFamilyId/myFamilyRole fields) — a preloaded family too', async () => {
    // Regression for the family-sect-tab-switch-flicker fix (30.08.2026): nav/world.ts's
    // Sect->Family hop reads SectSceneCore.family directly to hand it to FamilyScene as
    // preloadedFamily. That only works if loadData() actually keeps the object around, not just
    // the three fields it derives from it (inFamily/myFamilyId/myFamilyRole).
    const core = fakeCore({ preloadedFamily: FAM, preloadedSect: SECT });
    await new DataPanel(core).loadData();
    expect(core.family).toBe(FAM);
  });

  it('ignores a handed-over sect that is not the family\'s current one', async () => {
    // e.g. the player left/joined between the hub's status load and this entry — replaying that
    // payload would paint a roster the player is no longer part of.
    const core = fakeCore({ preloadedFamily: FAM, preloadedSect: sectDetail('sect_other') });
    await new DataPanel(core).loadData();

    expect(api(core).getSect).toHaveBeenCalledWith('sect_1');
    expect(core.sect).toMatchObject({ sectId: 'sect_1' });
  });

  it('still fetches both when nothing was handed over (world-map entry point)', async () => {
    const core = fakeCore();
    await new DataPanel(core).loadData();

    expect(api(core).getMyFamily).toHaveBeenCalledTimes(1);
    expect(api(core).getSect).toHaveBeenCalledTimes(1);
    expect(core.mode).toBe('mySect');
    // Freshly fetched, not just preloaded — core.family must still end up holding it.
    expect(core.family).toEqual(FAM);
  });

  it('sets core.family to null (not left over from a previous load) when the player has no family', async () => {
    const core = fakeCore();
    api(core).getMyFamily.mockResolvedValueOnce(null);
    await new DataPanel(core).loadData();

    expect(core.mode).toBe('noSect');
    expect(core.family).toBeNull();
  });
});

describe('SectScene loadData() — onSectLoaded callback', () => {
  // nav/world.ts's Family->Sect hop caches whatever SectScene last reports through this hook
  // (`lastSect`) so a later hop in the same session can skip getSect() too — see
  // family-sect-tab-switch-flicker-fix-2026-08-30. It has to fire regardless of HOW the sect was
  // learned (fresh fetch vs. handed-over preload), or the cache would just never warm up on the
  // world-map entry point (the only one that doesn't already have a preload to give).
  it('fires with the freshly-fetched sect', async () => {
    const onSectLoaded = vi.fn();
    const core = fakeCore({ onSectLoaded });
    await new DataPanel(core).loadData();

    expect(onSectLoaded).toHaveBeenCalledTimes(1);
    expect(onSectLoaded).toHaveBeenCalledWith(SECT);
  });

  it('fires with the handed-over sect too (preload path)', async () => {
    const onSectLoaded = vi.fn();
    const core = fakeCore({ preloadedFamily: FAM, preloadedSect: SECT, onSectLoaded });
    await new DataPanel(core).loadData();

    expect(onSectLoaded).toHaveBeenCalledTimes(1);
    expect(onSectLoaded).toHaveBeenCalledWith(SECT);
  });

  it('does not fire when the player has no sect', async () => {
    const onSectLoaded = vi.fn();
    const core = fakeCore({ preloadedFamily: { ...FAM, sectId: undefined }, onSectLoaded });
    await new DataPanel(core).loadData();

    expect(core.mode).toBe('noSect');
    expect(onSectLoaded).not.toHaveBeenCalled();
  });
});

describe('SectScene loadData() — first-paint decouple', () => {
  it('paints the roster before the channel round-trip resolves', async () => {
    const core = fakeCore({ preloadedFamily: FAM, preloadedSect: SECT });
    let resolveChannel!: () => void;
    api(core).getSectChannel.mockReturnValueOnce(new Promise((r) => {
      resolveChannel = () => r([{ id: 'm1', senderId: 'me', senderName: 'Tester', body: 'hi', ts: 1 }]);
    }));

    const pending = new DataPanel(core).loadData();
    await Promise.resolve();
    await Promise.resolve();

    // Roster is applied and painted while the channel is still in flight.
    expect(core.mode).toBe('mySect');
    expect(core.render).toHaveBeenCalledTimes(1);
    expect(core.messages).toHaveLength(0);

    resolveChannel();
    await pending;

    // Messages filled in by the trailing render(), not by holding the first one back.
    expect(core.messages).toHaveLength(1);
    expect(core.render).toHaveBeenCalledTimes(2);
  });

  it('paints once and skips the channel when the player has no family', async () => {
    const core = fakeCore();
    api(core).getMyFamily.mockResolvedValueOnce(null);

    await new DataPanel(core).loadData();

    expect(core.mode).toBe('noSect');
    expect(core.inFamily).toBe(false);
    expect(core.render).toHaveBeenCalledTimes(1);
    expect(api(core).getSectChannel).not.toHaveBeenCalled();
  });
});

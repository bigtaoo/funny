/**
 * familyLoadDecouple.test.ts — regression test for the FamilyScene first-paint decouple.
 *
 * 2026-07-15 (latency): switching to the family tab went blank for "several seconds" because the
 * first render() waited on loadData()'s two SEQUENTIAL round-trips (getMyFamily + getFamilyChannel).
 * Fix: applyFamily() now paints the roster/identity the moment the family is known, then loads the
 * channel in the background — so the roster is on screen while the (slower) channel request is still
 * in flight, instead of the whole scene being held blank until both resolve.
 */
import { describe, it, expect, vi } from 'vitest';
import { DataPanel } from '../src/scenes/FamilyScene/data';
import type { FamilySceneCore } from '../src/scenes/FamilyScene/core';

const FAM = {
  familyId: 'fam1',
  name: 'Clan',
  tag: 'CLN',
  members: [{ accountId: 'me', role: 'leader', joinedAt: 0 }],
};

/** Bare-bones stand-in for FamilySceneCore — only the fields loadData()/applyFamily() touch. */
function fakeCore(): FamilySceneCore {
  return {
    destroyed: false,
    mode: 'loading',
    family: null,
    members: [],
    messages: [],
    joinRequests: [],
    isFamilyApprover: false,
    cb: {
      worldApi: {
        getMyFamily: vi.fn().mockResolvedValue(FAM),
        getFamilyChannel: vi.fn().mockResolvedValue([]),
      },
      getFriendPublicIds: vi.fn().mockResolvedValue(new Set()),
    },
    render: vi.fn(),
  } as unknown as FamilySceneCore;
}

describe('FamilyScene loadData() — first-paint decouple', () => {
  it('paints the roster before the channel round-trip resolves', async () => {
    const core = fakeCore();
    const data = new DataPanel(core);

    // Hold the channel fetch pending so we can inspect the state between the roster paint and it.
    let resolveChannel!: () => void;
    (core.cb.worldApi.getFamilyChannel as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => { resolveChannel = () => r([{ id: 'm1', senderId: 'me', senderName: 'Tester', body: 'hi', ts: 1 }]); }),
    );

    const pending = data.loadData();
    // Let the getMyFamily promise + the synchronous body of applyFamily flush.
    await Promise.resolve();
    await Promise.resolve();

    // Roster is already applied and painted while the channel is still loading.
    expect(core.mode).toBe('myFamily');
    expect(core.family).toBe(FAM);
    expect(core.render).toHaveBeenCalledTimes(1);
    expect(core.messages).toHaveLength(0);

    resolveChannel();
    await pending;

    // Channel filled in + a second paint from loadData()'s trailing render().
    expect(core.messages).toHaveLength(1);
    expect(core.render).toHaveBeenCalledTimes(2);
  });

  it('falls back to noFamily (single paint) when the player has no family', async () => {
    const core = fakeCore();
    const data = new DataPanel(core);
    (core.cb.worldApi.getMyFamily as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await data.loadData();

    expect(core.mode).toBe('noFamily');
    expect(core.render).toHaveBeenCalledTimes(1);
    expect(core.cb.worldApi.getFamilyChannel).not.toHaveBeenCalled();
  });
});

/**
 * 2026-08-20 (social-tab-switch-cost): the social hub's family tab jumps here right after its own
 * status load pulled GET /social/family/mine, and loadData() then pulled the identical response
 * again — a second loading screen between tapping the tab and seeing the roster, on top of the
 * scene swap itself. The opener now hands its copy over as `preloadedFamily`.
 */
describe('FamilyScene loadData() — preloadedFamily hand-off', () => {
  it('uses the handed-over family instead of re-fetching it', async () => {
    const core = fakeCore();
    (core.cb as { preloadedFamily?: unknown }).preloadedFamily = FAM;
    const data = new DataPanel(core);

    await data.loadData();

    expect(core.cb.worldApi.getMyFamily).not.toHaveBeenCalled();
    expect(core.mode).toBe('myFamily');
    expect(core.family).toBe(FAM);
    // The channel is a separate round-trip and still has to happen.
    expect(core.cb.worldApi.getFamilyChannel).toHaveBeenCalledTimes(1);
  });

  it('still fetches when no family was handed over (every other entry point)', async () => {
    const core = fakeCore();
    const data = new DataPanel(core);

    await data.loadData();

    expect(core.cb.worldApi.getMyFamily).toHaveBeenCalledTimes(1);
    expect(core.mode).toBe('myFamily');
  });
});

/**
 * 2026-09-28 (ADR-096): for a leader, the join-request list rendered the scene when it landed and
 * loadData() rendered it again immediately after — two full rebuilds in one frame, the biggest part
 * of a 98ms frame on the family screen's first visit. Now both lists arrive together and one render
 * shows them.
 */
describe('FamilyScene loadData() — approver', () => {
  function approverCore(): FamilySceneCore {
    const core = fakeCore();
    (core as { isFamilyApprover: boolean }).isFamilyApprover = true;
    (core.cb.worldApi as unknown as { listJoinRequests: unknown }).listJoinRequests =
      vi.fn().mockResolvedValue([{ requestId: 'r1' }]);
    return core;
  }

  it('paints the roster, then once more when channel and requests are both in', async () => {
    const core = approverCore();
    await new DataPanel(core).loadData();
    expect(core.joinRequests).toHaveLength(1);
    expect(core.render).toHaveBeenCalledTimes(2);
  });

  it('asks for the requests without waiting for the channel', async () => {
    const core = approverCore();
    (core.cb.worldApi.getFamilyChannel as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {}));
    void new DataPanel(core).loadData();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect((core.cb.worldApi as unknown as { listJoinRequests: ReturnType<typeof vi.fn> }).listJoinRequests).toHaveBeenCalledTimes(1);
  });

  it('re-renders after a refetch from the approve action', async () => {
    const core = approverCore();
    (core.cb.worldApi as unknown as { getFamily: unknown }).getFamily = vi.fn().mockResolvedValue(FAM);
    await new DataPanel(core).loadMyFamily('fam1');
    // The roster paint inside applyFamily, then the one that shows the refreshed lists.
    expect(core.render).toHaveBeenCalledTimes(2);
    expect(core.joinRequests).toHaveLength(1);
  });
});

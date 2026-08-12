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

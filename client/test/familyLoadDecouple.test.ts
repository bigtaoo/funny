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
import { DataMixin } from '../src/scenes/FamilyScene/data';
import type { FamilySceneBaseCtor } from '../src/scenes/FamilyScene/base';

const FAM = {
  familyId: 'fam1',
  name: 'Clan',
  tag: 'CLN',
  members: [{ accountId: 'me', role: 'leader', joinedAt: 0 }],
};

class FakeBase {
  destroyed = false;
  mode = 'loading';
  family: unknown = null;
  members: unknown[] = [];
  messages: unknown[] = [];
  cb = {
    worldApi: {
      getMyFamily: vi.fn().mockResolvedValue(FAM),
      getFamilyChannel: vi.fn().mockResolvedValue([]),
    },
  };
  render = vi.fn();
}

interface TestScene {
  mode: string;
  family: unknown;
  messages: unknown[];
  cb: FakeBase['cb'];
  render: FakeBase['render'];
  loadData(): Promise<void>;
}

const FamilyWithData = DataMixin(FakeBase as unknown as FamilySceneBaseCtor);

describe('FamilyScene loadData() — first-paint decouple', () => {
  it('paints the roster before the channel round-trip resolves', async () => {
    const scene = new FamilyWithData() as unknown as TestScene;

    // Hold the channel fetch pending so we can inspect the state between the roster paint and it.
    let resolveChannel!: () => void;
    scene.cb.worldApi.getFamilyChannel.mockReturnValueOnce(
      new Promise((r) => { resolveChannel = () => r([{ id: 'm1', senderId: 'me', senderName: 'Tester', body: 'hi', ts: 1 }]); }),
    );

    const pending = scene.loadData();
    // Let the getMyFamily promise + the synchronous body of applyFamily flush.
    await Promise.resolve();
    await Promise.resolve();

    // Roster is already applied and painted while the channel is still loading.
    expect(scene.mode).toBe('myFamily');
    expect(scene.family).toBe(FAM);
    expect(scene.render).toHaveBeenCalledTimes(1);
    expect(scene.messages).toHaveLength(0);

    resolveChannel();
    await pending;

    // Channel filled in + a second paint from loadData()'s trailing render().
    expect(scene.messages).toHaveLength(1);
    expect(scene.render).toHaveBeenCalledTimes(2);
  });

  it('falls back to noFamily (single paint) when the player has no family', async () => {
    const scene = new FamilyWithData() as unknown as TestScene;
    scene.cb.worldApi.getMyFamily.mockResolvedValueOnce(null);

    await scene.loadData();

    expect(scene.mode).toBe('noFamily');
    expect(scene.render).toHaveBeenCalledTimes(1);
    expect(scene.cb.worldApi.getFamilyChannel).not.toHaveBeenCalled();
  });
});

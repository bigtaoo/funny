// PresenceBroadcaster unit tests (SOC9/P3, previously 70.2% — the P3 socialsvc-delegation path and several
// fallback-path branches (myPid empty / friend socket not open / cache reuse / invalidateFriends) had never
// been exercised; gateway-routing.test.ts only drives connect/disconnect through a real Gateway with a
// FakeMeta stub, which happens to always return a non-empty publicId and never checks caching). Pure logic
// over injected deps — no real WS/HTTP needed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PresenceBroadcaster } from '../src/gateway/presenceBroadcaster';
import type { ConnLookup, Push } from '../src/gateway/types';
import type { MetaClient } from '../src/metaClient';
import type { SocialsvcClient } from '../src/socialsvcClient';

interface FakeConn { ws: { readyState: number; OPEN: number } }

function fakeConns(open: Record<string, boolean>): ConnLookup {
  const OPEN = 1;
  const map = new Map<string, FakeConn>(Object.entries(open).map(([id, isOpen]) => [id, { ws: { readyState: isOpen ? OPEN : 0, OPEN } }]));
  return {
    get: (id) => map.get(id) as never,
    has: (id) => map.has(id),
    values: () => map.values() as never,
  };
}

function fakeMeta(opts: { available?: boolean; friends?: Record<string, string[]>; profiles?: Record<string, string> }): MetaClient {
  const getFriends = vi.fn(async (accountId: string) => opts.friends?.[accountId] ?? []);
  const getProfile = vi.fn(async (accountId: string) => ({ publicId: opts.profiles?.[accountId] ?? '' }));
  return { available: opts.available ?? true, getFriends, getProfile } as unknown as MetaClient;
}

describe('PresenceBroadcaster', () => {
  let push: Push & ReturnType<typeof vi.fn>;
  beforeEach(() => {
    push = vi.fn() as Push & ReturnType<typeof vi.fn>;
  });

  describe('P3 path: socialsvc configured and available', () => {
    it('notifyOnline delegates to socialsvc.notifyOnline; meta is never touched', async () => {
      const meta = fakeMeta({});
      const socialsvc = { available: true, notifyOnline: vi.fn(), notifyOffline: vi.fn() } as unknown as SocialsvcClient;
      const pb = new PresenceBroadcaster({ conns: fakeConns({}), push, meta, socialsvc });
      await pb.notifyOnline('acc-a');
      expect(socialsvc.notifyOnline).toHaveBeenCalledWith('acc-a');
      expect(meta.getFriends).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });
    it('notifyOffline delegates to socialsvc.notifyOffline', async () => {
      const meta = fakeMeta({});
      const socialsvc = { available: true, notifyOnline: vi.fn(), notifyOffline: vi.fn() } as unknown as SocialsvcClient;
      const pb = new PresenceBroadcaster({ conns: fakeConns({}), push, meta, socialsvc });
      await pb.notifyOffline('acc-a');
      expect(socialsvc.notifyOffline).toHaveBeenCalledWith('acc-a');
    });
  });

  describe('fallback path: socialsvc absent or unavailable', () => {
    it('socialsvc configured but unavailable still falls back to the meta path (available check, not just presence)', async () => {
      const meta = fakeMeta({ friends: { 'acc-a': [] }, profiles: { 'acc-a': '100000001' } });
      const socialsvc = { available: false, notifyOnline: vi.fn(), notifyOffline: vi.fn() } as unknown as SocialsvcClient;
      const pb = new PresenceBroadcaster({ conns: fakeConns({}), push, meta, socialsvc });
      await pb.notifyOnline('acc-a');
      expect(socialsvc.notifyOnline).not.toHaveBeenCalled();
      expect(meta.getFriends).toHaveBeenCalledWith('acc-a');
    });

    it('meta unavailable -> no-op entirely (no friends/profile lookup, no push)', async () => {
      const meta = fakeMeta({ available: false });
      const pb = new PresenceBroadcaster({ conns: fakeConns({}), push, meta });
      await pb.notifyOnline('acc-a');
      expect(meta.getFriends).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it('my own publicId empty (meta.getProfile has nothing) -> no broadcast at all', async () => {
      const meta = fakeMeta({ friends: { 'acc-a': ['acc-b'] }, profiles: {} });
      const pb = new PresenceBroadcaster({ conns: fakeConns({ 'acc-b': true }), push, meta });
      await pb.notifyOnline('acc-a');
      expect(push).not.toHaveBeenCalled();
    });

    it('online friend with an open socket receives friend_presence, and I get a reflected snapshot back (connect path)', async () => {
      const meta = fakeMeta({
        friends: { 'acc-a': ['acc-b'] },
        profiles: { 'acc-a': '100000001', 'acc-b': '100000002' },
      });
      const pb = new PresenceBroadcaster({ conns: fakeConns({ 'acc-b': true }), push, meta });
      await pb.notifyOnline('acc-a');
      expect(push).toHaveBeenCalledWith('acc-b', { kind: 'friend_presence', publicId: '100000001', online: true });
      expect(push).toHaveBeenCalledWith('acc-a', { kind: 'friend_presence', publicId: '100000002', online: true });
      expect(push).toHaveBeenCalledTimes(2);
    });

    it('disconnect path notifies friends but does NOT reflect a snapshot back to me', async () => {
      const meta = fakeMeta({
        friends: { 'acc-a': ['acc-b'] },
        profiles: { 'acc-a': '100000001', 'acc-b': '100000002' },
      });
      const pb = new PresenceBroadcaster({ conns: fakeConns({ 'acc-b': true }), push, meta });
      await pb.notifyOffline('acc-a');
      expect(push).toHaveBeenCalledWith('acc-b', { kind: 'friend_presence', publicId: '100000001', online: false });
      expect(push).toHaveBeenCalledTimes(1);
    });

    it('a friend with no connection, or a stale non-OPEN socket, is skipped entirely', async () => {
      const meta = fakeMeta({
        friends: { 'acc-a': ['acc-offline', 'acc-stale'] },
        profiles: { 'acc-a': '100000001' },
      });
      const pb = new PresenceBroadcaster({ conns: fakeConns({ 'acc-stale': false }), push, meta });
      await pb.notifyOnline('acc-a');
      expect(push).not.toHaveBeenCalled();
    });

    it('friendsOf/publicIdOf results are cached — repeat calls do not re-query meta', async () => {
      const meta = fakeMeta({ friends: { 'acc-a': ['acc-b'] }, profiles: { 'acc-a': '100000001', 'acc-b': '100000002' } });
      const pb = new PresenceBroadcaster({ conns: fakeConns({ 'acc-b': true }), push, meta });
      await pb.notifyOnline('acc-a');
      await pb.notifyOnline('acc-a');
      expect(meta.getFriends).toHaveBeenCalledTimes(1);
      // getProfile is called for both 'acc-a' (myPid) and 'acc-b' (reflect-back) on the first call only.
      expect(meta.getProfile).toHaveBeenCalledTimes(2);
    });

    it('notifyOffline evicts both caches afterward — a subsequent notifyOnline re-queries meta from scratch', async () => {
      const meta = fakeMeta({ friends: { 'acc-a': ['acc-b'] }, profiles: { 'acc-a': '100000001', 'acc-b': '100000002' } });
      const pb = new PresenceBroadcaster({ conns: fakeConns({ 'acc-b': true }), push, meta });
      await pb.notifyOnline('acc-a');
      await pb.notifyOffline('acc-a');
      expect(meta.getFriends).toHaveBeenCalledTimes(1);
      await pb.notifyOnline('acc-a');
      expect(meta.getFriends).toHaveBeenCalledTimes(2);
    });

    it('invalidateFriends clears only the friends cache — a later broadcast re-fetches the friend list', async () => {
      const meta = fakeMeta({ friends: { 'acc-a': ['acc-b'] }, profiles: { 'acc-a': '100000001', 'acc-b': '100000002' } });
      const pb = new PresenceBroadcaster({ conns: fakeConns({ 'acc-b': true }), push, meta });
      await pb.notifyOnline('acc-a');
      pb.invalidateFriends('acc-a');
      await pb.notifyOnline('acc-a');
      expect(meta.getFriends).toHaveBeenCalledTimes(2);
    });
  });
});

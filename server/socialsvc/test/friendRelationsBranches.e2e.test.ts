// FriendRelationsService branch-coverage gap-fill (2026-09-03 pass): src/friend/relations.ts was
// 100% line / 82.79% branch — the single clearest case in this package of the shape the admin pass
// described: every line runs, because friend.e2e.test.ts calls every method, but always with two
// accounts that both have a profile, a gateway that is up, edges with no alias, and no CAS ever lost.
// The 16 branches left over are the other side of each of those:
//
//   * the optional halves of a FriendView (rank / alias / avatarId) and the `?? false` presence
//     default. A friend list is the most-viewed screen in the social stack, and each of these decides
//     whether a field is absent or present-as-undefined in the response.
//   * accounts that no longer resolve: a friend edge, or a pending request, pointing at a profile meta
//     cannot return. Skipping the row is the intended behavior — rendering it would put a blank
//     entry with no name in a list the player can act on.
//   * the degraded gateway (`available: false`): the friend list must still come back, everyone shown
//     offline, rather than failing the request because presence is unreachable.
//   * `respondFriend` losing its status CAS, and `ensureFriendCounter` hitting an insert error that is
//     NOT a duplicate key. The first must not create a friendship off a request another call already
//     resolved; the second must propagate, because swallowing it would report a real database fault as
//     a successfully-seeded counter and then enforce FRIEND_CAP against a wrong number.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FRIEND_CAP, friendEdgeId, blockId } from '@nw/shared';
import type { SocialMongo } from '../src/db';
import { FriendRelationsService } from '../src/friend/relations';
import { nullSocialGatewayClient } from '../src/gatewayClient';
import { tryConnect, FakeMeta, FakeGateway } from './harness';
import { withCollection } from './stubCols';

const mongo = await tryConnect('nw_social_friendrel_branches_test');
if (!mongo) console.warn('[socialsvc.friendRelationsBranches.e2e] Mongo unreachable — skipping.');

describe.skipIf(!mongo)('socialsvc FriendRelationsService branch gaps', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let svc: FriendRelationsService;

  beforeEach(async () => {
    await Promise.all([
      m.collections.friendEdges.deleteMany({}),
      m.collections.friendRequests.deleteMany({}),
      m.collections.friendCounts.deleteMany({}),
      m.collections.blockList.deleteMany({}),
    ]);
    nowMs = 1_000_000;
    meta = new FakeMeta().add('a', 'P-A', 'Alice').add('b', 'P-B', 'Bob', 'gold').add('c', 'P-C', 'Cara');
    gateway = new FakeGateway();
    svc = new FriendRelationsService({ cols: m.collections, gateway, meta, now });
  });

  afterAll(async () => { await m.close(); });

  /** A one-directional edge, written directly (accept flow is friend.e2e's subject). */
  async function edge(owner: string, friend: string, alias?: string): Promise<void> {
    await m.collections.friendEdges.insertOne({
      _id: friendEdgeId(owner, friend), owner, friend, since: nowMs, ...(alias ? { alias } : {}),
    });
  }

  // ── getFriends: the optional halves of a FriendView ──────────────────────────

  it('getFriends: rank / alias / avatarId are each included only when present', async () => {
    meta.avatar('b', 'av-7');
    await edge('a', 'b', 'Bobby');   // b: rank 'gold' + avatar + a local alias
    await edge('a', 'c');            // c: none of the three
    gateway.presenceMap = { b: true };

    const out = await svc.getFriends('a');
    const b = out.find((f) => f.publicId === 'P-B')!;
    const c = out.find((f) => f.publicId === 'P-C')!;
    expect(b).toMatchObject({ rank: 'gold', alias: 'Bobby', avatarId: 'av-7', online: true });
    // c is not in presenceMap at all — that absence must read as offline, not undefined.
    expect(c).toMatchObject({ publicId: 'P-C', online: false });
    expect(c).not.toHaveProperty('rank');
    expect(c).not.toHaveProperty('alias');
    expect(c).not.toHaveProperty('avatarId');
  });

  it('getFriends: an edge pointing at a deleted account is skipped, not rendered nameless', async () => {
    await edge('a', 'deleted');
    await edge('a', 'b');
    const out = await svc.getFriends('a');
    expect(out.map((f) => f.publicId)).toEqual(['P-B']);
  });

  it('getFriends: a gateway that is down still returns the list, everyone offline', async () => {
    await edge('a', 'b');
    const degraded = new FriendRelationsService({ cols: m.collections, gateway: nullSocialGatewayClient, meta, now });
    const out = await degraded.getFriends('a');
    expect(out).toHaveLength(1);
    expect(out[0]!.online).toBe(false);
  });

  it('getFriends: no edges -> [] without a profile round trip', async () => {
    expect(await svc.getFriends('a')).toEqual([]);
  });

  // ── batchPublicIds / listRequests ────────────────────────────────────────────

  it('batchPublicIds: an empty input short-circuits (no meta call), otherwise maps id -> publicId', async () => {
    expect(await svc.batchPublicIds([])).toEqual(new Map());
    expect(await svc.batchPublicIds(['a', 'deleted'])).toEqual(new Map([['a', 'P-A']]));
  });

  it('listRequests: a request whose counterpart has no profile is dropped from the list', async () => {
    await m.collections.friendRequests.insertMany([
      { _id: 'r-ok', from: 'b', to: 'a', status: 'pending', message: 'hi', createdAt: nowMs },
      // The applicant's account is gone: the row cannot be rendered (no name, no publicId to respond
      // to), so it must not appear at all rather than appear un-actionable.
      { _id: 'r-ghost', from: 'deleted', to: 'a', status: 'pending', createdAt: nowMs },
    ]);
    const { incoming, outgoing } = await svc.listRequests('a');
    expect(outgoing).toEqual([]);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ requestId: 'r-ok', fromPublicId: 'P-B', toPublicId: 'P-A', message: 'hi' });
  });

  it('listRequests: a request with no message omits the field entirely', async () => {
    await m.collections.friendRequests.insertOne({ _id: 'r1', from: 'a', to: 'b', status: 'pending', createdAt: nowMs });
    const { outgoing } = await svc.listRequests('a');
    expect(outgoing[0]).not.toHaveProperty('message');
  });

  // ── requestFriend ────────────────────────────────────────────────────────────

  it('requestFriend: a requester whose own profile is unresolvable is BAD_REQUEST, and writes nothing', async () => {
    // The push carries the requester's publicId + displayName; with no profile there is nothing for
    // the recipient's "X wants to be your friend" prompt to say, so the request is not created.
    expect(await svc.requestFriend('ghost', 'P-B', undefined)).toEqual({ kind: 'error', error: 'BAD_REQUEST' });
    expect(await m.collections.friendRequests.countDocuments({})).toBe(0);
    expect(gateway.pushes).toHaveLength(0);
  });

  it('requestFriend: a missing friend-counter row reads as 0 rather than blocking the request', async () => {
    // ensureFriendCounter's insert can lose its race and the row still be absent on the read that
    // follows; `?? 0` is what keeps that from being read as "at the cap".
    const cols = withCollection(m.collections, 'friendCounts', { findOne: async () => null });
    const stubbed = new FriendRelationsService({ cols, gateway, meta, now });
    expect((await stubbed.requestFriend('a', 'P-B', undefined)).kind).toBe('ok');
  });

  it('requestFriend: an insert error that is NOT a duplicate key propagates instead of being swallowed', async () => {
    // Only E11000 (a concurrent bootstrap won) is benign. Anything else — a write concern failure, a
    // disk error — must surface: swallowing it would leave FRIEND_CAP enforced against a number that
    // was never seeded.
    const cols = withCollection(m.collections, 'friendCounts', {
      insertOne: async () => { throw Object.assign(new Error('write refused'), { code: 121 }); },
    });
    const broken = new FriendRelationsService({ cols, gateway, meta, now });
    await expect(broken.requestFriend('a', 'P-B', undefined)).rejects.toThrow('write refused');
  });

  it('requestFriend: a duplicate counter-bootstrap (E11000) is benign and the request goes through', async () => {
    const cols = withCollection(m.collections, 'friendCounts', {
      insertOne: async () => { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); },
    });
    const raced = new FriendRelationsService({ cols, gateway, meta, now });
    expect((await raced.requestFriend('a', 'P-B', undefined)).kind).toBe('ok');
  });

  it('requestFriend: at FRIEND_CAP the pre-check rejects before any request row is written', async () => {
    await m.collections.friendCounts.insertOne({ _id: 'a', count: FRIEND_CAP });
    expect(await svc.requestFriend('a', 'P-B', undefined)).toEqual({ kind: 'error', error: 'FRIEND_CAP_REACHED' });
    expect(await m.collections.friendRequests.countDocuments({})).toBe(0);
  });

  // ── respondFriend: losing the status CAS ─────────────────────────────────────

  it('respondFriend: losing the status CAS is NOT_FOUND, and no friendship is created', async () => {
    await m.collections.friendRequests.insertOne({ _id: 'r1', from: 'b', to: 'a', status: 'pending', createdAt: nowMs });
    // Another accept/reject for this same request got to the findOneAndUpdate first: the guarded
    // update matches nothing. Proceeding anyway would create the edges twice (or after a reject).
    const cols = withCollection(m.collections, 'friendRequests', { findOneAndUpdate: async () => null });
    const raced = new FriendRelationsService({ cols, gateway, meta, now });
    expect(await raced.respondFriend('a', 'r1', true)).toEqual({ kind: 'error', error: 'NOT_FOUND' });
    expect(await m.collections.friendEdges.countDocuments({})).toBe(0);
    expect(await m.collections.friendCounts.countDocuments({ count: { $gt: 0 } })).toBe(0);
  });

  // ── removeFriend / blockUser / unblockUser: unresolvable publicIds ───────────

  it('removeFriend: an unknown publicId is a no-op false (no counter decrement)', async () => {
    await m.collections.friendCounts.insertOne({ _id: 'a', count: 1 });
    expect(await svc.removeFriend('a', 'P-NOBODY')).toBe(false);
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(1);
    expect(gateway.invalidated).toEqual([]);
  });

  it('removeFriend: a redundant removal does not decrement the counter a second time', async () => {
    await edge('a', 'b');
    await edge('b', 'a');
    await m.collections.friendCounts.insertMany([{ _id: 'a', count: 1 }, { _id: 'b', count: 1 }]);
    expect(await svc.removeFriend('a', 'P-B')).toBe(true);
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(0);
    // Second call: the edges are already gone, so nothing may be released.
    expect(await svc.removeFriend('a', 'P-B')).toBe(true);
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(0);
  });

  it('blockUser: unknown publicId and self are both refused', async () => {
    expect(await svc.blockUser('a', 'P-NOBODY')).toBe(false);
    expect(await svc.blockUser('a', 'P-A')).toBe(false);
    expect(await m.collections.blockList.countDocuments({})).toBe(0);
  });

  it('unblockUser: an unknown publicId is false; a real one removes the row', async () => {
    await m.collections.blockList.insertOne({ _id: blockId('a', 'b'), owner: 'a', target: 'b', ts: nowMs });
    expect(await svc.unblockUser('a', 'P-NOBODY')).toBe(false);
    expect(await m.collections.blockList.countDocuments({})).toBe(1);
    expect(await svc.unblockUser('a', 'P-B')).toBe(true);
    expect(await m.collections.blockList.countDocuments({})).toBe(0);
  });

  it('reportUser: unknown publicId and self-report are both refused', async () => {
    expect(await svc.reportUser('a', 'P-NOBODY', 'spam')).toBe(false);
    expect(await svc.reportUser('a', 'P-A', 'spam')).toBe(false);
  });
});

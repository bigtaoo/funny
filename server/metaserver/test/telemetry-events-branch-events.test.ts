// Branch-coverage backfill for src/events.ts (group D, 2026-09-03).
//
// The happy paths are already covered (events-accrue.e2e / events-claim.e2e both import from '../src/'),
// so what was left is the *shape* half of the module: an event with no description, a reward with no
// id/count/maxClaims, an account that has never participated — plus every refusal path in
// claimEventReward, where the branch taken decides which error the player is shown after their points
// were already spent (or, for a misconfigured reward, whether they are shown a success for a reward
// that was never dispatched at all).
//
// FakeCollection is enough for everything here except the maxClaims `$expr` guard (which needs real
// Mongo — see events-claim.e2e.test.ts for that); the lost-CAS-race reporting below is made
// deterministic by wrapping one collection method, the technique used in economy-service-unit.test.ts.
import { describe, it, expect, vi } from 'vitest';
import type { Collections, EventDoc, EventParticipantDoc, EventInput } from '@nw/shared';
import {
  getEventsForAccount,
  accrueEventTask,
  adminCreateEvent,
  adminUpdateEvent,
  claimEventReward,
  participantId,
} from '../src/events.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

const NOW = 1_500_000;
const ACC = 'acc-grpD';

function makeCols(seedEvents: EventDoc[] = [], seedParts: EventParticipantDoc[] = []) {
  const events = new FakeCollection<EventDoc>().seed(...seedEvents);
  const eventParticipants = new FakeCollection<EventParticipantDoc>().seed(...seedParts);
  return { cols: { events, eventParticipants } as unknown as Collections, events, eventParticipants };
}

function activeEvent(over: Partial<EventDoc> = {}): EventDoc {
  return {
    _id: 'ev1',
    title: 'Summer Festival',
    windowStart: 1_000_000,
    windowEnd: 2_000_000,
    tasks: [],
    rewards: [],
    createdAt: 0,
    ...over,
  };
}

// ── getEventsForAccount / buildView: the "never participated" + "minimal definition" shapes ───────
describe('getEventsForAccount view assembly', () => {
  it('an account that never participated sees zeroed progress rather than a missing event', async () => {
    // No participant document exists until the first task trigger, so this is what EVERY player sees
    // the moment an event opens — the event must still render with points 0 / progress 0 / claimed 0.
    const { cols } = makeCols([
      activeEvent({
        tasks: [{ taskId: 't1', kind: 'pvp.win', target: 3, points: 10 }],
        rewards: [{ rewardId: 'r1', cost: 10, kind: 'material' }],
      }),
    ]);
    const [view] = await getEventsForAccount(cols, ACC, NOW);
    expect(view).toMatchObject({ eventId: 'ev1', myPoints: 0 });
    expect(view!.tasks[0]).toEqual({ taskId: 't1', kind: 'pvp.win', target: 3, points: 10, progress: 0, done: false });
    expect(view!.rewards[0]).toEqual({ rewardId: 'r1', cost: 10, kind: 'material', claimedCount: 0 });
    // description/id/count/maxClaims are omitted, not sent as null — the client branches on presence.
    expect('description' in view!).toBe(false);
  });

  it('a participant document written by an older build (no taskProgress/claimedRewards/points) still renders', async () => {
    // These three fields are `?? []`/`?? 0`-defaulted precisely because a partially-written participant
    // doc must not blank out the whole event panel for that player.
    const { cols } = makeCols(
      [
        activeEvent({
          description: 'Log in daily',
          tasks: [{ taskId: 't1', kind: 'pvp.win', target: 2, points: 5 }],
          rewards: [{ rewardId: 'r1', cost: 5, kind: 'coins', count: 100, maxClaims: 2 }],
        }),
      ],
      [{ _id: participantId('ev1', ACC), eventId: 'ev1', accountId: ACC, updatedAt: 0 } as unknown as EventParticipantDoc],
    );
    const [view] = await getEventsForAccount(cols, ACC, NOW);
    expect(view!.description).toBe('Log in daily');
    expect(view!.myPoints).toBe(0);
    expect(view!.tasks[0]!.progress).toBe(0);
    expect(view!.rewards[0]).toEqual({ rewardId: 'r1', cost: 5, kind: 'coins', count: 100, maxClaims: 2, claimedCount: 0 });
  });

  it('a task with no progress entry yet reads as 0 while its sibling keeps its own progress', async () => {
    const { cols } = makeCols(
      [
        activeEvent({
          tasks: [
            { taskId: 'started', kind: 'pvp.win', target: 2, points: 5 },
            { taskId: 'untouched', kind: 'ad.watch', target: 4, points: 5 },
          ],
          rewards: [{ rewardId: 'r1', cost: 5, kind: 'material', id: 'mat_iron', count: 3 }],
        }),
      ],
      [{
        _id: participantId('ev1', ACC), eventId: 'ev1', accountId: ACC, points: 5,
        taskProgress: [{ taskId: 'started', progress: 2, pointsGranted: true }],
        claimedRewards: [], updatedAt: 0,
      }],
    );
    const [view] = await getEventsForAccount(cols, ACC, NOW);
    expect(view!.tasks.map((t) => [t.taskId, t.progress, t.done])).toEqual([
      ['started', 2, true],
      ['untouched', 0, false],
    ]);
    // A fully-specified reward carries id and count through to the client (the shop cell renders both).
    expect(view!.rewards[0]).toEqual({ rewardId: 'r1', cost: 5, kind: 'material', id: 'mat_iron', count: 3, claimedCount: 0 });
  });

  it('no active events → empty list without touching the participants collection', async () => {
    const { cols, eventParticipants } = makeCols([activeEvent({ windowStart: 5_000_000, windowEnd: 6_000_000 })]);
    const spy = vi.spyOn(eventParticipants, 'find');
    expect(await getEventsForAccount(cols, ACC, NOW)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── accrueEventTask: the "this trigger is not for this event" short-circuit ────────────────────────
describe('accrueEventTask task-kind matching', () => {
  it('an active event with no task of the triggered kind is skipped entirely (no participant doc created)', async () => {
    // Every pve.clear / pvp.win / ad.watch hit walks EVERY active event; creating a participant row for
    // an event the player cannot progress would put an untouchable event in their panel forever.
    const { cols, eventParticipants } = makeCols([
      activeEvent({ tasks: [{ taskId: 't1', kind: 'pve.clear', target: 1, points: 5 }] }),
    ]);
    await accrueEventTask(cols, ACC, 'pvp.win', NOW);
    expect(eventParticipants.docs.size).toBe(0);
  });

  it('a post-increment document that no longer carries the task entry still grants the points', async () => {
    // Defensive `?? task.target` fallback: if the returned document does not contain the entry we just
    // incremented (a mid-flight schema/write anomaly), treating progress as "complete" errs towards
    // paying the player rather than silently swallowing the increment they earned.
    const { cols, eventParticipants } = makeCols([
      activeEvent({ tasks: [{ taskId: 't1', kind: 'pvp.win', target: 3, points: 40 }] }),
    ]);
    const pid = participantId('ev1', ACC);
    eventParticipants.findOneAndUpdate = async () => ({
      _id: pid, eventId: 'ev1', accountId: ACC, points: 0,
      taskProgress: [{ taskId: 'some-other-task', progress: 1, pointsGranted: false }],
      claimedRewards: [], updatedAt: NOW,
    }) as unknown as EventParticipantDoc;
    const updates: Record<string, unknown>[] = [];
    const realUpdateOne = eventParticipants.updateOne.bind(eventParticipants);
    eventParticipants.updateOne = async (filter, update, opts) => {
      updates.push(filter);
      return realUpdateOne(filter, update, opts);
    };

    await accrueEventTask(cols, ACC, 'pvp.win', NOW);
    // The points-grant write (the one guarded on pointsGranted) was issued, not skipped.
    expect(updates.some((f) => JSON.stringify(f).includes('pointsGranted'))).toBe(true);
  });
});

// ── admin CRUD: the optional description on create/update ──────────────────────────────────────────
describe('admin event CRUD optional description', () => {
  const input = (over: Partial<EventInput> = {}): EventInput => ({
    title: '  Spaced Title  ',
    windowStart: 1000,
    windowEnd: 2000,
    tasks: [{ taskId: 't1', kind: 'pvp.win', target: 3, points: 10 }],
    rewards: [{ rewardId: 'r1', cost: 10, kind: 'coins', count: 100 }],
    ...over,
  });

  it('create with a description stores it (and trims the title)', async () => {
    const { cols, events } = makeCols();
    const res = await adminCreateEvent(cols, input({ id: 'ev-desc', description: 'Win 3 ranked matches' }), 500);
    expect(res.ok).toBe(true);
    const stored = await events.findOne({ _id: 'ev-desc' });
    expect(stored).toMatchObject({ title: 'Spaced Title', description: 'Win 3 ranked matches', createdAt: 500 });
  });

  it('create without a description omits the field entirely', async () => {
    const { cols, events } = makeCols();
    await adminCreateEvent(cols, input({ id: 'ev-nodesc' }), 500);
    expect('description' in (await events.findOne({ _id: 'ev-nodesc' }))!).toBe(false);
  });

  it('update replaces the definition and can add a description while preserving createdAt', async () => {
    const { cols, events } = makeCols([activeEvent({ _id: 'ev-upd', createdAt: 42 })]);
    const res = await adminUpdateEvent(cols, 'ev-upd', input({ description: 'now with a blurb' }));
    expect(res.ok).toBe(true);
    expect(await events.findOne({ _id: 'ev-upd' })).toMatchObject({ description: 'now with a blurb', createdAt: 42 });
  });

  it('update can also drop a description (full replacement, not a merge)', async () => {
    const { cols, events } = makeCols([activeEvent({ _id: 'ev-drop', description: 'old blurb', createdAt: 42 })]);
    await adminUpdateEvent(cols, 'ev-drop', input());
    expect('description' in (await events.findOne({ _id: 'ev-drop' }))!).toBe(false);
  });
});

// ── claimEventReward: refusals, lost races, and mis-dispatch ───────────────────────────────────────
describe('claimEventReward refusal and dispatch paths', () => {
  function setup(rewards: EventDoc['rewards'], seedParts: EventParticipantDoc[] = []) {
    const { cols, eventParticipants } = makeCols([activeEvent({ rewards })], seedParts);
    return { cols, eventParticipants, commercial: fakeCommercial(), socialsvc: new FakeSocialsvc() };
  }

  function participant(points: number, claimedRewards: string[] = []): EventParticipantDoc {
    return {
      _id: participantId('ev1', ACC), eventId: 'ev1', accountId: ACC, points,
      taskProgress: [], claimedRewards, updatedAt: 0,
    };
  }

  it('the participant document vanishing between upsert and read → NOT_FOUND, no points spent', async () => {
    // Only reachable when the row is deleted concurrently (an account wipe mid-claim); the point is that
    // it reports NOT_FOUND instead of throwing a 500 at a player who is mid-tap.
    const s = setup([{ rewardId: 'r1', cost: 10, kind: 'coins', count: 100 }], [participant(50)]);
    s.eventParticipants.findOne = async () => null;
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'r1', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(s.commercial.grantCalls).toHaveLength(0);
  });

  it('losing the atomic points race with no claim cap → INSUFFICIENT_POINTS (the points went to the other claim)', async () => {
    // The pre-checks passed, so the only thing that can have failed the write is the points guard —
    // reporting the cap instead would tell the player to stop trying when they should top up.
    const s = setup([{ rewardId: 'r1', cost: 10, kind: 'coins', count: 100 }], [participant(50)]);
    s.eventParticipants.findOneAndUpdate = async () => null; // deterministic lost CAS
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'r1', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: false, error: 'INSUFFICIENT_POINTS' });
    expect(s.commercial.grantCalls).toHaveLength(0);
  });

  it('losing the race to a concurrent claim that filled the cap → CLAIM_LIMIT_REACHED, not INSUFFICIENT_POINTS', async () => {
    // The two refusals are indistinguishable at write time; the post-race re-read is what tells them
    // apart, and the player must be told "you already claimed this", not "you are short on points".
    const s = setup([{ rewardId: 'capped', cost: 10, kind: 'coins', count: 100, maxClaims: 1 }], [participant(50)]);
    let reads = 0;
    const real = s.eventParticipants.findOne.bind(s.eventParticipants);
    s.eventParticipants.findOne = async (q: Record<string, unknown>) => {
      reads++;
      const doc = await real(q);
      // First read = the pre-check (cap not yet reached). Second read = the post-race re-read, by which
      // point the racing claim has landed and consumed the single allowed claim.
      return reads === 1 || !doc ? doc : { ...doc, claimedRewards: ['capped'] };
    };
    s.eventParticipants.findOneAndUpdate = async () => null;
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'capped', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: false, error: 'CLAIM_LIMIT_REACHED' });
  });

  it('losing the race and then finding the participant row gone → INSUFFICIENT_POINTS, still not a crash', async () => {
    // `cur?.claimedRewards ?? []`: the re-read can come back empty if the account was wiped between the
    // failed write and the diagnosis read. A capped reward must degrade to the generic refusal instead
    // of dereferencing null.
    const s = setup([{ rewardId: 'capped', cost: 10, kind: 'coins', count: 100, maxClaims: 1 }], [participant(50)]);
    let reads = 0;
    const real = s.eventParticipants.findOne.bind(s.eventParticipants);
    s.eventParticipants.findOne = async (q: Record<string, unknown>) => (++reads === 1 ? real(q) : null);
    s.eventParticipants.findOneAndUpdate = async () => null;
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'capped', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: false, error: 'INSUFFICIENT_POINTS' });
  });

  it('a coins reward with commercial up grants through commercial under a deterministic idempotency key', async () => {
    // orderId must be the dispatchKey, not a fresh UUID: a client retry that re-lands the same claim
    // has to be de-duplicated by commercial rather than paying twice.
    const s = setup([{ rewardId: 'r1', cost: 10, kind: 'coins', count: 100 }], [participant(50)]);
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'r1', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: true, pointsLeft: 40, reward: { kind: 'coins', count: 100 } });
    expect(s.commercial.grantCalls).toEqual([
      { accountId: ACC, amount: 100, reason: 'event_reward', orderId: `event.claim:${participantId('ev1', ACC)}:r1:0` },
    ]);
    expect(s.socialsvc.mail.size).toBe(0); // coins never go out as a mail attachment
  });

  it('a coins reward configured with no count is refused BEFORE the points are deducted', async () => {
    // A misconfigured reward (`kind:'coins'` with count 0/absent) satisfies neither dispatch branch, so
    // until 2026-09-03 the player was charged and handed nothing while the call still answered ok.
    // validateEventInput rejects this shape at create/update time, so a doc in this state was written
    // around the admin CRUD — which is exactly why claimEventReward now carries its own backstop.
    const s = setup([{ rewardId: 'zero', cost: 10, kind: 'coins' }], [participant(50)]);
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'zero', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: false, error: 'REWARD_MISCONFIGURED' });
    expect(s.commercial.grantCalls).toHaveLength(0);
    expect(s.socialsvc.mail.size).toBe(0);
    // The point of refusing early: the points are still there to spend on a reward that works.
    expect((await s.cols.eventParticipants.findOne({ _id: participantId('ev1', ACC) }))?.points).toBe(50);
  });

  it('an explicit count of 0 is refused the same way as an absent one', async () => {
    const s = setup([{ rewardId: 'zeroed', cost: 10, kind: 'coins', count: 0 }], [participant(50)]);
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'zeroed', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: false, error: 'REWARD_MISCONFIGURED' });
    expect(s.commercial.grantCalls).toHaveLength(0);
  });

  it('a coins reward with commercial unavailable also dispatches nothing (points already spent)', async () => {
    // Degraded-dependency side: with commercial down the grant is skipped entirely rather than queued,
    // so the ops compensation path is the only recovery — worth having pinned by a test.
    const s = setup([{ rewardId: 'r1', cost: 10, kind: 'coins', count: 100 }], [participant(50)]);
    const down = fakeCommercial(false);
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'r1', NOW, down, s.socialsvc);
    expect(res).toMatchObject({ ok: true, pointsLeft: 40 });
    expect(down.grantCalls).toHaveLength(0);
  });

  it('a material reward with neither id nor count mails a bare attachment and a "× 1" body', async () => {
    // `reward.id ?? reward.kind` / `reward.count ?? 1` are what the player actually reads in the mail;
    // without them the subject line would say "undefined × undefined".
    const s = setup([{ rewardId: 'bare', cost: 10, kind: 'material' }], [participant(50)]);
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'bare', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: true, pointsLeft: 40, reward: { kind: 'material' } });
    const mail = [...s.socialsvc.mail.values()][0]!;
    expect(mail.subject).toBe('Event Reward: Summer Festival');
    expect(mail.body).toBe('Congratulations! You received material × 1');
    expect(mail.attachments).toEqual([{ kind: 'material' }]);
  });

  it('a skin reward with an id and count carries both into the attachment and the response', async () => {
    const s = setup([{ rewardId: 'skinned', cost: 10, kind: 'skin', id: 'skin_gold', count: 2 }], [participant(50)]);
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'skinned', NOW, s.commercial, s.socialsvc);
    expect(res).toEqual({ ok: true, pointsLeft: 40, reward: { kind: 'skin', id: 'skin_gold', count: 2 } });
    expect([...s.socialsvc.mail.values()][0]!.attachments).toEqual([{ kind: 'skin', id: 'skin_gold', count: 2 }]);
  });

  it('a failing mail write is swallowed — the claim still reports success (points are already gone)', async () => {
    // Rolling back here would need a compensating write that could itself fail; the module deliberately
    // chooses "ops compensation" over a half-rolled-back claim, and that choice is worth pinning.
    const s = setup([{ rewardId: 'bare', cost: 10, kind: 'material' }], [participant(50)]);
    s.socialsvc.insertSystemMail = async () => { throw new Error('socialsvc down'); };
    const res = await claimEventReward(s.cols, ACC, 'ev1', 'bare', NOW, s.commercial, s.socialsvc);
    expect(res).toMatchObject({ ok: true, pointsLeft: 40 });
  });
});

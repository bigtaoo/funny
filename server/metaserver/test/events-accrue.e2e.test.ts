// accrueEventTask concurrency e2e (B6): real Mongo (events/eventParticipants).
// Regression test for a bug where accrueEventTask did a plain findOne-then-updateOne (no version guard):
// concurrent triggers for the same task (e.g. two fast pve/pvp/ad callbacks racing) could each read the
// same pre-increment progress and both write newProgress = current+1, silently losing an increment; and
// if that increment reached the task's target, both could independently see pointsGranted=false and both
// $inc the reward points, double-granting. Fixed 2026-08-03 via conditional atomic ops whose filters
// re-check the value they're about to change (push-if-absent, then increment-if-below-target, then
// grant-if-not-already-granted), so a losing racer's write simply doesn't match.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type MongoHandle, type EventDoc } from '@nw/shared';
import { accrueEventTask } from '../src/events.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_events_accrue_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[events-accrue.e2e] Mongo unreachable (${URI}) — skipping.`);

const NOW = 1_500_000;

function seedEvent(overrides: Partial<EventDoc> = {}): EventDoc {
  return {
    _id: 'ev1',
    title: 'Accrue Concurrency Test Event',
    windowStart: 1_000_000,
    windowEnd: 2_000_000,
    tasks: [
      { taskId: 'clear5', kind: 'pve.clear', target: 5, points: 100 },
    ],
    rewards: [],
    createdAt: 0,
    ...overrides,
  };
}

describe.skipIf(!mongo)('accrueEventTask concurrency', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('N concurrent triggers exactly reaching target: progress lands exactly at target, points granted exactly once', async () => {
    await m.collections.events.insertOne(seedEvent());

    const calls = Array.from({ length: 5 }, () => accrueEventTask(m.collections, 'racer', 'pve.clear', NOW));
    await Promise.all(calls);

    const doc = await m.collections.eventParticipants.findOne({ _id: 'ev1:racer' });
    const task = doc?.taskProgress.find((t) => t.taskId === 'clear5');
    expect(task?.progress).toBe(5); // no lost increments
    expect(task?.pointsGranted).toBe(true);
    expect(doc?.points).toBe(100); // granted exactly once, not 5x
  });

  it('more concurrent triggers than the target: progress never overshoots, points still granted exactly once', async () => {
    await m.collections.events.insertOne(seedEvent());

    const calls = Array.from({ length: 20 }, () => accrueEventTask(m.collections, 'racer2', 'pve.clear', NOW));
    await Promise.all(calls);

    const doc = await m.collections.eventParticipants.findOne({ _id: 'ev1:racer2' });
    const task = doc?.taskProgress.find((t) => t.taskId === 'clear5');
    expect(task?.progress).toBe(5); // capped at target, never counts past it
    expect(task?.pointsGranted).toBe(true);
    expect(doc?.points).toBe(100); // still granted exactly once despite 20 concurrent triggers
  });

  it('sequential triggers past the target stop accumulating and do not re-grant points', async () => {
    await m.collections.events.insertOne(seedEvent());

    for (let i = 0; i < 8; i++) {
      await accrueEventTask(m.collections, 'seq', 'pve.clear', NOW);
    }

    const doc = await m.collections.eventParticipants.findOne({ _id: 'ev1:seq' });
    const task = doc?.taskProgress.find((t) => t.taskId === 'clear5');
    expect(task?.progress).toBe(5);
    expect(doc?.points).toBe(100);
  });
});

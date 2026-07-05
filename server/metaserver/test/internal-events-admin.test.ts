// Route-level tests for internal/eventAdminRoutes.ts (split out of internal.ts): /admin/events CRUD (B6, ADR-014).
// Uses Fastify inject + in-memory fake cols (no Mongo) — same style as internal.test.ts.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { Collections, EventDoc, EventInput } from '@nw/shared';
import { registerEventAdminRoutes } from '../src/internal/eventAdminRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, ThrowingSocialsvc } from './helpers/fakeClients.js';

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function validInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    title: 'Summer Festival',
    windowStart: 1000,
    windowEnd: 2000,
    tasks: [{ taskId: 't1', kind: 'pvp.win', target: 3, points: 10 }],
    rewards: [{ rewardId: 'r1', cost: 10, kind: 'coins', count: 100 }],
    ...overrides,
  };
}

function build(seedEvents: EventDoc[] = []) {
  const events = new FakeCollection<EventDoc>().seed(...seedEvents);
  const cols = { events } as unknown as Collections;
  const ctx: InternalCtx = {
    cols,
    now: () => 500,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    socialsvc: new ThrowingSocialsvc(),
    authed: (key) => key === KEY,
  };
  const app = Fastify();
  registerEventAdminRoutes(app, ctx);
  return { app, events };
}

describe('GET /admin/events', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/admin/events' });
    expect(res.statusCode).toBe(401);
  });

  it('lists all events sorted by windowStart desc (including not-yet-started/ended)', async () => {
    const { app } = build([
      { _id: 'e1', title: 'Old', windowStart: 100, windowEnd: 200, tasks: [], rewards: [], createdAt: 0 },
      { _id: 'e2', title: 'New', windowStart: 900, windowEnd: 1900, tasks: [], rewards: [], createdAt: 0 },
    ]);
    const res = await app.inject({ method: 'GET', url: '/admin/events', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const { events } = JSON.parse(res.payload);
    expect(events.map((e: EventDoc) => e._id)).toEqual(['e2', 'e1']);
  });
});

describe('POST /admin/events', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/events', payload: validInput() });
    expect(res.statusCode).toBe(401);
  });

  it('invalid input (end before start) → 400 VALIDATION', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/events', headers: authHeaders,
      payload: validInput({ windowStart: 2000, windowEnd: 1000 }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('VALIDATION');
  });

  it('creates an event, generating an id when none given', async () => {
    const { app, events } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/events', headers: authHeaders, payload: validInput() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.event.title).toBe('Summer Festival');
    expect(events.docs.has(body.event._id)).toBe(true);
  });

  it('duplicate explicit id → 409 DUPLICATE_ID', async () => {
    const { app } = build([{ _id: 'ev1', title: 'Existing', windowStart: 0, windowEnd: 1, tasks: [], rewards: [], createdAt: 0 }]);
    const res = await app.inject({
      method: 'POST', url: '/admin/events', headers: authHeaders,
      payload: validInput({ id: 'ev1' }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toBe('DUPLICATE_ID');
  });
});

describe('PATCH /admin/events/:id', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'PATCH', url: '/admin/events/ev1', payload: validInput() });
    expect(res.statusCode).toBe(401);
  });

  it('not found → 404', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'PATCH', url: '/admin/events/ghost', headers: authHeaders, payload: validInput() });
    expect(res.statusCode).toBe(404);
  });

  it('invalid input → 400 VALIDATION (existing event untouched)', async () => {
    const { app, events } = build([{ _id: 'ev1', title: 'Old', windowStart: 0, windowEnd: 1, tasks: [], rewards: [], createdAt: 0 }]);
    const res = await app.inject({
      method: 'PATCH', url: '/admin/events/ev1', headers: authHeaders,
      payload: validInput({ title: '' }),
    });
    expect(res.statusCode).toBe(400);
    expect(events.docs.get('ev1')!.title).toBe('Old');
  });

  it('full replacement: preserves _id/createdAt, replaces the rest', async () => {
    const { app, events } = build([{ _id: 'ev1', title: 'Old', windowStart: 0, windowEnd: 1, tasks: [], rewards: [], createdAt: 42 }]);
    const res = await app.inject({
      method: 'PATCH', url: '/admin/events/ev1', headers: authHeaders,
      payload: validInput({ title: 'Renamed' }),
    });
    expect(res.statusCode).toBe(200);
    const doc = events.docs.get('ev1')!;
    expect(doc.title).toBe('Renamed');
    expect(doc.createdAt).toBe(42); // preserved, not overwritten by `now()`
  });
});

describe('DELETE /admin/events/:id', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'DELETE', url: '/admin/events/ev1' });
    expect(res.statusCode).toBe(401);
  });

  it('not found → 404', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'DELETE', url: '/admin/events/ghost', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('deletes the event definition (participation history untouched — not this route\'s concern)', async () => {
    const { app, events } = build([{ _id: 'ev1', title: 'Old', windowStart: 0, windowEnd: 1, tasks: [], rewards: [], createdAt: 0 }]);
    const res = await app.inject({ method: 'DELETE', url: '/admin/events/ev1', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(events.docs.has('ev1')).toBe(false);
  });
});

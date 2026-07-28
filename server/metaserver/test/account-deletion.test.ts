// C5-b account soft-delete + cancellation (P0-13, comm-audit-2026-07-27 finding B14): DELETE /account
// used to mint a confirmToken and throw it away (never persisted, no way to ever use it) despite the
// contract claiming a two-step confirm + 7-day grace period. POST /account/cancel-deletion is the real
// mechanism now — these tests cover both endpoints end-to-end, no Mongo (FakeCollection + fastify inject,
// same style as titles.test.ts).
import { describe, it, expect } from 'vitest';
import { makeNewSave, signToken, type Collections, type SaveData } from '@nw/shared';
import { buildApp } from '../src/app.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import type { FastifyInstance } from 'fastify';

const jwt = { secret: 'test-secret' };
const ACC = 'acc-1';
const auth = { authorization: `Bearer ${signToken(ACC, jwt)}` };

interface AccountDoc {
  _id: string;
  deletedAt?: number;
  deletionConfirmToken?: string;
}
interface SaveDocRow { _id: string; save: SaveData; rev: number }

let clock = 1_700_000_000_000;

function build(seedAccount?: AccountDoc): { app: Promise<FastifyInstance>; accounts: FakeCollection<AccountDoc> } {
  const accounts = new FakeCollection<AccountDoc>();
  if (seedAccount) accounts.seed(seedAccount);
  const save = makeNewSave(ACC, clock);
  const saves = new FakeCollection<SaveDocRow>().seed({ _id: ACC, save, rev: save.rev });
  const cols = { accounts, saves } as unknown as Collections;
  const app = buildApp({ cols, jwt, internalKey: 'k', commercialUrl: null, gatewayUrl: null, authRateLimit: 0, now: () => clock });
  return { app, accounts };
}

describe('DELETE /account (C5-b)', () => {
  it('mints and persists a confirmToken alongside deletedAt (not just returned and discarded)', async () => {
    // The account doc always exists by the time deleteAccount() can be called (created at login);
    // updateOne here intentionally has no upsert:true, matching that real invariant.
    const { app, accounts } = build({ _id: ACC });
    const a = await app;
    const res = await a.inject({ method: 'DELETE', url: '/account', headers: auth });
    expect(res.statusCode).toBe(200);
    const { confirmToken } = res.json().data;
    expect(typeof confirmToken).toBe('string');
    expect(confirmToken.length).toBeGreaterThan(10);

    const doc = await accounts.findOne({ _id: ACC });
    expect(doc?.deletedAt).toBe(clock);
    expect(doc?.deletionConfirmToken).toBe(confirmToken); // the real bug: this used to be undefined
    await a.close();
  });
});

describe('POST /account/cancel-deletion (P0-13)', () => {
  it('correct token within the grace period → clears deletedAt, account restored', async () => {
    const { app, accounts } = build({ _id: ACC, deletedAt: clock, deletionConfirmToken: 'tok-abc' });
    const a = await app;
    const res = await a.inject({
      method: 'POST', url: '/account/cancel-deletion', headers: auth,
      payload: { confirmToken: 'tok-abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);

    const doc = await accounts.findOne({ _id: ACC });
    expect(doc?.deletedAt).toBeUndefined();
    expect(doc?.deletionConfirmToken).toBeUndefined();
    await a.close();
  });

  it('wrong token → 400 DELETION_TOKEN_INVALID, deletion stays in effect', async () => {
    const { app, accounts } = build({ _id: ACC, deletedAt: clock, deletionConfirmToken: 'tok-abc' });
    const a = await app;
    const res = await a.inject({
      method: 'POST', url: '/account/cancel-deletion', headers: auth,
      payload: { confirmToken: 'wrong-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DELETION_TOKEN_INVALID');

    const doc = await accounts.findOne({ _id: ACC });
    expect(doc?.deletedAt).toBe(clock); // still deleted — not cleared
    await a.close();
  });

  it('grace period elapsed (>7 days) → 400 DELETION_TOKEN_INVALID even with the right token', async () => {
    const deletedAt = clock;
    const { app } = build({ _id: ACC, deletedAt, deletionConfirmToken: 'tok-abc' });
    const a = await app;
    clock = deletedAt + 8 * 24 * 60 * 60 * 1000; // 8 days later
    const res = await a.inject({
      method: 'POST', url: '/account/cancel-deletion', headers: auth,
      payload: { confirmToken: 'tok-abc' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DELETION_TOKEN_INVALID');
    await a.close();
    clock = deletedAt; // reset for subsequent tests
  });

  it('no pending deletion → 400 ACCOUNT_NOT_DELETED', async () => {
    const { app } = build({ _id: ACC });
    const a = await app;
    const res = await a.inject({
      method: 'POST', url: '/account/cancel-deletion', headers: auth,
      payload: { confirmToken: 'anything' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_DELETED');
    await a.close();
  });

  it('end-to-end: DELETE /account then cancel with the real returned token succeeds', async () => {
    const { app, accounts } = build({ _id: ACC });
    const a = await app;
    const delRes = await a.inject({ method: 'DELETE', url: '/account', headers: auth });
    const { confirmToken } = delRes.json().data;

    const cancelRes = await a.inject({
      method: 'POST', url: '/account/cancel-deletion', headers: auth,
      payload: { confirmToken },
    });
    expect(cancelRes.statusCode).toBe(200);
    const doc = await accounts.findOne({ _id: ACC });
    expect(doc?.deletedAt).toBeUndefined();
    await a.close();
  });
});

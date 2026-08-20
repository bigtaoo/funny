// PromoService's degrade behavior (B-PROMO). The route e2e in httpRoutes.e2e.test.ts drives these
// methods through real HTTP, but its `promo` fake is always `available: true`, so the two
// `!this.core.promo.available` branches — the ones that decide what ops sees when `NW_META_BASE_URL`
// is unset — had never executed (2026-08-20: service/promo.ts sat at 100% lines / 66% branches, the
// two uncovered branches being exactly these). Meta pins the equivalent "commercial unavailable →
// 503" case for its own sibling routes (metaserver/test/internal-promo-gacha.test.ts); admin did not.
//
// No Mongo: the unavailable paths return/throw before touching a collection, and `AdminCore.audit`
// needs only `cols.auditLog.insertOne` + `now()`, so a stub core is enough — same `as` cast
// precedent as core-identity.test.ts.
import { describe, expect, it } from 'vitest';
import { PromoService } from '../src/service/promo';
import { AdminError } from '../src/service/errors';
import type { Actor, AdminServiceDeps } from '../src/service/base';
import { AdminService } from '../src/service';
import type { PromoClient, PromoCodeView } from '../src/clients';

const ACTOR: Actor = { adminId: 'adm-1', username: 'root', displayName: 'Root', role: 'super' };

const ROW: PromoCodeView = { code: 'WELCOME', coins: 100, redeemed: 0, createdBy: 'adm-1', createdAt: 1 };

interface Harness {
  svc: PromoService;
  audits: Array<{ actor: string; action: string; target?: string; summary?: string }>;
  calls: { list: number; create: Array<Record<string, unknown>> };
}

/**
 * Build a PromoService over a stub AdminCore. Going through the real `AdminService` constructor (not
 * a hand-rolled core) keeps the audit path under test genuine — `audit()` is AdminCore's own method,
 * so a fake would be testing the fake.
 */
function harness(available: boolean, createResult: { code: string } = { code: 'WELCOME' }): Harness {
  const audits: Harness['audits'] = [];
  const calls: Harness['calls'] = { list: 0, create: [] };
  const promo: PromoClient = {
    available,
    list: async () => {
      calls.list++;
      return [ROW];
    },
    create: async (args) => {
      calls.create.push(args);
      return createResult;
    },
  };
  const deps = {
    promo,
    now: () => 12345,
    cols: {
      auditLog: {
        insertOne: async (doc: { actor: string; action: string; target?: string; summary?: string }) => {
          audits.push(doc);
          return { acknowledged: true };
        },
      },
    },
  } as unknown as AdminServiceDeps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = (new AdminService(deps) as any).promo as PromoService;
  return { svc, audits, calls };
}

describe('PromoService with commercial unreachable (metaBaseUrl unset → PromoClient.available false)', () => {
  // Read degrades quietly so the rest of the ops console still renders; the page shows an empty
  // table rather than an error card.
  it('listPromoCodes returns an empty list instead of throwing, and never calls the client', async () => {
    const h = harness(false);
    expect(await h.svc.listPromoCodes()).toEqual([]);
    expect(h.calls.list).toBe(0);
  });

  // Write fails loudly, and with its own code — not the client's generic 502 — so the operator is
  // told the deployment is misconfigured rather than that the request failed.
  it('createPromoCode throws AdminError 503 promo_unavailable', async () => {
    const h = harness(false);
    await expect(h.svc.createPromoCode(ACTOR, { code: 'X', coins: 10 })).rejects.toMatchObject({
      status: 503,
      code: 'promo_unavailable',
    });
    await expect(h.svc.createPromoCode(ACTOR, { code: 'X', coins: 10 })).rejects.toBeInstanceOf(AdminError);
  });

  // The 503 must precede both side effects. An audit row for a code that was never minted would be
  // worse than the failure itself — `promo.create` is the only record that a code exists at all.
  it('a rejected create writes no audit row and never reaches the client', async () => {
    const h = harness(false);
    await expect(h.svc.createPromoCode(ACTOR, { code: 'X', coins: 10 })).rejects.toThrow();
    expect(h.audits).toEqual([]);
    expect(h.calls.create).toEqual([]);
  });
});

describe('PromoService with commercial reachable', () => {
  it('listPromoCodes passes the client rows through untouched', async () => {
    const h = harness(true);
    expect(await h.svc.listPromoCodes()).toEqual([ROW]);
    expect(h.calls.list).toBe(1);
  });

  it('createPromoCode forwards the args and stamps createdBy with the actor id, not the username', async () => {
    const h = harness(true);
    await h.svc.createPromoCode(ACTOR, { code: 'WELCOME', coins: 250, totalLimit: 5, note: 'launch' });
    expect(h.calls.create).toEqual([
      { code: 'WELCOME', coins: 250, totalLimit: 5, note: 'launch', createdBy: 'adm-1' },
    ]);
  });

  it('audits promo.create with the coin amount in the summary', async () => {
    const h = harness(true);
    await h.svc.createPromoCode(ACTOR, { code: 'WELCOME', coins: 250 });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ actor: 'adm-1', action: 'promo.create', target: 'WELCOME', summary: '250 coins' });
  });

  // commercial normalizes the code before storing it, so the audit target has to be the code that
  // came BACK from the client, not the string the operator typed — otherwise the audit trail names a
  // code that does not exist in the store, and searching the log for the real code finds nothing.
  it('audits the normalized code returned by the client, not the raw input', async () => {
    const h = harness(true, { code: 'WELCOME2026' });
    await h.svc.createPromoCode(ACTOR, { code: '  welcome2026 ', coins: 10 });
    expect(h.audits[0]).toMatchObject({ target: 'WELCOME2026' });
  });
});

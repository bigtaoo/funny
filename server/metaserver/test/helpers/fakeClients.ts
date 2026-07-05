// Shared fake GatewayClient / CommercialClient / MetaSocialsvcClient for internal/* route tests.
// Mirrors the fakes already duplicated ad-hoc in internal.test.ts / season-close.test.ts / pve-anticheat.test.ts.
import type { GatewayClient, JudgeRes } from '../../src/gatewayClient.js';
import type { CommercialClient } from '../../src/commercialClient.js';
import type { MetaSocialsvcClient, SystemMailContent } from '../../src/socialsvcClient.js';

export function fakeGateway(opts: { available?: boolean; res?: JudgeRes } = {}): GatewayClient {
  const pushed: { accountId: string; payload: unknown }[] = [];
  return {
    available: opts.available ?? false,
    judge: async () => opts.res ?? { ok: false },
    push: async (accountId: string, payload: unknown) => { pushed.push({ accountId, payload }); },
    presence: async () => ({}),
    invalidateFriends: async () => {},
    pushed,
  } as unknown as GatewayClient & { pushed: { accountId: string; payload: unknown }[] };
}

interface GrantCall { accountId: string; amount: number; reason: string; orderId: string }

/** Fake commercial client: records grant/victoryCredit calls; promo/gacha admin methods are in-memory stores. */
export function fakeCommercial(available = true): CommercialClient & {
  grantCalls: GrantCall[];
  promoCodes: Map<string, unknown>;
  pools: Map<string, unknown>;
} {
  const grantCalls: GrantCall[] = [];
  const promoCodes = new Map<string, unknown>();
  const pools = new Map<string, unknown>();
  return {
    available,
    grantCalls,
    promoCodes,
    pools,
    async grant(a: GrantCall) {
      grantCalls.push(a);
      return { ok: true as const, coinsAfter: 0, credited: a.amount };
    },
    async victoryCredit(a: { accountId: string; amount: number; dayKey: string }) {
      return { ok: true as const, coinsAfter: 0, credited: a.amount, capped: false };
    },
    async createPromoCode(a: Record<string, unknown>) {
      const code = a.code as string;
      if (promoCodes.has(code)) return { ok: false as const, error: 'DUPLICATE' };
      promoCodes.set(code, { ...a, redeemedCount: 0 });
      return { ok: true as const, code };
    },
    async listPromoCodes() {
      return [...promoCodes.values()] as never[];
    },
    async createLimitedPool(a: { config: Record<string, unknown>; createdBy: string }) {
      pools.set(a.config.id as string, { ...a.config, kind: 'limited', createdBy: a.createdBy });
      return { ok: true as const, id: a.config.id as string };
    },
    async createCustomPool(a: { config: Record<string, unknown>; createdBy: string }) {
      pools.set(a.config.id as string, { ...a.config, kind: 'custom', createdBy: a.createdBy });
      return { ok: true as const, id: a.config.id as string };
    },
    async closeLimitedPool(a: { id: string }) {
      const p = pools.get(a.id);
      if (!p) return { ok: false as const, error: 'NOT_FOUND' };
      pools.set(a.id, { ...(p as Record<string, unknown>), closed: true });
      return { ok: true as const, id: a.id };
    },
    async listLimitedPools() {
      return [...pools.values()] as never[];
    },
  } as unknown as CommercialClient & { grantCalls: GrantCall[]; promoCodes: Map<string, unknown>; pools: Map<string, unknown> };
}

/** Fake socialsvc: mail is the sole write authority (P2) — mirrors socialsvc's idempotent-upsert semantics with a plain Map. */
export class FakeSocialsvc implements MetaSocialsvcClient {
  available = true;
  mail = new Map<string, { _id: string; to: string; subject: string; body: string; attachments?: unknown[] }>();
  async proxy(): Promise<never> { throw new Error('not used in this test'); }
  async claimMail(): Promise<never> { throw new Error('not used in this test'); }
  async insertSystemMail(dispatchKey: string, to: string, content: SystemMailContent) {
    const mailId = `${dispatchKey}:${to}`;
    const hasAttachment = !!content.attachments?.length;
    if (this.mail.has(mailId)) return { mailId, inserted: false, hasAttachment };
    this.mail.set(mailId, { _id: mailId, to, subject: content.subject, body: content.body, attachments: content.attachments });
    return { mailId, inserted: true, hasAttachment };
  }
  async bulkInsertSystemMail(dispatchKey: string, accountIds: string[], content: SystemMailContent) {
    const hasAttachment = !!content.attachments?.length;
    const insertedAccountIds: string[] = [];
    for (const to of accountIds) {
      const mailId = `${dispatchKey}:${to}`;
      if (this.mail.has(mailId)) continue;
      this.mail.set(mailId, { _id: mailId, to, subject: content.subject, body: content.body, attachments: content.attachments });
      insertedAccountIds.push(to);
    }
    return { insertedAccountIds, hasAttachment };
  }
}

/** Throws on every call — for socialsvc-not-configured (nullMetaSocialsvcClient) scenarios in tests. */
export class ThrowingSocialsvc implements MetaSocialsvcClient {
  available = false;
  async proxy(): Promise<never> { throw new Error('socialsvc not configured'); }
  async claimMail(): Promise<never> { throw new Error('socialsvc not configured'); }
  async insertSystemMail(): Promise<never> { throw new Error('socialsvc not configured'); }
  async bulkInsertSystemMail(): Promise<never> { throw new Error('socialsvc not configured'); }
}

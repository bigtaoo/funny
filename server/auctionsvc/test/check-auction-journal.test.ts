// Mutation test for the settlement-journal drift gate (server/scripts/checkAuctionJournal.mjs).
//
// A gate that cannot fail is worse than no gate, because it reads as coverage — the 2026-08-24
// `checkAbsoluteWrites` round shipped a first version whose per-field check was accidentally satisfied by
// the `rev` bump every write carries, so it waved through the exact mutation it existed to catch. So this
// suite does not test the gate against the real tree (`npm run check:auctionjournal` already does that, in
// CI). It builds a throwaway `server/` tree, proves the gate passes on it, then reintroduces each banned
// shape one at a time and asserts the gate fails AND names the right rule.
//
// It also pins the "rule went dead" half: if a capability moves out of the file that owns it and nobody
// updates `allowed`, the rule silently enforces nothing from then on, which is the quiet way a gate rots.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const GATE = resolve(import.meta.dirname, '../../scripts/checkAuctionJournal.mjs');

/** A minimal but structurally faithful auctionsvc/src: one file per capability owner, each holding the real call shape. */
const CLEAN_TREE: Record<string, string> = {
  'auctionService/journalPlans.ts': [
    'export function flowKey(kind: string, auctionId: string): string {',
    '  return `auction_${kind}:${auctionId}`;',
    '}',
    'export function refundKey(a: string, b: string): string {',
    '  return `auction_bid_refund:${a}:${b}`;',
    '}',
  ].join('\n'),
  'auctionService/journalSteps.ts': [
    'export class Runner {',
    '  async exec(step: any, deps: any) {',
    '    await deps.commercial.spend(step.accountId, step.amount, step.key);',
    '    await deps.meta.escrowEquipment(step.accountId, step.id, step.key);',
    '    await deps.meta.grantCard(step.accountId, step.inst, step.key);',
    '    await deps.meta.deductMaterial(step.accountId, step.mat, 1, step.key);',
    '    await this.delivery.deliverItem(step.accountId, step.snapshot, step.key, step.reason);',
    '    await this.delivery.deliverCoins(step.accountId, step.amount, step.key, step.reason);',
    '  }',
    '  private delivery: any;',
    '}',
  ].join('\n'),
  'auctionService/delivery.ts': [
    'export class Delivery {',
    '  async deliverItem(to: string, snapshot: any, key: string, reason: string) {',
    '    await this.deps.mail.sendSystemMail(to, key, { subject: reason });',
    '  }',
    '  async deliverCoins(to: string, amount: number, key: string, reason: string) {',
    '    await this.deps.mail.sendSystemMail(to, key, { subject: reason });',
    '  }',
    '  private deps: any;',
    '}',
  ].join('\n'),
  'auctionService/trade.ts': [
    "import { flowKey } from './journalPlans';",
    'export class Trade {',
    '  async buy(buyerId: string, auctionId: string) {',
    "    const rowId = flowKey('buy', auctionId) + ':' + buyerId;",
    '    return rowId;',
    '  }',
    '}',
  ].join('\n'),
  'commercialClient.ts': [
    'export interface Client { spend(a: string, n: number, o: string): Promise<void>; }',
    'export const nullClient: Client = { async spend() {} };',
  ].join('\n'),
  'mailClient.ts': [
    'export interface MailClient { sendSystemMail(a: string, k: string, c: unknown): Promise<void>; }',
    'export const nullMail: MailClient = { async sendSystemMail() {} };',
  ].join('\n'),
  'metaClient.ts': [
    'export interface MetaClient {',
    '  escrowEquipment(a: string, i: string, o: string): Promise<unknown>;',
    '  grantCard(a: string, i: unknown, o: string): Promise<void>;',
    '  deductMaterial(a: string, m: string, q: number, o: string): Promise<void>;',
    '}',
  ].join('\n'),
};

let root: string;

/** Write a whole `<root>/auctionsvc/src` tree from a path→content map. */
function materialize(tree: Record<string, string>): void {
  rmSync(join(root, 'auctionsvc'), { recursive: true, force: true });
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, 'auctionsvc', 'src', rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, `${content}\n`, 'utf8');
  }
}

/** Run the gate against the fixture tree. Returns its exit code plus the combined output. */
function runGate(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [GATE, `--root=${root}`], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Clean tree plus one extra/edited file — the mutation. */
function withMutation(rel: string, content: string): Record<string, string> {
  return { ...CLEAN_TREE, [rel]: content };
}

describe('checkAuctionJournal gate (mutation-tested against fixtures)', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nw-auction-gate-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes on a tree where every capability sits in the file that owns it', () => {
    materialize(CLEAN_TREE);
    const { code, out } = runGate();
    expect(out).toContain('5 capability rules all live');
    expect(code).toBe(0);
  });

  it('ignores the forbidden shapes when they only appear in comments', () => {
    // Every rule below is documented in prose that has to quote what it forbids — this file, the gate
    // itself, and journal.ts all do. A gate that trips on its own documentation gets deleted.
    materialize(
      withMutation(
        'auctionService/trade.ts',
        [
          '// Historical note: this used to call commercial.spend(buyerId, total, `auction_buy:${id}`)',
          '// inline and mail.sendSystemMail(...) straight after, plus meta.escrowEquipment(...).',
          '/* deliverCoins(seller, net, key, "proceeds") was here too. */',
          'export class Trade {}',
        ].join('\n'),
      ),
    );
    const { code } = runGate();
    expect(code).toBe(0);
  });

  it.each([
    {
      rule: 'spend',
      code: ['export class Trade {', '  async buy(d: any) { await d.commercial.spend("a", 1, "k"); }', '}'].join('\n'),
    },
    {
      rule: 'mail',
      code: ['export class Trade {', '  async buy(d: any) { await d.mail.sendSystemMail("a", "k", {}); }', '}'].join('\n'),
    },
    {
      rule: 'inventory',
      code: ['export class Trade {', '  async buy(d: any) { await d.meta.grantEquipment("a", {}, "k"); }', '}'].join('\n'),
    },
    {
      rule: 'deliver',
      code: ['export class Trade {', '  async buy(x: any) { await x.deliverItem("a", {}, "k", "sold"); }', '}'].join('\n'),
    },
    {
      rule: 'key',
      code: ['export class Trade {', '  key(id: string) { return `auction_buy:${id}`; }', '}'].join('\n'),
    },
  ])('fails when trade.ts reintroduces the $rule shape', ({ rule, code }) => {
    materialize(withMutation('auctionService/trade.ts', code));
    const res = runGate();
    expect(res.code).toBe(1);
    expect(res.out).toContain('auctionsvc/src/auctionService/trade.ts');
    // Naming the rule matters: the message has to tell whoever hit it which file the call belongs in.
    const ruleLine = res.out.split('\n').find((l) => l.includes('belongs in auctionsvc/src/'));
    expect(ruleLine, `no rule attribution in gate output:\n${res.out}`).toBeTruthy();
    expect(res.out).toMatch(new RegExp(rule === 'key' ? 'idempotency key literal' : '(coin debit|system mail|escrow/grant|delivery helper)'));
  });

  it('fails when a capability moves out of the file that owns it, instead of silently enforcing nothing', () => {
    // The quiet way this gate would rot: `commercial.spend` gets refactored elsewhere and nobody repoints
    // `allowed`, so the rule matches nothing forever and reads as if it were still guarding something.
    const moved = { ...CLEAN_TREE };
    moved['auctionService/journalSteps.ts'] = moved['auctionService/journalSteps.ts']!.replace(
      'await deps.commercial.spend(step.accountId, step.amount, step.key);',
      '// the charge moved somewhere else entirely',
    );
    materialize(moved);
    const res = runGate();
    expect(res.code).toBe(1);
    expect(res.out).toContain('silently enforcing nothing');
    expect(res.out).toContain('spend');
  });
});

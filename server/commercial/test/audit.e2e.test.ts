// Coin-anomaly daily audit e2e (COMMERCIAL_DESIGN §6.6): auditCoinGains aggregates the ledger for accounts
// whose non-recharge gain in a UTC day crosses a threshold. Real Mongo (ledger aggregation pipeline).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import type { RandInt } from '../src/gacha';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_audit_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[commercial.audit.e2e] Mongo unreachable (${URI}) — skipping.`);

const zero: RandInt = () => 0;
const now = () => Date.now();

const DAY = '2026-07-20';
const DAY_START = Date.parse(`${DAY}T00:00:00.000Z`);
const inDay = (hourOffset: number) => DAY_START + hourOffset * 3600 * 1000;
const PREV_DAY_LATE = DAY_START - 1; // 23:59:59.999 the day before
const NEXT_DAY_EARLY = DAY_START + 24 * 3600 * 1000; // 00:00:00.000 the day after

describe.skipIf(!mongo)('commercial service — coin-anomaly daily audit (auditCoinGains)', () => {
  const m = mongo!;
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    svc = new CommercialService({ cols: m.collections, now, rng: zero });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Directly seed a ledger row (bypasses the wallet-mutation service methods — this audit only reads ledger). */
  async function seedLedger(accountId: string, delta: number, reason: string, ts: number): Promise<void> {
    await m.collections.ledger.insertOne({ accountId, delta, balanceAfter: 0, reason, ts });
  }

  it('sums non-recharge credits within the day; excludes recharge and debits', async () => {
    await seedLedger('whale', 500, 'event_reward', inDay(1));
    await seedLedger('whale', 3500, 'mail', inDay(2)); // auction proceeds land as reason:'mail'
    await seedLedger('whale', 5000, 'recharge', inDay(3)); // real money — must NOT count
    await seedLedger('whale', -1000, 'shop', inDay(4)); // debit — must NOT reduce the gain sum

    const rows = await svc.auditCoinGains(DAY, 3000);
    expect(rows).toEqual([{ accountId: 'whale', nonRechargeGain: 4000 }]); // 500 + 3500, recharge/debit excluded
  });

  it('accounts below the threshold are not returned', async () => {
    await seedLedger('small', 200, 'event_reward', inDay(5));
    await seedLedger('small', 100, 'ads', inDay(6));
    const rows = await svc.auditCoinGains(DAY, 3000);
    expect(rows).toEqual([]);
  });

  it('ledger rows outside the UTC day window are excluded (boundary correctness)', async () => {
    await seedLedger('boundary', 3000, 'event_reward', PREV_DAY_LATE);
    await seedLedger('boundary', 3000, 'event_reward', NEXT_DAY_EARLY);
    await seedLedger('boundary', 100, 'event_reward', inDay(12)); // inside the day, below threshold alone
    const rows = await svc.auditCoinGains(DAY, 3000);
    expect(rows).toEqual([]); // the two 3000-coin rows are outside the window; only 100 is inside
  });

  it('multiple accounts are sorted by gain descending', async () => {
    await seedLedger('acctA', 10000, 'event_reward', inDay(1));
    await seedLedger('acctB', 3000, 'event_reward', inDay(2));
    const rows = await svc.auditCoinGains(DAY, 3000);
    expect(rows).toEqual([
      { accountId: 'acctA', nonRechargeGain: 10000 },
      { accountId: 'acctB', nonRechargeGain: 3000 }, // exact threshold boundary — $gte, must be included
    ]);
  });

  it('malformed dayKey returns an empty array, never throws', async () => {
    await seedLedger('irrelevant', 10000, 'event_reward', inDay(1));
    await expect(svc.auditCoinGains('not-a-date', 3000)).resolves.toEqual([]);
  });
});

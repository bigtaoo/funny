// Branch-coverage backfill for src/paddle/webhookRoute.ts and src/replayArchive.ts
// (group G, 2026-09-03).
//
// paddle-unit.test.ts drives the webhook through `buildApp`, which always injects a socialsvc client
// and always sends a signed JSON body — so the "no Paddle-Signature header / no body at all" guard and
// the `deps.socialsvc ?? nullMetaSocialsvcClient` degraded fallback are unreachable from there. Both
// are reached here by registering the route (the exported `registerWebhookRoute`) on a bare Fastify
// instance with hand-built deps, which is also the only way to omit `socialsvc` at all.
//
// replayArchive-unit.test.ts covers the readdir failure but not the per-entry failure: the sweep must
// log and continue past one unlinkable directory entry rather than abandoning the rest of the volume.
//
// Imports from '../src/...' (never '../dist/...') so v8 coverage attributes lines to source.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { createMongo, makeNewSave, type MongoHandle } from '@nw/shared';
import { registerWebhookRoute } from '../src/paddle/webhookRoute.js';
import type { CommercialClient } from '../src/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_grpG_branch_test';
const SECRET = 'whsec_grpG';
const STARTER_PRICE = 'pri_grpG_starter';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[items-social-branch-paddle] Mongo unreachable (${URI}) — skipping the webhook describe.`);

function sign(rawBody: string): string {
  const ts = Math.floor(Date.now() / 1000);
  return `ts=${ts};h1=${createHmac('sha256', SECRET).update(`${ts}:${rawBody}`).digest('hex')}`;
}

describe.skipIf(!mongo)('POST /paddle/webhook (route registered without a socialsvc client)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  const prevSecret = process.env.NW_PADDLE_WEBHOOK_SECRET;
  const prevPriceIds = process.env.NW_PADDLE_PRICE_IDS;
  const starterBuyCalls: unknown[] = [];
  const deliveredOrders: string[] = [];

  const commercial = {
    available: true,
    async starterBuy(args: unknown) {
      starterBuyCalls.push(args);
      // One non-material / non-equipment / non-card itemId -> the loot-box skin branch, which is the
      // arm that hands `socialsvc` down into deliverOrder.
      return { ok: true as const, coinsAfter: 500, subscriptionExpiry: 0, results: [{ itemId: 'skin_grpG_probe', rarity: 'common' as const }] };
    },
    async orderDelivered(args: { orderId: string }) {
      deliveredOrders.push(args.orderId);
      return { ok: true as const };
    },
    async getWallet() { return null; }, // wallet mirror skipped; this test is about the delivery path
    async recordPaddleEvent() { /* not reached */ },
  } as unknown as CommercialClient;

  beforeAll(async () => {
    process.env.NW_PADDLE_WEBHOOK_SECRET = SECRET;
    process.env.NW_PADDLE_PRICE_IDS = `starter_draw:${STARTER_PRICE}`;
    await m.db.dropDatabase();
    await m.ensureIndexes();
    app = Fastify({ logger: false });
    // socialsvc deliberately omitted — the fallback under test.
    registerWebhookRoute(app, { cols: m.collections, commercial, now: () => 1_700_000_000_000, getAccountId: () => null });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevSecret === undefined) delete process.env.NW_PADDLE_WEBHOOK_SECRET;
    else process.env.NW_PADDLE_WEBHOOK_SECRET = prevSecret;
    if (prevPriceIds === undefined) delete process.env.NW_PADDLE_PRICE_IDS;
    else process.env.NW_PADDLE_PRICE_IDS = prevPriceIds;
  });

  it('a request with no Paddle-Signature header and no body at all -> 400 invalid signature', async () => {
    // Both `?? ''` fallbacks fire here (absent header, and no raw body because the JSON content-type
    // parser never ran). Without them this is a TypeError inside the HMAC call — i.e. a 500 that an
    // unauthenticated caller could trigger at will.
    const r = await app.inject({ method: 'POST', url: '/paddle/webhook' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toBe('invalid signature');
  });

  it('starter pack delivery with no socialsvc configured still delivers (falls back to the null mail client)', async () => {
    const accountId = 'acc-grpG-paddle';
    const save = makeNewSave(accountId, 1_700_000_000_000);
    await m.collections.saves.insertOne({ _id: accountId, save, rev: save.rev });

    const payload = {
      event_type: 'transaction.completed',
      data: {
        id: 'txn_grpG_1',
        status: 'completed',
        custom_data: { accountId },
        items: [{ price: { id: STARTER_PRICE }, quantity: 1 }],
      },
    };
    const raw = JSON.stringify(payload);
    const r = await app.inject({
      method: 'POST',
      url: '/paddle/webhook',
      headers: { 'content-type': 'application/json', 'paddle-signature': sign(raw) },
      payload: raw,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('ok');
    expect(starterBuyCalls).toHaveLength(1);
    expect(deliveredOrders).toEqual(['paddle:txn_grpG_1']);
    // The skin really landed, so the delivery ran with the null mail client rather than crashing on
    // an undefined socialsvc.
    const stored = await m.collections.saves.findOne({ _id: accountId });
    expect(stored!.save.inventory.skins).toContain('skin_grpG_probe');
    expect(await m.collections.skinInstances.countDocuments({ accountId })).toBe(1);
  });
});

describe('replayArchive.sweepArchive — one unsweepable entry must not abort the rest', () => {
  const prev = process.env.NW_REPLAY_ARCHIVE_DIR;

  afterAll(() => {
    if (prev === undefined) delete process.env.NW_REPLAY_ARCHIVE_DIR;
    else process.env.NW_REPLAY_ARCHIVE_DIR = prev;
  });

  it('a stray subdirectory older than the retention window is logged and skipped; old files still get deleted', async () => {
    // The archive volume is a plain mount — an operator (or a stray tool) can leave a directory in it.
    // `fs.unlink` on a directory always fails, and swallowing that per entry is what keeps a single
    // stray from freezing 365-day retention for every real replay file behind it.
    const dir = await mkdtemp(join(tmpdir(), 'nw-grpG-archive-'));
    process.env.NW_REPLAY_ARCHIVE_DIR = dir;
    vi.resetModules();
    const mod = await import('../src/replayArchive.js');

    const strayDir = join(dir, 'a-stray-directory');
    const oldFile = join(dir, 'z-old.meta.json');
    await mkdir(strayDir);
    await writeFile(oldFile, '{}');
    const oldTime = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    await fs.utimes(strayDir, oldTime, oldTime);
    await fs.utimes(oldFile, oldTime, oldTime);

    await expect(mod.sweepArchive()).resolves.toBeUndefined();

    await expect(fs.stat(strayDir)).resolves.toBeDefined(); // unlink refused, entry survives
    await expect(fs.stat(oldFile)).rejects.toThrow(); // the real expired file was still swept
    await rm(dir, { recursive: true, force: true });
  });
});

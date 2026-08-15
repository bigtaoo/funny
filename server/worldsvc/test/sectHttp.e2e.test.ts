// worldsvc /sect/* public REST end-to-end (S8-4b): real node:http server + global fetch calls.
//
// Coverage gap this file closes (2026-08-11, found while auditing the sectService.ts composition
// split): sect.e2e.test.ts's 21 cases all call `SectService` methods directly (service layer), never
// through `sectRoutes.ts`; httpApi.e2e.test.ts imports `SectService` and wires it into its shared
// server, but never sends a single `/sect/*` request, and that shared instance has no `socialsvc`
// configured (every family-leader check would 403 NOT_IN_FAMILY) — so none of the 10 `/sect/*` routes
// had ANY wire-level coverage: route string match, JSON body parsing, and the SlgError ->
// ERROR_HTTP_STATUS mapping were all unexercised end-to-end. Same class of gap as familyHttp.e2e.test.ts
// / friendHttp.e2e.test.ts / admin's internalHttp.e2e.test.ts found in their own httpApi splits (method
// name appearing in a test file's imports is not the same as the route being covered).
//
// Own dedicated real-http server (mirrors httpApi.e2e.test.ts's setup) with its own SectService wired
// to a FakeSocialsvc (sect.e2e.test.ts's fixture, reused verbatim) — needed because family-leader
// membership must actually resolve to something for the write routes' happy paths to be reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken, sectId, SECT_CREATE_COST, SLG_MAP_W, SLG_MAP_H, EMBLEM_KEYS, EMBLEM_COLORS, type FamilyRole } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { SectService } from '../src/sectService';
import { NationChannelService } from '../src/nationChannelService';
import { MapTemplateService } from '../src/mapTemplateService';
import { nullWorldGatewayClient } from '../src/gatewayClient';
import { nullWorldSocialsvcClient } from '../src/socialsvcClient';
import { startHttpApi } from '../src/httpApi';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldGatewayClient } from '../src/gatewayClient';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_secthttp_test';
const SECRET = 'test-jwt-secret';
const W = 'secthttp-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.sectHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

/** In-process fake of socialsvc's family store — copied from sect.e2e.test.ts's FakeSocialsvc (same fixture, same reasons). */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  private families = new Map<string, FamilySummary & { activity: number }>();
  private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();

  addFamily(leaderId: string, name: string, tag: string): string {
    const familyId = `fam:${tag.toUpperCase()}`;
    this.families.set(familyId, {
      familyId, name, tag: tag.toUpperCase(), leaderId, memberCount: 1,
      prosperity: 0, prosperityUpdatedAt: 0, activity: 500,
    });
    this.memberRole.set(leaderId, { familyId, role: 'leader' });
    return familyId;
  }

  addMember(accountId: string, familyId: string, role: FamilyRole = 'member'): void {
    this.memberRole.set(accountId, { familyId, role });
    const f = this.families.get(familyId);
    if (f) f.memberCount += 1;
  }

  async getFamilyId(accountId: string): Promise<string | null> {
    return this.memberRole.get(accountId)?.familyId ?? null;
  }

  async getMember(accountId: string): Promise<FamilyMembership | null> {
    const m = this.memberRole.get(accountId);
    if (!m) return null;
    const f = this.families.get(m.familyId);
    if (!f) return null;
    return {
      familyId: m.familyId, role: m.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount,
      ...(f.sectId ? { sectId: f.sectId } : {}),
    };
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    return familyIds.map((id) => this.families.get(id)).filter((f): f is FamilySummary & { activity: number } => !!f)
      .map((f) => ({ ...f }));
  }

  async getFamiliesBySect(sid: string): Promise<FamilySummary[]> {
    return [...this.families.values()].filter((f) => f.sectId === sid).map((f) => ({ ...f }));
  }

  async setSect(familyId: string, sid: string | null, sectName?: string | null): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    if (sid) { f.sectId = sid; if (sectName) f.sectName = sectName; }
    else { delete f.sectId; delete f.sectName; }
  }

  async bumpActivity(): Promise<void> { /* unused by this suite */ }
  async refreshProsperity(): Promise<number> { return 0; }
  async bumpActivityAndProsperity(): Promise<number> { return 0; }
  async resetSlgState(): Promise<void> { /* unused by this suite */ }

  onPush?: (event: string, payload: unknown, targets?: string[]) => void;
  async push(_channel: SocialsvcChannel, event: string, payload: unknown, targets?: string[]): Promise<void> {
    this.onPush?.(event, payload, targets);
  }
}

describe.skipIf(!mongo)('worldsvc /sect/* httpApi e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let socialsvc: FakeSocialsvc;
  const spends: Array<{ accountId: string; amount: number }> = [];
  const pushes: Array<{ event: string; targets?: string[] }> = [];

  function authFor(accountId: string): { authorization: string } {
    return { authorization: `Bearer ${signToken(accountId, { secret: SECRET })}` };
  }

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    socialsvc = new FakeSocialsvc();
    socialsvc.onPush = (event, _payload, targets) => { pushes.push({ event, targets }); };
    const commercial: WorldCommercialClient = {
      available: true,
      async spend(accountId, amount) { spends.push({ accountId, amount }); },
      async grant() { /* no-op: not exercised by this suite */ },
    };
    const fakeGateway: WorldGatewayClient = {
      available: true,
      async push() { /* not used by sect */ },
      async broadcast() { /* socialsvc.push is the preferred path here (available=true) */ },
    };

    const svc = new WorldService({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => Date.now() });
    const sectSvc = new SectService({ cols: m.collections, commercial, gateway: fakeGateway, socialsvc, now: () => Date.now() });
    const nationChannelSvc = new NationChannelService({
      cols: m.collections,
      gateway: nullWorldGatewayClient as unknown as ConstructorParameters<typeof NationChannelService>[0]['gateway'],
      commercial: { available: true, async spend() { /* no-op */ }, async grant() { /* no-op */ } },
      now: () => Date.now(),
    });
    const mapTemplateSvc = new MapTemplateService({ cols: m.collections, now: () => Date.now() });

    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: 'test-internal-key' },
      svc, sectSvc, nationChannelSvc, nullWorldSocialsvcClient, mapTemplateSvc,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('POST /sect/create unauthenticated → 401', async () => {
    const r = await fetch(`${base}/sect/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, name: 'X', tag: 'XX' }),
    });
    expect(r.status).toBe(401);
  });

  it('POST /sect/create missing fields → 400', async () => {
    const r = await fetch(`${base}/sect/create`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /sect/create: player not in any family → 403 NOT_IN_FAMILY (proves SlgError -> ERROR_HTTP_STATUS wiring end-to-end)', async () => {
    const r = await fetch(`${base}/sect/create`, {
      method: 'POST',
      headers: { ...authFor('nobody'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, name: 'Nope Sect', tag: 'NOP' }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe('NOT_IN_FAMILY');
  });

  it('POST /sect/create happy path: family leader founds a sect, coins deducted (SECT_CREATE_COST), sect appears in GET /sect/list and GET /sect/:id', async () => {
    socialsvc.addFamily('alice', 'Alpha', 'AW');
    const r = await fetch(`${base}/sect/create`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, name: 'Sky Sect', tag: 'SKY' }),
    });
    expect(r.status).toBe(200);
    const created = (await r.json()).data;
    expect(created.sectId).toBe(sectId(W, 'SKY'));
    expect(created.leaderId).toBe('alice');
    expect(spends).toEqual([{ accountId: 'alice', amount: SECT_CREATE_COST }]);

    const listR = await fetch(`${base}/sect/list?worldId=${W}`, { headers: authFor('alice') });
    expect(listR.status).toBe(200);
    const list = (await listR.json()).data as Array<{ sectId: string }>;
    expect(list.some((s) => s.sectId === created.sectId)).toBe(true);

    const getR = await fetch(`${base}/sect/${encodeURIComponent(created.sectId)}`, { headers: authFor('alice') });
    expect(getR.status).toBe(200);
    expect((await getR.json()).data.name).toBe('Sky Sect');
  });

  it('POST /sect/join happy path: a second family leader joins the sect founded above; GET /sect/:id reflects memberFamilyCount', async () => {
    socialsvc.addFamily('bob', 'Beta', 'BW');
    const joinR = await fetch(`${base}/sect/join`, {
      method: 'POST',
      headers: { ...authFor('bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, sectId: sectId(W, 'SKY') }),
    });
    expect(joinR.status).toBe(200);
    const getR = await fetch(`${base}/sect/${encodeURIComponent(sectId(W, 'SKY'))}`, { headers: authFor('bob') });
    expect((await getR.json()).data.memberFamilyCount).toBe(2);
  });

  it('POST /sect/join missing fields → 400', async () => {
    const r = await fetch(`${base}/sect/join`, {
      method: 'POST',
      headers: { ...authFor('bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /sect/ally + POST /sect/unally happy path (two sects, initiated by the sect leader)', async () => {
    socialsvc.addFamily('carol', 'Gamma', 'GW');
    await fetch(`${base}/sect/create`, {
      method: 'POST',
      headers: { ...authFor('carol'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, name: 'Storm Sect', tag: 'STM' }),
    });

    const allyR = await fetch(`${base}/sect/ally`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, targetSectId: sectId(W, 'STM') }),
    });
    expect(allyR.status).toBe(200);
    const afterAlly = (await (await fetch(`${base}/sect/${encodeURIComponent(sectId(W, 'SKY'))}`, { headers: authFor('alice') })).json()).data;
    expect(afterAlly.allySectIds).toContain(sectId(W, 'STM'));

    const unallyR = await fetch(`${base}/sect/unally`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, targetSectId: sectId(W, 'STM') }),
    });
    expect(unallyR.status).toBe(200);
    const afterUnally = (await (await fetch(`${base}/sect/${encodeURIComponent(sectId(W, 'SKY'))}`, { headers: authFor('alice') })).json()).data;
    expect(afterUnally.allySectIds).not.toContain(sectId(W, 'STM'));
  });

  it('POST /sect/message + GET /sect/channel happy path: a member sends a message, it is fanned out (socialsvc.push) and retrievable from the channel', async () => {
    const sendR = await fetch(`${base}/sect/message`, {
      method: 'POST',
      headers: { ...authFor('bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, body: 'hello sect' }),
    });
    expect(sendR.status).toBe(200);
    expect((await sendR.json()).data.body).toBe('hello sect');
    expect(pushes.some((p) => p.event === 'sect_msg')).toBe(true);

    const chanR = await fetch(`${base}/sect/channel?worldId=${W}`, { headers: authFor('bob') });
    expect(chanR.status).toBe(200);
    const msgs = (await chanR.json()).data as Array<{ body: string }>;
    expect(msgs.some((mm) => mm.body === 'hello sect')).toBe(true);
  });

  it('POST /sect/message: sender not in any sect → 403 NOT_IN_SECT', async () => {
    const r = await fetch(`${base}/sect/message`, {
      method: 'POST',
      headers: { ...authFor('nobody'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, body: 'hi' }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('NOT_IN_SECT');
  });

  it('POST /sect/vote-remove-leader happy path: a member nominates a replacement, vote is recorded (not yet enough to pass with only 1/2 families)', async () => {
    const r = await fetch(`${base}/sect/vote-remove-leader`, {
      method: 'POST',
      headers: { ...authFor('bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, nomineeFamilyId: 'fam:BW' }),
    });
    expect(r.status).toBe(200);
    const result = (await r.json()).data;
    expect(result.passed).toBe(false);
    expect(result.voteCount).toBe(1);
  });

  it('POST /sect/vote-remove-leader missing fields → 400', async () => {
    const r = await fetch(`${base}/sect/vote-remove-leader`, {
      method: 'POST',
      headers: { ...authFor('bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /sect/emblem: sect leader sets emblemKey+emblemColor; a member family leader (bob, not the sect leader) is denied', async () => {
    const asBob = await fetch(`${base}/sect/emblem`, {
      method: 'POST',
      headers: { ...authFor('bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, emblemKey: EMBLEM_KEYS[4], emblemColor: EMBLEM_COLORS[3] }),
    });
    expect(asBob.status).toBe(403);
    expect((await asBob.json()).error.code).toBe('NO_PERMISSION');

    const asAlice = await fetch(`${base}/sect/emblem`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, emblemKey: EMBLEM_KEYS[4], emblemColor: EMBLEM_COLORS[3] }),
    });
    expect(asAlice.status).toBe(200);

    const getR = await fetch(`${base}/sect/${encodeURIComponent(sectId(W, 'SKY'))}`, { headers: authFor('alice') });
    const sect = (await getR.json()).data as { emblemKey?: string; emblemColor?: number };
    expect(sect.emblemKey).toBe(EMBLEM_KEYS[4]);
    expect(sect.emblemColor).toBe(EMBLEM_COLORS[3]);
  });

  it('POST /sect/emblem: missing fields → 400; key/colour outside the fixed pools → 400', async () => {
    const missingWorldId = await fetch(`${base}/sect/emblem`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ emblemKey: EMBLEM_KEYS[0], emblemColor: EMBLEM_COLORS[0] }),
    });
    expect(missingWorldId.status).toBe(400);

    const badKey = await fetch(`${base}/sect/emblem`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, emblemKey: 'not_a_real_key', emblemColor: EMBLEM_COLORS[0] }),
    });
    expect(badKey.status).toBe(400);

    const badColor = await fetch(`${base}/sect/emblem`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, emblemKey: EMBLEM_KEYS[0], emblemColor: 0x123456 }),
    });
    expect(badColor.status).toBe(400);
  });

  it('POST /sect/emblem: unauthenticated → 401', async () => {
    const r = await fetch(`${base}/sect/emblem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, emblemKey: EMBLEM_KEYS[0], emblemColor: EMBLEM_COLORS[0] }),
    });
    expect(r.status).toBe(401);
  });

  it('POST /sect/leave happy path: a non-leader family leaves, memberFamilyCount decrements', async () => {
    const leaveR = await fetch(`${base}/sect/leave`, {
      method: 'POST',
      headers: { ...authFor('bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W }),
    });
    expect(leaveR.status).toBe(200);
    const getR = await fetch(`${base}/sect/${encodeURIComponent(sectId(W, 'SKY'))}`, { headers: authFor('alice') });
    expect((await getR.json()).data.memberFamilyCount).toBe(1);
  });

  it('POST /sect/dissolve happy path: the sect leader dissolves the sect; it disappears from GET /sect/list', async () => {
    const dissolveR = await fetch(`${base}/sect/dissolve`, {
      method: 'POST',
      headers: { ...authFor('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W }),
    });
    expect(dissolveR.status).toBe(200);
    const listR = await fetch(`${base}/sect/list?worldId=${W}`, { headers: authFor('alice') });
    const list = (await listR.json()).data as Array<{ sectId: string }>;
    expect(list.some((s) => s.sectId === sectId(W, 'SKY'))).toBe(false);
  });
});

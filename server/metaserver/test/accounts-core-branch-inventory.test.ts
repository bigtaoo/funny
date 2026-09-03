// Branch-coverage backfill for src/service/inventory.ts (2026-09-03 branch-coverage task, group F).
//
// inventory.ts is nothing but the HTTP wrapper over src/equipment/*.ts and src/cards/*.ts: read fields
// off req.body, call the domain function, map its error code to an HTTP status. The domain logic has
// thorough unit coverage of its own (equipment-*-unit.test.ts, cards-*-unit.test.ts) and
// inventory-service-unit.test.ts re-drives one happy path plus one *mapped* error per handler — what
// was left untaken on all nine handlers is the OTHER side of `ERROR_HTTP_STATUS[r.code] ?? 400`.
//
// Those five codes used to take that fallback — NOT_REFORGE_ELIGIBLE, INVALID_RARITY,
// INVALID_MATERIAL_LEVEL (equipment) and CARD_LOCKED, WRONG_FACTION (cards) are declared in the
// domains' own error unions rather than in shared's ErrorCode, and ERROR_HTTP_STATUS had no entry for
// any of them. They all have one as of 2026-09-03 (see `domainMapped` per spec below; CARD_LOCKED in
// particular is 409 to match its equipment twin EQUIP_LOCKED instead of a lone 400), so the fallback is
// driven here by a code that genuinely has no entry and never will — a future/unknown one. It still
// matters: without it `reply.code(undefined)` would throw and an ordinary refusal would be a 500. The
// domain functions are stubbed here (this file is about the wrapper's own dispatch, not about
// re-testing craft/fuse) so each handler can be driven through every side deterministically.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardInstance, Collections, EquipmentInstance, SaveData } from '@nw/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

const h = vi.hoisted(() => {
  const state = { result: undefined as unknown, calls: [] as { fn: string; args: unknown[] }[] };
  const mk = (fn: string) => async (...args: unknown[]) => {
    state.calls.push({ fn, args });
    return state.result;
  };
  return { state, mk };
});

vi.mock('../src/equipment.js', () => ({
  craftEquipment: h.mk('craftEquipment'),
  enhanceEquipment: h.mk('enhanceEquipment'),
  salvageEquipment: h.mk('salvageEquipment'),
  equipEquipment: h.mk('equipEquipment'),
  reforgeEquipment: h.mk('reforgeEquipment'),
}));
vi.mock('../src/cards.js', () => ({
  fuseCards: h.mk('fuseCards'),
  fuseCardsBatch: h.mk('fuseCardsBatch'),
  setCardLock: h.mk('setCardLock'),
}));

// Imported after the vi.mock registrations above so the stubs are in place when inventory.ts's own
// `import ... from '../equipment.js'` is resolved.
const { InventoryService } = await import('../src/service/inventory.js');
const { MetaCore } = await import('../src/service/base.js');
type ServiceDeps = import('../src/service/base.js').ServiceDeps;

const TS = 1_700_000_000_000;
const SAVE = { accountId: 'acc-1', rev: 7 } as unknown as SaveData;
const INST = { id: 'i1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] } as EquipmentInstance;
const CARD = { id: 'c1', defId: 'lichuang', level: 1, gear: {}, locked: false } as CardInstance;

function makeService(commercialAvailable = true) {
  const deps = {
    cols: {} as Collections,
    jwt: { secret: 's' },
    now: () => TS,
    commercial: { available: commercialAvailable },
    gatewayPublicUrl: null,
    authRateLimit: 0,
    flags: null,
    wordlists: null,
    region: null,
    lokiPushUrl: null,
    socialsvc: null,
    redis: null,
    accountCache: {},
  } as unknown as ServiceDeps;
  return new InventoryService(new MetaCore(deps));
}

function req(body: Record<string, unknown>, headers: Record<string, unknown> = {}): FastifyRequest {
  return { accountId: 'acc-1', body, headers, params: {}, query: {} } as unknown as FastifyRequest;
}

function reply(): FastifyReply & { sent: { status?: number; payload?: { error?: { code: string; message: string } } } } {
  const sent: { status?: number; payload?: { error?: { code: string; message: string } } } = {};
  const r = {
    code(c: number) { sent.status = c; return r; },
    send(p: unknown) { sent.payload = p as never; return r; },
    sent,
  };
  return r as unknown as FastifyReply & { sent: typeof sent };
}

type Svc = ReturnType<typeof makeService>;

interface Spec {
  name: string;
  /** The domain function the wrapper is expected to dispatch to. */
  target: string;
  body: Record<string, unknown>;
  call: (svc: Svc, rq: FastifyRequest, rp: FastifyReply) => Promise<unknown>;
  success: unknown;
  expected: unknown;
  /** A code that IS in ERROR_HTTP_STATUS, with the status it must produce. */
  mapped: { code: string; status: number };
  /** A domain-local code (not in shared's ErrorCode) that ERROR_HTTP_STATUS nonetheless maps. */
  domainMapped: { code: string; status: number };
}

/** No entry in ERROR_HTTP_STATUS by construction — this is what drives the `?? 400` fallback arm. */
const UNMAPPED_CODE = 'SOME_CODE_FROM_A_FUTURE_RELEASE';

const SPECS: Spec[] = [
  {
    name: 'craftEquipment',
    target: 'craftEquipment',
    body: { defId: 'wp_pencil', idempotencyKey: 'k1' },
    call: (s, rq, rp) => s.craftEquipment(rq, rp),
    success: { save: SAVE, instance: INST },
    expected: { save: SAVE, instance: INST },
    mapped: { code: 'INSUFFICIENT_MATERIALS', status: 402 },
    domainMapped: { code: 'INVALID_RARITY', status: 400 },
  },
  {
    name: 'enhanceEquipment',
    target: 'enhanceEquipment',
    body: { instanceId: 'e1', idempotencyKey: 'k2', useProtect: true },
    call: (s, rq, rp) => s.enhanceEquipment(rq, rp),
    success: { success: true, instance: INST, save: SAVE },
    expected: { success: true, instance: INST, save: SAVE },
    mapped: { code: 'ENHANCE_MAX_LEVEL', status: 409 },
    domainMapped: { code: 'INVALID_RARITY', status: 400 },
  },
  {
    name: 'salvageEquipment',
    target: 'salvageEquipment',
    body: { instanceIds: ['s1', 's2'], idempotencyKey: 'k3' },
    call: (s, rq, rp) => s.salvageEquipment(rq, rp),
    success: { refunded: { scrap: 3 }, save: SAVE },
    expected: { refunded: { scrap: 3 }, save: SAVE },
    mapped: { code: 'NOT_SALVAGEABLE', status: 409 },
    domainMapped: { code: 'INVALID_RARITY', status: 400 },
  },
  {
    name: 'equipEquipment',
    target: 'equipEquipment',
    body: { slot: 'weapon', instanceId: 'w1', cardInstanceId: 'c1' },
    call: (s, rq, rp) => s.equipEquipment(rq, rp),
    success: { save: SAVE },
    expected: { save: SAVE },
    mapped: { code: 'INVALID_SLOT', status: 400 },
    domainMapped: { code: 'INVALID_RARITY', status: 400 },
  },
  {
    name: 'reforgeEquipment',
    target: 'reforgeEquipment',
    body: { targetId: 't1', materialId: 'm1', idempotencyKey: 'k4' },
    call: (s, rq, rp) => s.reforgeEquipment(rq, rp),
    success: { instance: INST, save: SAVE },
    expected: { instance: INST, save: SAVE },
    mapped: { code: 'EQUIP_LOCKED', status: 409 },
    domainMapped: { code: 'NOT_REFORGE_ELIGIBLE', status: 409 },
  },
  {
    name: 'cardsFuse',
    target: 'fuseCards',
    body: { targetId: 't1', materialIds: ['a', 'b', 'c', 'd', 'e'], idempotencyKey: 'k5' },
    call: (s, rq, rp) => s.cardsFuse(rq, rp),
    success: { card: CARD, save: SAVE },
    expected: { card: CARD, save: SAVE },
    mapped: { code: 'CARD_NOT_FOUND', status: 404 },
    domainMapped: { code: 'CARD_LOCKED', status: 409 },
  },
  {
    name: 'cardsFuseBatch',
    target: 'fuseCardsBatch',
    body: { rounds: [{ targetId: 't1', materialIds: [] }], idempotencyKey: 'k6' },
    call: (s, rq, rp) => s.cardsFuseBatch(rq, rp),
    success: { completed: 2, save: SAVE },
    expected: { completed: 2, save: SAVE },
    mapped: { code: 'BAD_REQUEST', status: 400 },
    domainMapped: { code: 'WRONG_FACTION', status: 400 },
  },
  {
    name: 'cardsLock',
    target: 'setCardLock',
    body: { cardInstanceId: 'c1' },
    call: (s, rq, rp) => s.cardsLock(rq, rp),
    success: { save: SAVE },
    expected: { save: SAVE },
    mapped: { code: 'CARD_NOT_FOUND', status: 404 },
    domainMapped: { code: 'CARD_LOCKED', status: 409 },
  },
  {
    name: 'cardsUnlock',
    target: 'setCardLock',
    body: { cardInstanceId: 'c1' },
    call: (s, rq, rp) => s.cardsUnlock(rq, rp),
    success: { save: SAVE },
    expected: { save: SAVE },
    mapped: { code: 'CARD_NOT_FOUND', status: 404 },
    domainMapped: { code: 'CARD_LOCKED', status: 409 },
  },
];

beforeEach(() => {
  h.state.calls.length = 0;
  h.state.result = undefined;
});

describe.each(SPECS)('InventoryService.$name', (spec) => {
  it('success -> ok() with the domain result, nothing written to the reply', async () => {
    h.state.result = spec.success;
    const rp = reply();
    const out = await spec.call(makeService(), req(spec.body), rp) as { ok: boolean; data: unknown };
    expect(h.state.calls.map((c) => c.fn)).toEqual([spec.target]);
    expect(out.ok).toBe(true);
    expect(out.data).toEqual(spec.expected);
    expect(rp.sent.status).toBeUndefined();
  });

  it(`a mapped domain error -> its ERROR_HTTP_STATUS status`, async () => {
    h.state.result = { error: 'nope', code: spec.mapped.code };
    const rp = reply();
    await spec.call(makeService(), req(spec.body), rp);
    expect(rp.sent.status).toBe(spec.mapped.status);
    expect(rp.sent.payload?.error).toEqual({ code: spec.mapped.code, message: 'nope' });
  });

  it('a domain-local code carries its own status too, not a blanket 400', async () => {
    // These come from equipment/cards' own error unions, never from shared's ErrorCode — but they reach
    // the client through the same map, so a missing entry silently flattened them. CARD_LOCKED was the
    // visible cost: fusing with a locked card answered 400 while salvaging locked equipment answered
    // 409 for the identical refusal.
    h.state.result = { error: 'nope', code: spec.domainMapped.code };
    const rp = reply();
    await spec.call(makeService(), req(spec.body), rp);
    expect(rp.sent.status).toBe(spec.domainMapped.status);
    expect(rp.sent.payload?.error).toEqual({ code: spec.domainMapped.code, message: 'nope' });
  });

  it('a code with no ERROR_HTTP_STATUS entry at all -> 400, never an undefined status', async () => {
    h.state.result = { error: 'nope', code: UNMAPPED_CODE };
    const rp = reply();
    await spec.call(makeService(), req(spec.body), rp);
    expect(rp.sent.status).toBe(400);
    // The code itself still reaches the client verbatim, so the UI can show the specific refusal even
    // though the status had to be generalised.
    expect(rp.sent.payload?.error).toEqual({ code: UNMAPPED_CODE, message: 'nope' });
  });
});

describe('InventoryService.equipEquipment instanceId normalisation', () => {
  it('an omitted instanceId is normalised to null (unequip), not forwarded as undefined', async () => {
    // equipEquipment distinguishes "write this instance into the slot" from "clear the slot" by
    // null; an undefined arriving from a client that omitted the field must mean unequip, and must not
    // reach the domain function as `undefined` (which its own null check would not catch).
    h.state.result = { save: SAVE };
    await makeService().equipEquipment(req({ slot: 'weapon', cardInstanceId: 'c1' }), reply());
    expect(h.state.calls[0]!.args[4]).toBeNull();
  });

  it('an explicit null instanceId also unequips', async () => {
    h.state.result = { save: SAVE };
    await makeService().equipEquipment(req({ slot: 'weapon', instanceId: null, cardInstanceId: 'c1' }), reply());
    expect(h.state.calls[0]!.args[4]).toBeNull();
  });

  it('a real instanceId is forwarded verbatim', async () => {
    h.state.result = { save: SAVE };
    await makeService().equipEquipment(req({ slot: 'weapon', instanceId: 'w1', cardInstanceId: 'c1' }), reply());
    expect(h.state.calls[0]!.args[4]).toBe('w1');
  });
});

describe('InventoryService.cardsFuseBatch partial-success payload', () => {
  it('a batch that stopped early reports `failed` alongside `completed`', async () => {
    h.state.result = { completed: 2, failed: { round: 2, code: 'CARD_LOCKED' }, save: SAVE };
    const out = await makeService().cardsFuseBatch(req({ rounds: [], idempotencyKey: 'k' }), reply()) as {
      ok: boolean; data: Record<string, unknown>;
    };
    expect(out.ok).toBe(true); // partial success is a 200, not an error status
    expect(out.data.completed).toBe(2);
    expect(out.data.failed).toEqual({ round: 2, code: 'CARD_LOCKED' });
  });

  it('a fully successful batch omits `failed` entirely', async () => {
    h.state.result = { completed: 3, save: SAVE };
    const out = await makeService().cardsFuseBatch(req({ rounds: [], idempotencyKey: 'k' }), reply()) as {
      data: Record<string, unknown>;
    };
    expect('failed' in out.data).toBe(false);
  });
});

describe('InventoryService clientPlatform forwarding (X-NW-Platform -> commercial spend bucket)', () => {
  it('enhance and reforge forward the declared platform', async () => {
    h.state.result = { success: true, instance: INST, save: SAVE };
    await makeService().enhanceEquipment(req({ instanceId: 'e1', idempotencyKey: 'k' }, { 'x-nw-platform': 'ios' }), reply());
    expect(h.state.calls[0]!.args.at(-1)).toBe('ios');

    h.state.calls.length = 0;
    h.state.result = { instance: INST, save: SAVE };
    await makeService().reforgeEquipment(req({ targetId: 't', materialId: 'm', idempotencyKey: 'k' }, { 'x-nw-platform': 'wechat' }), reply());
    expect(h.state.calls[0]!.args.at(-1)).toBe('wechat');
  });

  it('no platform header -> undefined is forwarded, so commercial applies its own web default', async () => {
    h.state.result = { success: false, instance: INST, save: SAVE };
    await makeService().enhanceEquipment(req({ instanceId: 'e1', idempotencyKey: 'k' }), reply());
    expect(h.state.calls[0]!.args.at(-1)).toBeUndefined();
  });

  it('useProtect is normalised to a strict boolean (a truthy non-true value must not buy protection)', async () => {
    h.state.result = { success: true, instance: INST, save: SAVE };
    await makeService().enhanceEquipment(req({ instanceId: 'e1', idempotencyKey: 'k', useProtect: 'yes' }), reply());
    expect(h.state.calls[0]!.args[6]).toBe(false);

    h.state.calls.length = 0;
    await makeService().enhanceEquipment(req({ instanceId: 'e1', idempotencyKey: 'k', useProtect: true }), reply());
    expect(h.state.calls[0]!.args[6]).toBe(true);
  });
});

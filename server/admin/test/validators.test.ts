// Exhaustive branch coverage for src/service/validators.ts — the pure input validators/normalisers
// and audit-summary formatters shared by the AdminService domains.
//
// Why this file exists (2026-09-03 branch-coverage pass): the module printed 84% lines / 48%
// branches, the worst branch figure in the whole admin package. Every function here IS reached by
// the route e2e suites, but only ever down its happy path with fully-populated inputs, so 49 of its
// 95 branches had never executed: the `?? ''` fallbacks that exist precisely because httpApi hands
// these functions raw JSON (a client can omit any field), the per-attachment-kind rejections, the
// `Array.isArray` guards, and — in describeFlag/describeShopItem — the optional-chaining arms that
// decide what the audit trail actually records. That last group is the reason the gap mattered
// rather than being a percentage: an audit `summary` is the only durable record of what an operator
// changed, and nothing pinned what it says when a flag has no rollout, an empty rollout, or is
// being turned off.
//
// The repo's coverage gate only measures LINE coverage (scripts/checkCoverageThreshold.mjs), which
// this module already passed — so nothing would ever have reported the branch half.
import { describe, expect, it } from 'vitest';
import type { FeatureFlagDoc, SlgShopItemOverrideDoc, TradeAuditSnapshot } from '@nw/shared';
import type { AdminAccountDoc } from '../src/db';
import { AdminError } from '../src/service/errors';
import {
  describeFlag,
  describeShopItem,
  describeTarget,
  toAccountView,
  validateAuditSnapshot,
  validateMail,
  validateRollout,
  validateShopItemInput,
  validateTarget,
} from '../src/service/validators';

const ACCOUNT: AdminAccountDoc = {
  _id: 'adm-1',
  username: 'root',
  passwordHash: 'x',
  role: 'super',
  displayName: 'Root',
  disabled: false,
  createdAt: 100,
};

const SNAPSHOT: TradeAuditSnapshot = {
  worldId: 'w1',
  sellerId: 's1',
  buyerId: 'b1',
  trades: 3,
  designatedTrades: 1,
  totalCoins: 500,
  firstTs: 10,
  lastTs: 20,
  severity: 'medium',
  reasons: ['repeated'],
};

describe('toAccountView', () => {
  it('omits createdBy/lastLoginAt when the document has neither', () => {
    const v = toAccountView(ACCOUNT);
    expect(v).toEqual({
      id: 'adm-1',
      username: 'root',
      role: 'super',
      displayName: 'Root',
      disabled: false,
      createdAt: 100,
    });
    expect(v).not.toHaveProperty('createdBy');
    expect(v).not.toHaveProperty('lastLoginAt');
  });

  it('includes createdBy/lastLoginAt when present, and never leaks passwordHash', () => {
    const v = toAccountView({ ...ACCOUNT, createdBy: 'adm-0', lastLoginAt: 999 });
    expect(v).toMatchObject({ createdBy: 'adm-0', lastLoginAt: 999 });
    expect(v).not.toHaveProperty('passwordHash');
  });
});

describe('validateAuditSnapshot', () => {
  it('rejects a missing snapshot and a non-object one', () => {
    expect(() => validateAuditSnapshot(undefined)).toThrow(AdminError);
    expect(() => validateAuditSnapshot(undefined)).toThrowError(/snapshot required/);
    expect(() => validateAuditSnapshot('nope' as unknown as TradeAuditSnapshot)).toThrowError(/snapshot required/);
  });

  it('rejects a snapshot whose worldId/sellerId/buyerId are missing, blank, or whitespace-only', () => {
    // The three `?? ''` fallbacks: httpApi forwards the parsed JSON body as-is, so any of these
    // fields can simply be absent rather than empty.
    for (const partial of [
      {},
      { worldId: 'w1' },
      { worldId: 'w1', sellerId: 's1' },
      { worldId: '  ', sellerId: 's1', buyerId: 'b1' },
    ]) {
      expect(() => validateAuditSnapshot(partial as TradeAuditSnapshot)).toThrowError(
        /requires worldId\/sellerId\/buyerId/,
      );
    }
  });

  it('rejects a self-trade (seller === buyer)', () => {
    expect(() => validateAuditSnapshot({ ...SNAPSHOT, buyerId: 's1' })).toThrowError(/must differ/);
  });

  it('trims the ids and keeps a valid snapshot intact', () => {
    expect(validateAuditSnapshot({ ...SNAPSHOT, worldId: ' w1 ', sellerId: ' s1 ', buyerId: ' b1 ' })).toEqual(SNAPSHOT);
  });

  it('normalises severity: only the literal "high" survives, everything else becomes medium', () => {
    expect(validateAuditSnapshot({ ...SNAPSHOT, severity: 'high' }).severity).toBe('high');
    expect(validateAuditSnapshot({ ...SNAPSHOT, severity: 'critical' as 'high' }).severity).toBe('medium');
    expect(validateAuditSnapshot({ ...SNAPSHOT, severity: undefined as unknown as 'high' }).severity).toBe('medium');
  });

  it('drops unknown reasons and treats a non-array reasons field as empty', () => {
    expect(validateAuditSnapshot({ ...SNAPSHOT, reasons: ['repeated', 'bogus' as 'repeated', 'high_value'] }).reasons)
      .toEqual(['repeated', 'high_value']);
    expect(validateAuditSnapshot({ ...SNAPSHOT, reasons: undefined as unknown as [] }).reasons).toEqual([]);
    expect(validateAuditSnapshot({ ...SNAPSHOT, reasons: 'repeated' as unknown as [] }).reasons).toEqual([]);
  });

  it('floors the numeric fields and clamps non-finite / negative / non-numeric ones to 0', () => {
    expect(validateAuditSnapshot({ ...SNAPSHOT, trades: 3.9, totalCoins: 500.5 })).toMatchObject({
      trades: 3,
      totalCoins: 500,
    });
    expect(
      validateAuditSnapshot({
        ...SNAPSHOT,
        trades: -1,
        designatedTrades: Number.NaN,
        totalCoins: Number.POSITIVE_INFINITY,
        firstTs: undefined as unknown as number,
        lastTs: 'x' as unknown as number,
      }),
    ).toMatchObject({ trades: 0, designatedTrades: 0, totalCoins: 0, firstTs: 0, lastTs: 0 });
  });
});

describe('validateMail', () => {
  const MAIL = { subject: 's', body: 'b', attachments: [], expireDays: 7 };

  it('rejects a missing mail object and a non-object one', () => {
    expect(() => validateMail(undefined)).toThrowError(/mail required/);
    expect(() => validateMail(42 as unknown as typeof MAIL)).toThrowError(/mail required/);
  });

  it('rejects a missing/blank subject and a missing/blank body independently', () => {
    expect(() => validateMail({ body: 'b' } as typeof MAIL)).toThrowError(/subject required/);
    expect(() => validateMail({ subject: '   ', body: 'b' } as typeof MAIL)).toThrowError(/subject required/);
    expect(() => validateMail({ subject: 's' } as typeof MAIL)).toThrowError(/body required/);
    expect(() => validateMail({ subject: 's', body: ' \n ' } as typeof MAIL)).toThrowError(/body required/);
  });

  it('treats a missing or non-array attachments field as an empty list', () => {
    expect(validateMail({ subject: 's', body: 'b' } as typeof MAIL).attachments).toEqual([]);
    expect(validateMail({ subject: 's', body: 'b', attachments: 'coins' } as unknown as typeof MAIL).attachments)
      .toEqual([]);
  });

  it('accepts each of the three attachment kinds and rejects anything else', () => {
    const ok = validateMail({
      ...MAIL,
      attachments: [
        { kind: 'coins', count: 100 },
        { kind: 'item', id: 'potion', count: 2 },
        { kind: 'skin', id: 'gold-pen' },
      ],
    } as typeof MAIL);
    expect(ok.attachments).toHaveLength(3);
    expect(() => validateMail({ ...MAIL, attachments: [{ kind: 'coin' }] } as unknown as typeof MAIL))
      .toThrowError(/invalid attachment kind/);
  });

  it('requires an id for item and skin attachments, but not for coins', () => {
    expect(() => validateMail({ ...MAIL, attachments: [{ kind: 'item' }] } as unknown as typeof MAIL))
      .toThrowError(/item attachment requires id/);
    expect(() => validateMail({ ...MAIL, attachments: [{ kind: 'skin' }] } as unknown as typeof MAIL))
      .toThrowError(/skin attachment requires id/);
    expect(validateMail({ ...MAIL, attachments: [{ kind: 'coins' }] } as unknown as typeof MAIL).attachments)
      .toEqual([{ kind: 'coins' }]);
  });

  it('rejects a negative or non-finite attachment count, but allows count to be absent', () => {
    expect(() => validateMail({ ...MAIL, attachments: [{ kind: 'coins', count: -1 }] } as unknown as typeof MAIL))
      .toThrowError(/invalid attachment count/);
    expect(() =>
      validateMail({ ...MAIL, attachments: [{ kind: 'coins', count: Number.NaN }] } as unknown as typeof MAIL),
    ).toThrowError(/invalid attachment count/);
    expect(validateMail({ ...MAIL, attachments: [{ kind: 'coins', count: 0 }] } as unknown as typeof MAIL).attachments)
      .toEqual([{ kind: 'coins', count: 0 }]);
  });

  it('defaults expireDays to 30 unless a positive finite number was given (which it floors)', () => {
    expect(validateMail({ subject: 's', body: 'b' } as typeof MAIL).expireDays).toBe(30);
    expect(validateMail({ ...MAIL, expireDays: 0 }).expireDays).toBe(30);
    expect(validateMail({ ...MAIL, expireDays: -3 }).expireDays).toBe(30);
    expect(validateMail({ ...MAIL, expireDays: Number.NaN }).expireDays).toBe(30);
    expect(validateMail({ ...MAIL, expireDays: 7.9 }).expireDays).toBe(7);
  });

  it('trims subject and body', () => {
    expect(validateMail({ ...MAIL, subject: '  hi  ', body: '  there  ' })).toMatchObject({
      subject: 'hi',
      body: 'there',
    });
  });
});

describe('validateTarget / describeTarget', () => {
  it('requires a 9-digit publicId for scope=single — including when target is missing entirely', () => {
    expect(() => validateTarget('single', undefined)).toThrowError(/9-digit publicId/);
    expect(() => validateTarget('single', {} as never)).toThrowError(/9-digit publicId/);
    expect(() => validateTarget('single', { publicId: '12345' } as never)).toThrowError(/9-digit publicId/);
    expect(() => validateTarget('single', { publicId: 1234567 as unknown as string } as never))
      .toThrowError(/9-digit publicId/);
  });

  it('trims a valid publicId', () => {
    expect(validateTarget('single', { publicId: ' 123456789 ' } as never)).toEqual({ publicId: '123456789' });
  });

  it('ignores the caller-supplied target for scope=global and pins the phase-1 "all" filter', () => {
    expect(validateTarget('global', { publicId: '123456789' } as never)).toEqual({ filter: { kind: 'all' } });
    expect(validateTarget('global', undefined)).toEqual({ filter: { kind: 'all' } });
  });

  it('describes both target shapes for the audit summary', () => {
    expect(describeTarget({ publicId: '123456789' })).toBe('#123456789');
    expect(describeTarget({ filter: { kind: 'all' } })).toBe('filter:all');
  });
});

describe('validateRollout', () => {
  it('returns undefined for undefined and for null', () => {
    expect(validateRollout(undefined)).toBeUndefined();
    expect(validateRollout(null)).toBeUndefined();
  });

  it('rejects a non-object rollout', () => {
    expect(() => validateRollout('50%')).toThrowError(/rollout must be an object/);
    expect(() => validateRollout(50)).toThrowError(/rollout must be an object/);
  });

  it('rejects pct that is not a number, not finite, or outside 0-100 — and floors a valid one', () => {
    for (const pct of ['50', Number.NaN, Number.POSITIVE_INFINITY, -1, 101]) {
      expect(() => validateRollout({ pct })).toThrowError(/rollout\.pct must be 0-100/);
    }
    expect(validateRollout({ pct: 42.7 })).toEqual({ pct: 42 });
    expect(validateRollout({ pct: 0 })).toEqual({ pct: 0 });
    expect(validateRollout({ pct: 100 })).toEqual({ pct: 100 });
  });

  it('rejects a non-array or non-string-element list for every string[] field', () => {
    for (const field of ['regions', 'platforms', 'allowAccounts', 'denyAccounts', 'allowPublicIds']) {
      expect(() => validateRollout({ [field]: 'eu' })).toThrowError(new RegExp(`rollout\\.${field} must be string\\[\\]`));
      expect(() => validateRollout({ [field]: ['eu', 7] })).toThrowError(new RegExp(`rollout\\.${field} must be string\\[\\]`));
    }
  });

  it('drops a field whose list trims down to nothing, and returns undefined when nothing is left', () => {
    // `strArr` filters blanks after trimming, so `['', '  ']` is a present-but-empty field: the
    // `&& length` guards are what stop it being written as an empty array into the flag document.
    expect(validateRollout({ regions: ['', '  '] })).toBeUndefined();
    expect(validateRollout({ platforms: [] })).toBeUndefined();
    expect(validateRollout({ allowAccounts: [], denyAccounts: [], allowPublicIds: [] })).toBeUndefined();
    expect(validateRollout({})).toBeUndefined();
  });

  it('rejects an unknown platform and accepts the three allowlisted ones', () => {
    expect(() => validateRollout({ platforms: ['web', 'ps5'] })).toThrowError(/invalid platform: ps5/);
    expect(validateRollout({ platforms: ['web', 'wechat', 'crazygames'] })).toEqual({
      platforms: ['web', 'wechat', 'crazygames'],
    });
  });

  it('trims and keeps every populated field together', () => {
    expect(
      validateRollout({
        pct: 10,
        regions: [' eu ', ''],
        platforms: [' web '],
        allowAccounts: [' a1 '],
        denyAccounts: [' d1 '],
        allowPublicIds: [' 123456789 '],
      }),
    ).toEqual({
      pct: 10,
      regions: ['eu'],
      platforms: ['web'],
      allowAccounts: ['a1'],
      denyAccounts: ['d1'],
      allowPublicIds: ['123456789'],
    });
  });
});

describe('validateShopItemInput', () => {
  it('returns an empty patch when neither field was sent', () => {
    expect(validateShopItemInput({})).toEqual({});
  });

  it('rejects a cost that is not a positive finite number, and floors a valid one', () => {
    for (const cost of ['10', Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(() => validateShopItemInput({ cost })).toThrowError(/cost must be a positive number/);
    }
    expect(validateShopItemInput({ cost: 12.9 })).toEqual({ cost: 12 });
  });

  it('rejects a non-object effect — including null and an array, which typeof calls "object"', () => {
    expect(() => validateShopItemInput({ effect: 'coins' })).toThrowError(/effect must be an object/);
    expect(() => validateShopItemInput({ effect: null })).toThrowError(/effect must be an object/);
    expect(() => validateShopItemInput({ effect: [1, 2] })).toThrowError(/effect must be an object/);
  });

  it('keeps finite numbers and strings in effect, and rejects any other value kind', () => {
    expect(validateShopItemInput({ effect: { coins: 100, label: 'x' } })).toEqual({
      effect: { coins: 100, label: 'x' },
    });
    expect(() => validateShopItemInput({ effect: { coins: Number.NaN } })).toThrowError(
      /effect\.coins must be a number or string/,
    );
    expect(() => validateShopItemInput({ effect: { coins: true } })).toThrowError(
      /effect\.coins must be a number or string/,
    );
    expect(() => validateShopItemInput({ effect: { coins: null } })).toThrowError(
      /effect\.coins must be a number or string/,
    );
  });

  it('accepts an empty effect object', () => {
    expect(validateShopItemInput({ effect: {} })).toEqual({ effect: {} });
  });
});

describe('describeShopItem (audit before/after summary)', () => {
  const doc = (over: Partial<SlgShopItemOverrideDoc>): SlgShopItemOverrideDoc =>
    ({ _id: 'wood', ...over }) as SlgShopItemOverrideDoc;

  it('says "default" both when there is no override document and when the document overrides nothing', () => {
    expect(describeShopItem(null)).toBe('default');
    expect(describeShopItem(doc({}))).toBe('default');
  });

  it('lists cost and effect, singly and together', () => {
    expect(describeShopItem(doc({ cost: 50 }))).toBe('cost=50');
    expect(describeShopItem(doc({ effect: { wood: 10 } }))).toBe('effect={"wood":10}');
    expect(describeShopItem(doc({ cost: 50, effect: { wood: 10 } }))).toBe('cost=50,effect={"wood":10}');
  });
});

describe('describeFlag (audit before/after summary)', () => {
  const doc = (over: Partial<FeatureFlagDoc>): FeatureFlagDoc =>
    ({ _id: 'slg.enabled', enabled: true, updatedAt: 1, updatedBy: 'adm-1', ...over }) as FeatureFlagDoc;

  it('says "default" when the flag has never been overridden', () => {
    expect(describeFlag(null)).toBe('default');
  });

  it('records the on/off state, and nothing else when there is no rollout at all', () => {
    expect(describeFlag(doc({ enabled: true }))).toBe('on');
    expect(describeFlag(doc({ enabled: false }))).toBe('OFF');
  });

  it('records nothing extra for a rollout object whose fields are all absent or empty', () => {
    expect(describeFlag(doc({ rollout: {} }))).toBe('on');
    expect(
      describeFlag(doc({ rollout: { regions: [], platforms: [], allowAccounts: [], denyAccounts: [], allowPublicIds: [] } })),
    ).toBe('on');
  });

  it('records pct — including 0%, which must not be swallowed as "no pct"', () => {
    expect(describeFlag(doc({ rollout: { pct: 25 } }))).toBe('on,25%');
    expect(describeFlag(doc({ rollout: { pct: 0 } }))).toBe('on,0%');
  });

  it('spells out regions/platforms but only counts the account allow/deny lists', () => {
    expect(
      describeFlag(
        doc({
          enabled: false,
          rollout: {
            pct: 50,
            regions: ['eu', 'us'],
            platforms: ['web', 'wechat'],
            allowAccounts: ['a1', 'a2', 'a3'],
            denyAccounts: ['d1'],
            allowPublicIds: ['123456789', '987654321'],
          },
        }),
      ),
    ).toBe('OFF,50%,region=eu|us,plat=web|wechat,allow=3,deny=1,allowPid=2');
  });
});

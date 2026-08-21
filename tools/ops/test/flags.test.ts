// src/logic/flags.ts — parseList — turns a comma/newline-separated textarea value into a trimmed,
// non-empty string array (used for feature-flag allow/deny lists & region/platform targeting).
// pageFlags() itself builds DOM and stays untested.
import { describe, it, expect } from 'vitest';
import {
  buildRollout, FLAG_PLATFORMS, flagMetaText, flagUpsertInput, isClientLogFlag, parseList,
  platformChecked, rolloutInputs,
} from '../src/logic/flags';
import type { FeatureFlagDoc, FeatureFlagRow } from '../src/types';

describe('parseList', () => {
  it('splits on commas', () => {
    expect(parseList('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('splits on newlines', () => {
    expect(parseList('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('splits on a mix of commas and newlines', () => {
    expect(parseList('a,b\nc, d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('trims whitespace around each entry', () => {
    expect(parseList('  a  , b ,c  ')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty entries from blank lines / trailing separators', () => {
    expect(parseList('a,,b,\n\n,c,')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList('   \n  ,  ')).toEqual([]);
  });
});

const stamp = (ms: number): string => `T${ms}`;
/** Built rather than written as an escape, so the multi-line cases read the same on both checkouts. */
const NL = String.fromCharCode(10);
const blankFields = { pct: '', regions: '', platforms: [], allowAccounts: '', denyAccounts: '', allowPublicIds: '' };

describe('FLAG_PLATFORMS', () => {
  it('lists the three client platforms', () => {
    expect(FLAG_PLATFORMS).toEqual(['web', 'wechat', 'crazygames']);
  });
});

describe('buildRollout', () => {
  it('is empty when nothing is targeted — absent means "no targeting", NOT "targets nobody"', () => {
    expect(buildRollout(blankFields)).toEqual({});
  });

  it('includes only the dimensions that were filled in', () => {
    expect(buildRollout({ ...blankFields, regions: 'eu, us' })).toEqual({ regions: ['eu', 'us'] });
    expect(buildRollout({ ...blankFields, platforms: ['web'] })).toEqual({ platforms: ['web'] });
    expect(buildRollout({ ...blankFields, allowAccounts: ['acc-1', 'acc-2'].join(NL) })).toEqual({ allowAccounts: ['acc-1', 'acc-2'] });
    expect(buildRollout({ ...blankFields, denyAccounts: 'acc-3' })).toEqual({ denyAccounts: ['acc-3'] });
    expect(buildRollout({ ...blankFields, allowPublicIds: '123456789' })).toEqual({ allowPublicIds: ['123456789'] });
  });

  it('drops a list whose entries were all blank', () => {
    expect(buildRollout({ ...blankFields, regions: ' , , ' })).toEqual({});
  });

  it('keeps a rollout of 0 — that is "off for everyone not on the allow list", a real setting', () => {
    expect(buildRollout({ ...blankFields, pct: '0' })).toEqual({ pct: 0 });
  });

  it('clamps a percentage into 0..100 rather than refusing to save the rest of the form', () => {
    expect(buildRollout({ ...blankFields, pct: '150' })).toEqual({ pct: 100 });
    expect(buildRollout({ ...blankFields, pct: '-20' })).toEqual({ pct: 0 });
  });

  it('omits a blank percentage field', () => {
    expect(buildRollout({ ...blankFields, pct: '   ' })).toEqual({});
  });

  it('copies the platform list rather than aliasing the caller’s array', () => {
    const platforms: ('web' | 'wechat' | 'crazygames')[] = ['web'];
    const out = buildRollout({ ...blankFields, platforms });
    platforms.push('wechat');
    expect(out.platforms).toEqual(['web']);
  });

  it('builds every dimension at once', () => {
    expect(buildRollout({
      pct: '25', regions: 'eu', platforms: ['web', 'wechat'],
      allowAccounts: 'a', denyAccounts: 'b', allowPublicIds: '1',
    })).toEqual({
      pct: 25, regions: ['eu'], platforms: ['web', 'wechat'],
      allowAccounts: ['a'], denyAccounts: ['b'], allowPublicIds: ['1'],
    });
  });
});

describe('flagUpsertInput', () => {
  it('omits an all-empty rollout so an untargeted flag stores no rollout key', () => {
    expect(flagUpsertInput({ desc: '' }, true, {})).toEqual({ enabled: true });
  });

  it('includes a non-empty rollout and preserves the registered description', () => {
    expect(flagUpsertInput({ desc: 'ink trails' }, false, { pct: 10 }))
      .toEqual({ enabled: false, rollout: { pct: 10 }, desc: 'ink trails' });
  });

  it('omits an empty description', () => {
    expect(flagUpsertInput({ desc: '' }, true, { pct: 5 })).toEqual({ enabled: true, rollout: { pct: 5 } });
  });
});

describe('rolloutInputs', () => {
  it('is all blank for a flag that was never overridden', () => {
    expect(rolloutInputs({})).toEqual({ pct: '', regions: '', allowAccounts: '', denyAccounts: '', allowPublicIds: '' });
  });

  it('renders a stored rollout back into the seven controls', () => {
    expect(rolloutInputs({ pct: 0, regions: ['eu', 'us'], allowAccounts: ['a', 'b'] })).toEqual({
      pct: '0', regions: 'eu, us', allowAccounts: ['a', 'b'].join(NL), denyAccounts: '', allowPublicIds: '',
    });
  });

  it('round-trips through buildRollout', () => {
    const rollout = { pct: 25, regions: ['eu'], allowAccounts: ['a'], denyAccounts: ['b'], allowPublicIds: ['1'] };
    const i = rolloutInputs(rollout);
    expect(buildRollout({ ...i, platforms: [] })).toEqual(rollout);
  });
});

describe('platformChecked', () => {
  it('is false for a flag with no platform targeting (i.e. all platforms)', () => {
    expect(platformChecked({}, 'web')).toBe(false);
  });

  it('is true only for the listed platforms', () => {
    expect(platformChecked({ platforms: ['web'] }, 'web')).toBe(true);
    expect(platformChecked({ platforms: ['web'] }, 'wechat')).toBe(false);
  });
});

describe('flagMetaText', () => {
  const row = (over: Partial<FeatureFlagRow> = {}): FeatureFlagRow =>
    ({ key: 'ink_trails', side: 'client', desc: 'd', default: false, doc: null, ...over });
  const doc = (updatedBy: string): FeatureFlagDoc =>
    ({ _id: 'ink_trails', enabled: true, updatedBy, updatedAt: 7 });

  it('attributes an override, stamped through the formatter it was handed', () => {
    expect(flagMetaText(row({ doc: doc('Ada') }), stamp)).toBe('Last modified: Ada · T7');
  });

  it('dashes a nameless writer', () => {
    expect(flagMetaText(row({ doc: doc('') }), stamp)).toBe('Last modified: — · T7');
  });

  it('reports the code default when there is no override, in words not booleans', () => {
    expect(flagMetaText(row({ default: true }), stamp)).toBe('Not overridden, using default (on)');
    expect(flagMetaText(row({ default: false }), stamp)).toBe('Not overridden, using default (off)');
  });
});

describe('isClientLogFlag', () => {
  it('recognises the client log-level family, which gets the single-player how-to note', () => {
    expect(isClientLogFlag('client_log_debug')).toBe(true);
    expect(isClientLogFlag('client_log_')).toBe(true);
  });

  it('does not match anything else', () => {
    expect(isClientLogFlag('ink_trails')).toBe(false);
    expect(isClientLogFlag('server_client_log_x')).toBe(false);
  });
});

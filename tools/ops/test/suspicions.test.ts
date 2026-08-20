// suspicions.ts's pure helpers. `fmtStats` renders a statKey→count map for the review table's
// pvp_overclaim detail column; the rest belong to the two read-only signal sections restored on
// 2026-08-20 (C3 mismatches, C4 suspicious-PvE roster). pageSuspicions() itself builds DOM, untested —
// same split as promo.test.ts / feedback.test.ts.
import { describe, it, expect } from 'vitest';
import { fmtStats, mismatchPlayerLabel, mismatchRepeats, pveWarningLevel } from '../src/pages/suspicions';
import type { MismatchView } from '../src/types';

describe('fmtStats', () => {
  it('returns an em dash for undefined', () => {
    expect(fmtStats(undefined)).toBe('—');
  });

  it('returns an em dash for an empty map', () => {
    expect(fmtStats({})).toBe('—');
  });

  it('formats a single entry as key:count', () => {
    expect(fmtStats({ kills: 3 })).toBe('kills:3');
  });

  it('joins multiple entries with ", " in key insertion order', () => {
    expect(fmtStats({ kills: 3, deaths: 1, assists: 0 })).toBe('kills:3, deaths:1, assists:0');
  });
});

type Player = MismatchView['players'][number];
const row = (players: Player[], over: Partial<MismatchView> = {}): MismatchView => ({
  roomId: 'r1', mode: 'ranked', reason: 'mismatch', ts: 1, players, ...over,
});

describe('mismatchPlayerLabel', () => {
  it('pairs the name with the publicId when the archive snapshotted both', () => {
    expect(mismatchPlayerLabel({ accountId: 'acc-1', displayName: 'Alice', publicId: '123456789' })).toBe('Alice #123456789');
  });

  it('shows the publicId alone when no name was snapshotted', () => {
    expect(mismatchPlayerLabel({ accountId: 'acc-1', publicId: '123456789' })).toBe('#123456789');
  });

  it('falls back to the name when there is no publicId', () => {
    expect(mismatchPlayerLabel({ accountId: 'acc-2', displayName: 'Bob' })).toBe('Bob');
  });

  it('falls back to the raw accountId when the row carries neither (pre-snapshot match)', () => {
    expect(mismatchPlayerLabel({ accountId: 'acc-2' })).toBe('acc-2');
  });
});

describe('mismatchRepeats', () => {
  const alice: Player = { side: 0, accountId: 'acc-a', displayName: 'Alice', publicId: '111111111' };
  const bob: Player = { side: 1, accountId: 'acc-b', displayName: 'Bob', publicId: '222222222' };
  const carol: Player = { side: 1, accountId: 'acc-c', displayName: 'Carol', publicId: '333333333' };

  it('returns nothing for an empty list', () => {
    expect(mismatchRepeats([])).toEqual([]);
  });

  it('returns nothing when every account appears in exactly one match', () => {
    expect(mismatchRepeats([row([alice, bob]), row([carol, { side: 0, accountId: 'acc-d' }])])).toEqual([]);
  });

  it('reports only the accounts that appear in more than one match', () => {
    // Alice is in both; Bob and Carol are in one each.
    expect(mismatchRepeats([row([alice, bob]), row([alice, carol], { roomId: 'r2' })])).toEqual([
      { accountId: 'acc-a', label: 'Alice #111111111', count: 2 },
    ]);
  });

  it('orders by count desc, then by label so equal counts do not shuffle between reloads', () => {
    const rows = [
      row([alice, bob]),
      row([alice, bob], { roomId: 'r2' }),
      row([alice, carol], { roomId: 'r3' }),
    ];
    expect(mismatchRepeats(rows).map((r) => [r.label, r.count])).toEqual([
      ['Alice #111111111', 3],
      ['Bob #222222222', 2],
    ]);
  });

  it('counts a duplicated accountId within one match once — a desynced room is one event, not two', () => {
    expect(mismatchRepeats([row([alice, { ...alice, side: 1 }])])).toEqual([]);
  });

  // `players` really can arrive empty: meta projects MatchDoc.players verbatim and does not require it
  // to be populated (its own /internal/mismatches fixtures use `players: []`). Must not throw — an
  // unreadable row is still a row the operator should see in the table.
  it('skips rows with no players instead of throwing', () => {
    expect(mismatchRepeats([row([]), row([], { roomId: 'r2' })])).toEqual([]);
    expect(mismatchRepeats([row([]), row([alice, bob]), row([alice, bob], { roomId: 'r2' })])).toEqual([
      { accountId: 'acc-a', label: 'Alice #111111111', count: 2 },
      { accountId: 'acc-b', label: 'Bob #222222222', count: 2 },
    ]);
  });

  // Rows arrive newest-first from meta, and displayName is a per-match snapshot — so a player who
  // renamed between two mismatches has two different labels on the wire. Take the newest, or the summary
  // line would name someone by a name they no longer use while the table below shows the current one.
  it('labels a repeat offender from the newest row when the name snapshot changed between matches', () => {
    const renamed: Player = { ...alice, displayName: 'Alicia' };
    expect(mismatchRepeats([row([renamed, bob]), row([alice, carol], { roomId: 'r2' })])[0]).toEqual({
      accountId: 'acc-a', label: 'Alicia #111111111', count: 2,
    });
  });
});

describe('pveWarningLevel', () => {
  // Mirrors PVE_REJECT_BAN_THRESHOLD = 3, the count at which meta stamps severity:'high' on the review
  // record — if this drifts, the roster and the queue above disagree about who the repeat offenders are.
  it('treats counts below the threshold as normal', () => {
    expect(pveWarningLevel(0)).toBe('normal');
    expect(pveWarningLevel(1)).toBe('normal');
    expect(pveWarningLevel(2)).toBe('normal');
  });

  it('escalates at the threshold and stays there above it', () => {
    expect(pveWarningLevel(3)).toBe('high');
    expect(pveWarningLevel(12)).toBe('high');
  });
});

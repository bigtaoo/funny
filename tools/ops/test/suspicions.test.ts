// src/logic/suspicions.ts — the anti-cheat page's pure helpers. `fmtStats` renders a statKey→count map for the review table's
// pvp_overclaim detail column; the rest belong to the two read-only signal sections restored on
// 2026-08-20 (C3 mismatches, C4 suspicious-PvE roster). pageSuspicions() itself builds DOM, untested —
// same split as promo.test.ts / feedback.test.ts.
import { describe, it, expect } from 'vitest';
import {
  banConfirm, canResolveReview, fmtStats, mismatchPlayerLabel, mismatchPlayersText, mismatchRepeats,
  PVE_WARNING_HIGH, pveStatus, pveWarningLevel, repeatsText, reviewDetail, reviewKind, reviewKindPill,
  reviewPlayerLabel, reviewQuery, reviewResolvedByText, reviewResolveMessage, reviewStatusPills,
  suspiciousPveLabel,
} from '../src/logic/suspicions';
import type { AntiCheatReviewView, MismatchView } from '../src/types';

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

const review = (over: Partial<AntiCheatReviewView> = {}): AntiCheatReviewView => ({
  _id: 'r1', accountId: 'acc-1', status: 'open', ts: 1, ...over,
} as AntiCheatReviewView);

describe('reviewKind', () => {
  it('reads a row with no kind as a PvP overclaim — that predates the field', () => {
    expect(reviewKind({})).toBe('pvp_overclaim');
  });

  it('passes an explicit kind through', () => {
    expect(reviewKind({ kind: 'pve_reject' })).toBe('pve_reject');
    expect(reviewKind({ kind: 'coin_anomaly' })).toBe('coin_anomaly');
  });
});

describe('reviewDetail', () => {
  it('compares claimed and judged stars for a PvE reject', () => {
    expect(reviewDetail(review({
      kind: 'pve_reject', levelId: 'w2-3', claimedStars: 3, judgedStars: 1, rejectCountAfter: 2,
    }))).toBe('w2-3: claimed 3★, judged 1★ (reject #2)');
  });

  it('compares the day gain against its threshold for a coin anomaly', () => {
    expect(reviewDetail(review({
      kind: 'coin_anomaly', dayKey: '2026-08-13', nonRechargeGain: 9000, threshold: 5000,
    }))).toBe('2026-08-13: gained 9000 non-recharge coins (threshold 5000)');
  });

  it('dumps the four disputed stat maps for a PvP overclaim', () => {
    expect(reviewDetail(review({
      roomId: 'room-9', side: 0, reported: { kills: 5 }, authoritative: { kills: 3 },
      overclaim: { kills: 2 }, rolledBack: {}, suspicionAfter: 12,
    }))).toBe('room-9 (side 0) reported kills:5 / auth kills:3 / overclaim kills:2 / rolled back — / suspicion 12');
  });

  it('dashes every field a record did not carry rather than printing undefined', () => {
    expect(reviewDetail(review({ kind: 'pve_reject' }))).toBe('—: claimed —★, judged —★ (reject #—)');
    expect(reviewDetail(review({ kind: 'coin_anomaly' }))).toBe('—: gained — non-recharge coins (threshold —)');
    expect(reviewDetail(review())).toContain('— (side —)');
  });
});

describe('reviewKindPill', () => {
  it('marks a high-severity PvE reject red and an ordinary one amber', () => {
    expect(reviewKindPill(review({ kind: 'pve_reject', severity: 'high' }))).toEqual({ label: 'PvE', cls: 'failed' });
    expect(reviewKindPill(review({ kind: 'pve_reject' }))).toEqual({ label: 'PvE', cls: 'warn' });
  });

  it('marks a coin anomaly amber', () => {
    expect(reviewKindPill(review({ kind: 'coin_anomaly' }))).toEqual({ label: 'Coin', cls: 'warn' });
  });

  it('gives a PvP overclaim no pill — the page prints plain text for those', () => {
    expect(reviewKindPill(review())).toBeNull();
  });
});

describe('reviewStatusPills', () => {
  it('shows just the amber status while open', () => {
    expect(reviewStatusPills({ status: 'open' })).toEqual([{ label: 'open', cls: 'warn' }]);
  });

  it('adds the resolution alongside once reviewed, red for a ban', () => {
    expect(reviewStatusPills({ status: 'reviewed', resolution: 'banned' })).toEqual([
      { label: 'reviewed', cls: 'ok' }, { label: 'banned', cls: 'failed' },
    ]);
    expect(reviewStatusPills({ status: 'reviewed', resolution: 'dismissed' })).toEqual([
      { label: 'reviewed', cls: 'ok' }, { label: 'dismissed', cls: 'ok' },
    ]);
  });

  it('shows no resolution pill for a reviewed record that carries none', () => {
    expect(reviewStatusPills({ status: 'reviewed' })).toHaveLength(1);
  });
});

describe('review queue gating and messages', () => {
  it('resolves only an open record, and only with anticheat.action', () => {
    expect(canResolveReview(true, 'open')).toBe(true);
    expect(canResolveReview(false, 'open')).toBe(false);
    expect(canResolveReview(true, 'reviewed')).toBe(false);
  });

  it('attributes a reviewed record, and says nothing for an open one', () => {
    expect(reviewResolvedByText({ status: 'reviewed', resolvedBy: 'Ada' })).toBe('by Ada');
    expect(reviewResolvedByText({ status: 'open', resolvedBy: 'Ada' })).toBeNull();
    expect(reviewResolvedByText({ status: 'reviewed' })).toBeNull();
  });

  it('confirms a ban by accountId and reports either verdict', () => {
    expect(banConfirm('acc-1')).toBe('Ban accountId acc-1?');
    expect(reviewResolveMessage('banned')).toBe('Banned.');
    expect(reviewResolveMessage('dismissed')).toBe('Dismissed.');
  });

  it('names the player by publicId where there is one', () => {
    expect(reviewPlayerLabel({ publicId: '123456789', accountId: 'acc-1' })).toBe('#123456789');
    expect(reviewPlayerLabel({ accountId: 'acc-1' })).toBe('acc-1');
  });
});

describe('reviewQuery', () => {
  it('always sends the status and limit', () => {
    expect(reviewQuery('', 'open', 100)).toEqual({ status: 'open', limit: 100 });
  });

  it('adds a trimmed accountId only when the operator typed one', () => {
    expect(reviewQuery('  acc-1  ', 'all', 50)).toEqual({ accountId: 'acc-1', status: 'all', limit: 50 });
    expect(reviewQuery('   ', 'all', 50)).toEqual({ status: 'all', limit: 50 });
  });
});

describe('repeatsText', () => {
  it('lists each repeat offender with its count', () => {
    expect(repeatsText([{ label: '#1 Ada', count: 3 }, { label: '#2', count: 2 }])).toBe('#1 Ada ×3, #2 ×2');
  });

  it('is empty when nobody repeats — the page then renders no summary line', () => {
    expect(repeatsText([])).toBe('');
  });
});

describe('mismatchPlayersText', () => {
  it('orders the two sides so the same match always reads the same way round', () => {
    const m = { players: [
      { accountId: 'b', side: 1, publicId: '2' },
      { accountId: 'a', side: 0, publicId: '1' },
    ] } as Pick<MismatchView, 'players'>;
    expect(mismatchPlayersText(m)).toBe('#1 vs #2');
  });

  it('does not reorder the caller array', () => {
    const players = [
      { accountId: 'b', side: 1, publicId: '2' },
      { accountId: 'a', side: 0, publicId: '1' },
    ];
    mismatchPlayersText({ players } as Pick<MismatchView, 'players'>);
    expect(players[0]!.accountId).toBe('b');
  });

  it('dashes a match that snapshotted no players', () => {
    expect(mismatchPlayersText({ players: [] } as Pick<MismatchView, 'players'>)).toBe('—');
  });
});

describe('suspiciousPveLabel', () => {
  it('shows name and publicId together when both are known', () => {
    expect(suspiciousPveLabel({ _id: 'acc-1', displayName: 'Ada', publicId: '123456789' })).toBe('Ada #123456789');
  });

  it('shows the name alone when there is no publicId, with no trailing space', () => {
    expect(suspiciousPveLabel({ _id: 'acc-1', displayName: 'Ada' })).toBe('Ada');
  });

  it('falls back to publicId, then to the raw accountId', () => {
    expect(suspiciousPveLabel({ _id: 'acc-1', publicId: '123456789' })).toBe('#123456789');
    expect(suspiciousPveLabel({ _id: 'acc-1' })).toBe('acc-1');
  });
});

describe('pveStatus and the high-severity threshold', () => {
  it('mirrors meta severity rule at the documented count', () => {
    expect(PVE_WARNING_HIGH).toBe(3);
    expect(pveWarningLevel(PVE_WARNING_HIGH)).toBe('high');
    expect(pveWarningLevel(PVE_WARNING_HIGH - 1)).toBe('normal');
  });

  it('reads a ban state into a pill', () => {
    expect(pveStatus(true)).toEqual({ label: 'banned', cls: 'failed' });
    expect(pveStatus(false)).toEqual({ label: 'active', cls: 'ok' });
    expect(pveStatus(undefined)).toEqual({ label: 'active', cls: 'ok' });
  });
});

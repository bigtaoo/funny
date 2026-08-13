// appeals.ts's enforcement-snapshot formatter (CM10/CM11 appeal review queue's per-row summary
// of what was active against the account when the appeal was filed). pageAppeals() builds DOM
// and stays untested. Timestamp fields are formatted through toLocaleString() same as the
// source, so this doesn't assert a hardcoded timezone-dependent literal.
import { describe, it, expect } from 'vitest';
import { fmtSnapshot } from '../src/pages/appeals';
import type { AppealView } from '../src/types';

type Snapshot = AppealView['enforcementSnapshot'];

describe('fmtSnapshot', () => {
  it('returns an em dash when nothing was active', () => {
    expect(fmtSnapshot({})).toBe('—');
  });

  it('reports a permanent ban', () => {
    expect(fmtSnapshot({ banned: true })).toBe('banned (permanent)');
  });

  it('reports a temp-ban with its expiry, human-formatted', () => {
    const bannedUntil = new Date(2026, 8, 1, 10, 0).getTime();
    const s: Snapshot = { bannedUntil };
    expect(fmtSnapshot(s)).toBe(`temp-banned until ${new Date(bannedUntil).toLocaleString()}`);
  });

  it('reports a mute with its expiry, human-formatted', () => {
    const mutedUntil = new Date(2026, 8, 2, 9, 30).getTime();
    const s: Snapshot = { mutedUntil };
    expect(fmtSnapshot(s)).toBe(`muted until ${new Date(mutedUntil).toLocaleString()}`);
  });

  it('reports a reputation score of 0 (falsy but present)', () => {
    expect(fmtSnapshot({ reputationScore: 0 })).toBe('score 0');
  });

  it('joins every present field with ", " in a fixed order', () => {
    const bannedUntil = new Date(2026, 8, 1, 10, 0).getTime();
    const mutedUntil = new Date(2026, 8, 2, 9, 30).getTime();
    const s: Snapshot = { banned: true, bannedUntil, mutedUntil, reputationScore: 42 };
    expect(fmtSnapshot(s)).toBe(
      `banned (permanent), temp-banned until ${new Date(bannedUntil).toLocaleString()}, ` +
      `muted until ${new Date(mutedUntil).toLocaleString()}, score 42`,
    );
  });
});

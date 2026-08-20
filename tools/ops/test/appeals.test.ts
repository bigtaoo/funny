// src/logic/appeals.ts — the appeal queue's enforcement-snapshot formatter (CM10/CM11 appeal review queue's per-row summary
// of what was active against the account when the appeal was filed). pageAppeals() builds DOM
// and stays untested. Timestamp fields are formatted through toLocaleString() same as the
// source, so this doesn't assert a hardcoded timezone-dependent literal.
import { describe, it, expect } from 'vitest';
import {
  appealPlayerLabel, appealResolvedByText, appealResolveMessage, appealStatusCls, approveConfirm,
  canResolveAppeal, fmtSnapshot,
} from '../src/logic/appeals';
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

describe('appealStatusCls', () => {
  it('flags an open appeal as needing attention', () => {
    expect(appealStatusCls('open')).toBe('warn');
  });

  it('marks approved GREEN and denied red — the opposite polarity from the report queue’s upheld', () => {
    expect(appealStatusCls('approved')).toBe('ok');
    expect(appealStatusCls('denied')).toBe('failed');
  });
});

describe('canResolveAppeal', () => {
  it('needs both appeals.action and an open appeal', () => {
    expect(canResolveAppeal(true, 'open')).toBe(true);
    expect(canResolveAppeal(false, 'open')).toBe(false);
    expect(canResolveAppeal(true, 'approved')).toBe(false);
  });
});

describe('approveConfirm', () => {
  it('names the account and the one thing approving does NOT do', () => {
    const text = approveConfirm('acc-1');
    expect(text).toContain('acc-1');
    expect(text).toContain("Clears the account's active mute/temp-ban/ban");
    expect(text).toContain('reputation score is not restored');
  });
});

describe('appealResolveMessage', () => {
  it('reports either verdict', () => {
    expect(appealResolveMessage('approved')).toBe('Approved.');
    expect(appealResolveMessage('denied')).toBe('Denied.');
  });
});

describe('appealPlayerLabel', () => {
  it('prefers the publicId support can quote back to the player', () => {
    expect(appealPlayerLabel({ publicId: '123456789', accountId: 'acc-1' })).toBe('#123456789');
  });

  it('falls back to the accountId when the appeal predates public ids', () => {
    expect(appealPlayerLabel({ accountId: 'acc-1' })).toBe('acc-1');
  });
});

describe('appealResolvedByText', () => {
  it('attributes a resolved appeal', () => {
    expect(appealResolvedByText({ status: 'denied', resolvedBy: 'Ada' })).toBe('by Ada');
  });

  it('says nothing for an open appeal or an unattributed resolution', () => {
    expect(appealResolvedByText({ status: 'open', resolvedBy: 'Ada' })).toBeNull();
    expect(appealResolvedByText({ status: 'approved' })).toBeNull();
  });
});

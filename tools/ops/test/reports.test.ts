// src/logic/reports.ts — the UGC report queue's status colours, gating and post-resolve wording.
import { describe, expect, it } from 'vitest';
import {
  canResolveReport, reportStatusCls, resolvedByText, resolveMessage, upholdConfirm,
} from '../src/logic/reports';

describe('reportStatusCls', () => {
  it('flags an open report as needing attention', () => {
    expect(reportStatusCls('open')).toBe('warn');
  });

  it('marks an upheld report red (a penalty was applied) and a dismissed one green', () => {
    expect(reportStatusCls('upheld')).toBe('failed');
    expect(reportStatusCls('dismissed')).toBe('ok');
  });
});

describe('canResolveReport', () => {
  it('needs both the capability and an open report', () => {
    expect(canResolveReport(true, 'open')).toBe(true);
    expect(canResolveReport(false, 'open')).toBe(false);
    expect(canResolveReport(true, 'upheld')).toBe(false);
    expect(canResolveReport(true, 'dismissed')).toBe(false);
  });
});

describe('upholdConfirm', () => {
  it('names the target and the consequence, including that it may escalate', () => {
    const text = upholdConfirm('acc-1');
    expect(text).toContain('acc-1');
    expect(text).toContain('20 reputation points');
    expect(text).toContain('mute/ban');
  });
});

describe('resolveMessage', () => {
  it('echoes the resulting score and the enforcement action after upholding', () => {
    expect(resolveMessage('upheld', { reputationScore: 60, action: 'mute' })).toBe('Upheld → score 60 (mute).');
  });

  it('reports a score of 0 rather than mistaking it for missing', () => {
    expect(resolveMessage('upheld', { reputationScore: 0, action: 'ban' })).toBe('Upheld → score 0 (ban).');
  });

  it('falls back when the backend reported neither', () => {
    expect(resolveMessage('upheld', {})).toBe('Upheld → score — (none).');
  });

  it('says only "Dismissed." when nothing was applied', () => {
    expect(resolveMessage('dismissed', { reputationScore: 60 })).toBe('Dismissed.');
  });
});

describe('resolvedByText', () => {
  it('attributes a resolved report', () => {
    expect(resolvedByText({ status: 'upheld', resolvedBy: 'Ada' })).toBe('by Ada');
  });

  it('says nothing for an open report, even one carrying a stale resolvedBy', () => {
    expect(resolvedByText({ status: 'open', resolvedBy: 'Ada' })).toBeNull();
  });

  it('says nothing when a resolved report has no attribution', () => {
    expect(resolvedByText({ status: 'dismissed' })).toBeNull();
  });
});

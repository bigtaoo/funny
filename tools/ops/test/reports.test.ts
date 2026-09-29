// src/logic/reports.ts — the UGC report queue's status colours, gating and post-resolve wording.
import { describe, expect, it } from 'vitest';
import {
  canDeleteReportContent, canResolveReport, purgeConfirm, purgeMessage, reportContentText, reportKindText,
  reportStatusCls, resolvedByText, resolveMessage, upholdConfirm,
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

// App Store Review Guideline 1.2 additions: category/channel/snapshot display + removal gating.
describe('reportKindText', () => {
  it('distinguishes a block-filed row from an explicit report and appends the category', () => {
    expect(reportKindText({})).toBe('Report');
    expect(reportKindText({ source: 'block' })).toBe('Block');
    expect(reportKindText({ source: 'report', category: 'harassment' })).toBe('Report · harassment');
  });
});

describe('reportContentText', () => {
  it('shows channel + snapshot, and flags a snapshot that only the client vouched for', () => {
    expect(reportContentText({})).toBe('—');
    expect(reportContentText({ contentRef: { kind: 'content', channel: 'dm', messageId: 'm1', snapshot: 'hi', snapshotSource: 'server' } }))
      .toBe('dm: "hi"');
    expect(reportContentText({ contentRef: { kind: 'content', channel: 'world', snapshot: 'spam', snapshotSource: 'client' } }))
      .toBe('world: "spam" (client snapshot)');
    expect(reportContentText({ contentRef: { kind: 'content', channel: 'sect' } })).toBe('sect');
    expect(reportContentText({ contentRef: { kind: 'name', snapshot: 'BadName' } })).toBe('name: BadName');
  });
});

describe('canDeleteReportContent', () => {
  it('needs reports.action and one removable thing: a chat message id, or a family announcement', () => {
    const dm = { contentRef: { kind: 'content' as const, channel: 'dm', messageId: 'm1' } };
    expect(canDeleteReportContent(true, dm)).toBe(true);
    expect(canDeleteReportContent(false, dm)).toBe(false);
    expect(canDeleteReportContent(true, { contentRef: { kind: 'content', channel: 'world' } })).toBe(false); // no id
    expect(canDeleteReportContent(true, { contentRef: { kind: 'content', channel: 'announcement' } })).toBe(true);
    expect(canDeleteReportContent(true, { contentRef: { kind: 'content', channel: 'name', messageId: 'x' } })).toBe(false);
    expect(canDeleteReportContent(true, {})).toBe(false);
  });
});

describe('purgeConfirm / purgeMessage', () => {
  it('names the account and says it is irreversible', () => {
    expect(purgeConfirm('acc-9')).toContain('acc-9');
    expect(purgeConfirm('acc-9')).toContain('cannot be undone');
  });

  it('summarises each backend and names a failed half so it can be retried', () => {
    expect(purgeMessage({ social: { dmMessages: 2, familyMessages: 1 }, world: { worldMessages: 0, sectMessages: 3 } }))
      .toBe('social: dmMessages=2, familyMessages=1; world: worldMessages=0, sectMessages=3');
    expect(purgeMessage({ social: { dmMessages: 0 }, world: { error: 'worldsvc not configured' } }))
      .toBe('social: dmMessages=0; world: FAILED (worldsvc not configured)');
  });
});

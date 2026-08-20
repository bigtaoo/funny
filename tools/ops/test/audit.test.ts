// src/logic/audit.ts — the audit log's query builder and row cells.
//
// The two behaviours worth pinning: the actor field is gated on the capability (not merely hidden in
// the DOM), and the `to` date covers the whole selected day — picking one date twice must return that
// day's entries rather than nothing.
import { describe, expect, it } from 'vitest';
import { auditCells, auditQuery } from '../src/logic/audit';
import type { AuditEntryView } from '../src/types';

const DAY = 24 * 3600 * 1000;
const blank = { canAll: true, actor: '', from: '', to: '' };

describe('auditQuery', () => {
  it('sends nothing at all when no field is filled — the backend then scopes to the caller', () => {
    expect(auditQuery(blank)).toEqual({});
  });

  it('includes a trimmed actor for an operator who may query others', () => {
    expect(auditQuery({ ...blank, actor: '  adm-1  ' })).toEqual({ actor: 'adm-1' });
  });

  it('drops the actor for an operator who may only see their own actions', () => {
    // The input is not even rendered without audit.view.all; re-checking here means a stale value
    // in a hidden field cannot widen the query.
    expect(auditQuery({ ...blank, canAll: false, actor: 'adm-2' })).toEqual({});
  });

  it('treats a whitespace-only actor as blank rather than sending an empty filter', () => {
    expect(auditQuery({ ...blank, actor: '   ' })).toEqual({});
  });

  it('parses the from date as its midnight', () => {
    expect(auditQuery({ ...blank, from: '2026-08-13' })).toEqual({ from: Date.parse('2026-08-13') });
  });

  it('pushes the to date to the END of the selected day, so a single day is inclusive', () => {
    const q = auditQuery({ ...blank, from: '2026-08-13', to: '2026-08-13' });
    expect(q.to! - q.from!).toBe(DAY);
  });

  it('omits an unparseable date instead of sending NaN', () => {
    expect(auditQuery({ ...blank, from: 'not-a-date', to: 'nope' })).toEqual({});
  });
});

describe('auditCells', () => {
  const base: AuditEntryView = { id: 'e1', actor: 'adm-0123456789', action: 'comp.approve', ts: 1 };

  it('names the operator, shortening a bare id', () => {
    expect(auditCells(base).operator).toBe('adm-0123');
    expect(auditCells({ ...base, actorName: 'Ada' }).operator).toBe('Ada');
  });

  it('reads absent target/summary/ip as em dashes rather than "undefined"', () => {
    expect(auditCells(base)).toEqual({
      operator: 'adm-0123', action: 'comp.approve', target: '—', summary: '—', ip: '—',
    });
  });

  it('passes through everything the entry does carry', () => {
    expect(auditCells({ ...base, target: 'tk-1', summary: '500 coins', ip: '10.0.0.1' })).toMatchObject({
      target: 'tk-1', summary: '500 coins', ip: '10.0.0.1',
    });
  });
});

// src/logic/serverRetention.ts — the consent-free server retention card's percentages and empty cells.
import { describe, expect, it } from 'vitest';
import {
  SERVER_RETENTION_DAY_CHOICES, SERVER_RETENTION_HEADERS, serverRetentionRows,
} from '../src/logic/serverRetention';
import type { ServerRetentionCohort } from '../src/types';

const cohort = (over: Partial<ServerRetentionCohort> = {}): ServerRetentionCohort => ({
  date: '2026-10-01',
  signups: 8,
  tutorialDone: 6,
  cleared: { ch1_lv1: 4, ch1_lv2: 2, ch1_lv3: 1 },
  retained: { d1: 4, d3: 2, d7: null, d14: null, d30: null },
  ...over,
});

describe('serverRetentionRows', () => {
  it('one cell per header, each a % of signups with the raw count on hover', () => {
    const [row] = serverRetentionRows([cohort()]);
    expect(row!.date).toBe('2026-10-01');
    expect(row!.signups).toBe(8);
    expect(row!.cells).toHaveLength(SERVER_RETENTION_HEADERS.length);
    expect(row!.cells.map((c) => c.text)).toEqual(['75.0%', '50.0%', '25.0%', '12.5%', '50.0%', '25.0%', '—', '—', '—']);
    expect(row!.cells[0]!.title).toBe('6 of 8');
    expect(row!.cells[6]!.title).toBe('not final yet (cohort too young)');
  });

  it('a cohort without signups shows — rather than 0% or NaN', () => {
    const [row] = serverRetentionRows([cohort({
      signups: 0, tutorialDone: 0, cleared: { ch1_lv1: 0, ch1_lv2: 0, ch1_lv3: 0 },
      retained: { d1: 0, d3: 0, d7: 0, d14: 0, d30: null },
    })]);
    expect(row!.cells.every((c) => c.text === '—')).toBe(true);
    expect(row!.cells[0]!.title).toBe('no signups');
    expect(row!.cells[8]!.title).toBe('not final yet (cohort too young)');
  });

  it('keeps the server order (newest first)', () => {
    const rows = serverRetentionRows([cohort({ date: '2026-10-02' }), cohort({ date: '2026-10-01' })]);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-02', '2026-10-01']);
    expect(serverRetentionRows([])).toEqual([]);
  });

  it('headers and day choices', () => {
    expect(SERVER_RETENTION_HEADERS).toEqual(['Tutorial', 'ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'D1', 'D3', 'D7', 'D14', 'D30']);
    expect(Math.max(...SERVER_RETENTION_DAY_CHOICES)).toBeLessThanOrEqual(90);
  });
});

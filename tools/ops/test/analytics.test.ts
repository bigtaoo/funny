// src/logic/analytics.ts — the analytics page's pivots, shares and section gating.
//
// The page fires 17 requests through Promise.allSettled and each section then has to answer the same
// three questions (did it resolve, is analytics configured, did this list come back non-empty). Those
// answers plus the pivots are the whole of this module; the tables built on top are DOM.
import { describe, expect, it } from 'vitest';
import {
  analyticsUnavailable, badgeModes, badgePivot, barRatio, barWidthPx, distribution, eventCountGrid,
  FUNNEL_STEPS, funnelPivot, funnelPlatforms, LEVEL_FUNNEL_LIMIT, levelFunnelRows, loginHourRows,
  metricRows, ONBOARDING_LABELS, retentionCell, RETENTION_OFFSETS, retentionRows, sectionRows,
  sectionValue, stepFunnelRows, TUTORIAL_LABELS, type BadgeRow, type FunnelRow, type RetentionRow,
} from '../src/logic/analytics';

const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value });
const failed = <T>(): PromiseSettledResult<T> => ({ status: 'rejected', reason: new Error('boom') });

describe('section gating', () => {
  it('reports analytics as unavailable only when it answered and said so', () => {
    expect(analyticsUnavailable(ok({ available: false }))).toBe(true);
    expect(analyticsUnavailable(ok({ available: true }))).toBe(false);
    // A failed request is not evidence that analytics is unconfigured — the page shows the error instead.
    expect(analyticsUnavailable(failed())).toBe(false);
  });

  it('yields no rows for a rejected request, an unavailable service, or an absent list', () => {
    expect(sectionRows(failed<{ available: boolean; dau?: number[] }>(), (v) => v.dau)).toEqual([]);
    expect(sectionRows(ok({ available: false, dau: [1, 2] }), (v) => v.dau)).toEqual([]);
    expect(sectionRows(ok({ available: true }), (v) => (v as { dau?: number[] }).dau)).toEqual([]);
  });

  it('yields the rows when everything lined up, as a copy', () => {
    const dau = [1, 2, 3];
    const out = sectionRows(ok({ available: true, dau }), (v) => v.dau);
    expect(out).toEqual([1, 2, 3]);
    out.push(4);
    expect(dau).toHaveLength(3);
  });

  it('does the same for the three object-shaped cohort sections', () => {
    const fs = { cohort_size: 10 };
    expect(sectionValue(ok({ available: true, first_session: fs }), (v) => v.first_session)).toBe(fs);
    expect(sectionValue(ok({ available: false, first_session: fs }), (v) => v.first_session)).toBeUndefined();
    expect(sectionValue(failed<{ available: boolean; first_session?: typeof fs }>(), (v) => v.first_session)).toBeUndefined();
  });
});

describe('bars', () => {
  it('is the plain ratio when the track is non-zero', () => {
    expect(barRatio(3, 12)).toBe(0.25);
  });

  it('is 0 rather than NaN on an empty day', () => {
    expect(barRatio(0, 0)).toBe(0);
    expect(barRatio(5, 0)).toBe(0);
  });

  it('scales to 120px at full width, rounded', () => {
    expect(barWidthPx(0)).toBe('0');
    expect(barWidthPx(1)).toBe('120');
    expect(barWidthPx(0.25)).toBe('30');
    expect(barWidthPx(1 / 3)).toBe('40');
  });
});

describe('distribution', () => {
  const rows = [
    { locale: 'zh-CN', devices: 60 },
    { locale: 'de-DE', devices: 30 },
    { locale: 'en-US', devices: 10 },
  ];

  it('shares each row against the total, keeping the served order', () => {
    expect(distribution(rows, 'locale')).toEqual([
      { label: 'zh-CN', value: 60, share: 0.6 },
      { label: 'de-DE', value: 30, share: 0.3 },
      { label: 'en-US', value: 10, share: 0.1 },
    ]);
  });

  it('reads the label out of whichever field the payload uses', () => {
    expect(distribution([{ country: 'DE', devices: 1 }], 'country')).toEqual([{ label: 'DE', value: 1, share: 1 }]);
    expect(distribution([{ os: 'iOS', devices: 1 }], 'os')).toEqual([{ label: 'iOS', value: 1, share: 1 }]);
  });

  it('survives an all-zero day without dividing by zero', () => {
    expect(distribution([{ os: 'iOS', devices: 0 }], 'os')).toEqual([{ label: 'iOS', value: 0, share: 0 }]);
  });

  it('is empty for no rows', () => {
    expect(distribution([], 'os')).toEqual([]);
  });
});

describe('loginHourRows', () => {
  it('zero-pads the hour and scales each bar against the BUSIEST hour, not the total', () => {
    expect(loginHourRows([{ hour: 7, count: 5 }, { hour: 19, count: 10 }])).toEqual([
      { label: '07:00', value: 5, share: 0.5 },
      { label: '19:00', value: 10, share: 1 },
    ]);
  });

  it('floors the divisor at 1 so an all-zero day is flat rather than NaN', () => {
    expect(loginHourRows([{ hour: 0, count: 0 }])).toEqual([{ label: '00:00', value: 0, share: 0 }]);
  });
});

describe('stepFunnelRows', () => {
  const funnel = [
    { step: 'session_start', count: 100 },
    { step: 'tutorial_start', count: 60, conversion_rate: 0.6 },
    { step: 'tutorial_complete', count: 30, conversion_rate: 0.5 },
  ];

  it('labels steps from the map it was given, and shares each against the cohort', () => {
    expect(stepFunnelRows(funnel, 100, ONBOARDING_LABELS)).toEqual([
      { label: 'Opened the game', count: 100, ofCohort: 1 },
      { label: 'Started tutorial', count: 60, stepRate: 0.6, ofCohort: 0.6 },
      { label: 'Finished tutorial', count: 30, stepRate: 0.5, ofCohort: 0.3 },
    ]);
  });

  it('omits the step rate on the first step, which has nothing to convert from', () => {
    expect(stepFunnelRows(funnel, 100, ONBOARDING_LABELS)[0]).not.toHaveProperty('stepRate');
  });

  it('falls back to the raw step key with no map (the scene funnel) or an unknown key', () => {
    expect(stepFunnelRows([{ step: 'lobby', count: 1 }], 1)[0]!.label).toBe('lobby');
    expect(stepFunnelRows([{ step: 'mystery', count: 1 }], 1, TUTORIAL_LABELS)[0]!.label).toBe('mystery');
  });

  it('guards a zero cohort', () => {
    expect(stepFunnelRows([{ step: 'a', count: 5 }], 0)[0]!.ofCohort).toBe(0);
  });

  it('has a label for every tutorial step key it claims to cover', () => {
    expect(Object.keys(TUTORIAL_LABELS)).toContain('tutorial_start');
    expect(Object.keys(TUTORIAL_LABELS)).toContain('tutorial_complete');
    expect(Object.values(TUTORIAL_LABELS).filter((v) => !v.trim())).toEqual([]);
    expect(Object.values(ONBOARDING_LABELS).filter((v) => !v.trim())).toEqual([]);
  });
});

describe('retention', () => {
  const row = (over: Partial<RetentionRow> = {}): RetentionRow => ({ date: '2026-08-13', cohort_size: 10, ...over });

  it('covers D1 through D7', () => {
    expect([...RETENTION_OFFSETS]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('drops empty cohorts, which would render as a row of dashes', () => {
    expect(retentionRows([row(), row({ cohort_size: 0 })])).toHaveLength(1);
  });

  it('shows the rate with the device count as the hover title', () => {
    const r = row({ d: { 1: 4 }, d_rate: { 1: 0.4 } });
    expect(retentionCell(r, 1)).toEqual({ text: '40.0%', title: '4 devices' });
  });

  it('dashes a missing rate and says why the title is empty', () => {
    expect(retentionCell(row(), 3)).toEqual({ text: '—', title: 'insufficient data' });
  });

  it('keeps a genuine zero rate distinct from missing data', () => {
    expect(retentionCell(row({ d: { 2: 0 }, d_rate: { 2: 0 } }), 2)).toEqual({ text: '0.0%', title: '0 devices' });
  });
});

describe('levelFunnelRows', () => {
  it('caps the list at the 20 the caption promises', () => {
    const rows = Array.from({ length: 50 }, (_, i) => i);
    expect(levelFunnelRows(rows)).toHaveLength(LEVEL_FUNNEL_LIMIT);
    expect(levelFunnelRows(rows)[0]).toBe(0); // the list arrives worst-first, so keep the head
  });

  it('passes a short list straight through', () => {
    expect(levelFunnelRows([1, 2])).toEqual([1, 2]);
  });
});

describe('badge pivot', () => {
  const rows: BadgeRow[] = [
    { mode: 'ranked', result: 'win', badge: 'sharpshooter', count: 10 },
    { mode: 'ranked', result: 'loss', badge: 'sharpshooter', count: 2 },
    { mode: 'ranked', result: 'win', badge: 'tank', count: 40 },
    { mode: 'friendly', result: 'draw', badge: 'tank', count: 1 },
  ];

  it('lists the modes present, sorted', () => {
    expect(badgeModes(rows)).toEqual(['friendly', 'ranked']);
    expect(badgeModes([])).toEqual([]);
  });

  it('orders result columns win/loss/draw, including only those present', () => {
    expect(badgePivot(rows, 'ranked').results).toEqual(['win', 'loss']);
    expect(badgePivot(rows, 'friendly').results).toEqual(['draw']);
  });

  it('appends an unexpected result kind after the known ones rather than dropping it', () => {
    const withNew = [...rows, { mode: 'ranked', result: 'forfeit', badge: 'tank', count: 3 }];
    expect(badgePivot(withNew, 'ranked').results).toEqual(['win', 'loss', 'forfeit']);
  });

  it('sorts badges by total, most matches first, and aligns counts with the columns', () => {
    const p = badgePivot(rows, 'ranked');
    expect(p.badges.map((b) => b.badge)).toEqual(['tank', 'sharpshooter']);
    expect(p.badges[0]).toEqual({ badge: 'tank', counts: [40, 0], total: 40, share: 40 / 52 });
    expect(p.badges[1]).toEqual({ badge: 'sharpshooter', counts: [10, 2], total: 12, share: 12 / 52 });
    expect(p.grandTotal).toBe(52);
  });

  it('zero-fills a badge/result combination nobody hit', () => {
    expect(badgePivot(rows, 'ranked').badges[0]!.counts).toContain(0);
  });

  it('is empty for a mode with no rows', () => {
    expect(badgePivot(rows, 'nonexistent')).toEqual({ results: [], badges: [], grandTotal: 0 });
  });
});

describe('conversion funnel pivot', () => {
  const rows: FunnelRow[] = [
    { date: '2026-08-12', platform: 'web', funnel_step: 'session_start', count: 90 },
    { date: '2026-08-13', platform: 'web', funnel_step: 'session_start', count: 100 },
    { date: '2026-08-13', platform: 'web', funnel_step: 'game_start', count: 70, conversion_rate: 0.7 },
    { date: '2026-08-13', platform: 'wechat', funnel_step: 'session_start', count: 5 },
  ];

  it('lists the platforms present, sorted', () => {
    expect(funnelPlatforms(rows)).toEqual(['web', 'wechat']);
  });

  it('pivots the platform’s most recent day only', () => {
    const p = funnelPivot(rows, 'web');
    expect(p.latestDate).toBe('2026-08-13');
    expect(p.cells[0]).toEqual({ step: 'session_start', count: 100 });
  });

  it('keeps the canonical step list so the funnel shape stays comparable across days', () => {
    const p = funnelPivot(rows, 'web');
    expect(p.cells.map((c) => c.step)).toEqual(FUNNEL_STEPS);
    // level_attempt / level_complete recorded nothing that day: no count, which prints as an em dash.
    expect(p.cells[2]).toEqual({ step: 'level_attempt' });
    expect(p.cells[3]!.count).toBeUndefined();
  });

  it('carries the conversion rate when the backend computed one', () => {
    expect(funnelPivot(rows, 'web').cells[1]).toEqual({ step: 'game_start', count: 70, rate: 0.7 });
  });

  it('yields an empty date and no counts for an unknown platform', () => {
    const p = funnelPivot(rows, 'crazygames');
    expect(p.latestDate).toBe('');
    expect(p.cells.every((c) => c.count === undefined)).toBe(true);
  });
});

describe('eventCountGrid', () => {
  it('builds a sorted date × event matrix, zero-filling the gaps', () => {
    expect(eventCountGrid([
      { date: '2026-08-13', event: 'session_start', count: 5 },
      { date: '2026-08-12', event: 'level_complete', count: 2 },
      { date: '2026-08-13', event: 'level_complete', count: 3 },
    ])).toEqual({
      events: ['level_complete', 'session_start'],
      dates: ['2026-08-12', '2026-08-13'],
      grid: [[2, 0], [3, 5]],
    });
  });

  it('is empty for no rows', () => {
    expect(eventCountGrid([])).toEqual({ events: [], dates: [], grid: [] });
  });
});

describe('metricRows', () => {
  it('formats the average to one decimal and passes peak/samples through', () => {
    expect(metricRows({ online: { avg: 12.345, peak: 40, samples: 288 } })).toEqual([
      { key: 'online', avg: '12.3', peak: 40, samples: 288 },
    ]);
  });

  it('is empty when the stats backend reported nothing', () => {
    expect(metricRows({})).toEqual([]);
  });
});

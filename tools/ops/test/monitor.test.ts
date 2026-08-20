// src/logic/monitor.ts — the live monitor's metric table, stat grid and intervals.
import { describe, expect, it } from 'vitest';
import {
  AUTO_REFRESH_MS, availabilityNote, liveCells, METRICS, metricLabel, TREND_WINDOW_MS, trendCaption,
  trendFromMs,
} from '../src/logic/monitor';
import type { LiveStats } from '../src/types';

const live: LiveStats = { online: 12, queue: 3, rooms: 5, gameInstances: 2, gameLoad: 0.7, available: true };

describe('metricLabel', () => {
  it('maps a known key to its display label', () => {
    expect(metricLabel('gameInstances')).toBe('Game instances');
  });

  it('falls back to the raw key so a metric the backend added still renders', () => {
    expect(metricLabel('somethingNew')).toBe('somethingNew');
  });
});

describe('liveCells', () => {
  it('returns one labelled cell per metric, in METRICS order', () => {
    expect(liveCells(live)).toEqual([
      ['Online connections', 12],
      ['Matchmaking queue', 3],
      ['Active rooms', 5],
      ['Game instances', 2],
      ['Game load', 0.7],
    ]);
  });

  it('reads a missing gameLoad as 0 — an older stats backend omits it', () => {
    const { gameLoad, ...rest } = live;
    void gameLoad;
    expect(liveCells(rest as LiveStats)).toContainEqual(['Game load', 0]);
  });

  it('keeps a real zero rather than treating it as missing', () => {
    expect(liveCells({ ...live, online: 0 })).toContainEqual(['Online connections', 0]);
  });

  it('covers exactly the METRICS list, so the grid and the trend dropdown cannot drift', () => {
    expect(liveCells(live).map(([label]) => label)).toEqual(METRICS.map(([, label]) => label));
  });
});

describe('availabilityNote', () => {
  it('says nothing when the stats backend is configured', () => {
    expect(availabilityNote({ available: true })).toBe('');
  });

  it('warns that the zeros are placeholders when it is not', () => {
    expect(availabilityNote({ available: false })).toBe('Note: stats backend not configured, showing 0.');
  });
});

describe('trend window', () => {
  it('looks back six hours', () => {
    expect(TREND_WINDOW_MS).toBe(6 * 3600 * 1000);
    expect(trendFromMs(1_000_000_000)).toBe(1_000_000_000 - TREND_WINDOW_MS);
  });

  it('captions the chart with the label, the window and the sample count', () => {
    expect(trendCaption('Online connections', 72)).toBe('Online connections trend (last 6h, 72 samples)');
  });

  it('polls every ten seconds, matching the checkbox label', () => {
    expect(AUTO_REFRESH_MS).toBe(10_000);
  });
});

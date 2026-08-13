// events.ts's window-status classifier (B6 timed events: Not started / Active / Ended pill).
// pageEvents() itself builds DOM and stays untested. Pins the process clock with
// vi.setSystemTime so "now" is deterministic regardless of when the suite runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventStatus } from '../src/pages/events';

const NOW = new Date(2026, 7, 13, 12, 0).getTime(); // 2026-08-13 noon

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('eventStatus', () => {
  it('is "Not started" before the window opens', () => {
    expect(eventStatus({ windowStart: NOW + 1000, windowEnd: NOW + 2000 })).toEqual({ label: 'Not started', cls: 'info' });
  });

  it('is "Active" strictly inside the window', () => {
    expect(eventStatus({ windowStart: NOW - 1000, windowEnd: NOW + 1000 })).toEqual({ label: 'Active', cls: 'ok' });
  });

  it('is "Active" at the exact windowStart instant (inclusive)', () => {
    expect(eventStatus({ windowStart: NOW, windowEnd: NOW + 1000 })).toEqual({ label: 'Active', cls: 'ok' });
  });

  it('is "Ended" at the exact windowEnd instant (exclusive)', () => {
    expect(eventStatus({ windowStart: NOW - 1000, windowEnd: NOW })).toEqual({ label: 'Ended', cls: '' });
  });

  it('is "Ended" after the window closes', () => {
    expect(eventStatus({ windowStart: NOW - 2000, windowEnd: NOW - 1000 })).toEqual({ label: 'Ended', cls: '' });
  });
});

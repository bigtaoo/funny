// Ops admin console's ms <-> datetime-local ("YYYY-MM-DDTHH:mm", LOCAL timezone) helpers
// (pages/shared.ts) — pure Date math, no DOM touched by either function (sparkline/showErr/
// showOk in the same file do build real DOM nodes, but aren't exercised here — see
// vitest.config.ts's scope note). Deliberately builds expected strings from the same local Date
// getters the source uses, rather than a hardcoded literal, so this passes regardless of which
// timezone the machine running it is in.
import { describe, it, expect } from 'vitest';
import { msToLocalInput, localInputToMs } from '../src/pages/shared';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Same formatting `msToLocalInput` itself uses, built independently from local Date getters. */
function expectedLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('msToLocalInput', () => {
  it('formats an arbitrary timestamp as YYYY-MM-DDTHH:mm in local time', () => {
    const d = new Date(2026, 2, 5, 9, 3); // 2026-03-05 09:03 local — single-digit month/day/hour/minute all need zero-padding
    expect(msToLocalInput(d.getTime())).toBe(expectedLocalInput(d));
  });

  it('zero-pads every component independently (not just the first single-digit one)', () => {
    const d = new Date(2030, 11, 31, 23, 59);
    expect(msToLocalInput(d.getTime())).toBe(expectedLocalInput(d));
  });
});

describe('localInputToMs', () => {
  it('inverts msToLocalInput for a whole-minute timestamp', () => {
    const original = new Date(2026, 6, 20, 14, 30).getTime();
    expect(localInputToMs(msToLocalInput(original))).toBe(original);
  });

  it('parses a "YYYY-MM-DDTHH:mm" string as local time (round-trips through the Date constructor)', () => {
    const s = '2026-08-13T08:15';
    expect(localInputToMs(s)).toBe(new Date(s).getTime());
  });

  it('returns NaN for an unparseable string, never throws', () => {
    expect(localInputToMs('not-a-date')).toBeNaN();
    expect(localInputToMs('')).toBeNaN();
  });
});

describe('msToLocalInput / localInputToMs round trip', () => {
  it('holds across a handful of distinct timestamps', () => {
    const samples = [
      new Date(2000, 0, 1, 0, 0),
      new Date(2026, 5, 15, 12, 0),
      new Date(2099, 11, 31, 23, 59),
    ];
    for (const d of samples) {
      expect(localInputToMs(msToLocalInput(d.getTime()))).toBe(d.getTime());
    }
  });
});

// src/logic/shared.ts — the primitives every page's logic module leans on.
//
// The four label/count helpers exist because the same expression was hand-written in four to six
// places each (see their doc comments for the call sites); these tests pin the shapes those call
// sites depend on, including the fallback each one chose.
//
// The datetime-local pair is the ops console's ms ↔ `<input type="datetime-local">` bridge, used by
// the timed-event, gacha-pool and promo-code forms. Deliberately LOCAL time, so the assertions are
// built from local Date getters rather than hardcoded strings — a fixed literal would only pass in
// whichever timezone it was written in.
import { describe, expect, it } from 'vitest';
import {
  adminLabel, localInputToMs, msToLocalInput, pct, plural, publicIdLabel, SPARK_H, SPARK_W,
  sparklinePoints,
} from '../src/logic/shared';

/** Same formatting `msToLocalInput` itself uses, built independently from local Date getters. */
function expectedLocalInput(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

describe('publicIdLabel', () => {
  it('prefixes a public id with #', () => {
    expect(publicIdLabel('123456789', 'acc-1')).toBe('#123456789');
  });

  it('falls back when there is no public id — the fallback differs per call site, hence the parameter', () => {
    expect(publicIdLabel(undefined, 'acc-1')).toBe('acc-1');
    expect(publicIdLabel(undefined, '—')).toBe('—');
    expect(publicIdLabel(undefined, '')).toBe('');
  });

  it('treats an empty public id as absent rather than rendering a bare #', () => {
    expect(publicIdLabel('', 'acc-1')).toBe('acc-1');
  });
});

describe('adminLabel', () => {
  it('prefers the display name the row carried', () => {
    expect(adminLabel('Ada Lovelace', 'adm-0123456789')).toBe('Ada Lovelace');
  });

  it('shortens a bare adminId to 8 characters', () => {
    expect(adminLabel(undefined, 'adm-0123456789')).toBe('adm-0123');
  });

  it('leaves a short id alone rather than padding it', () => {
    expect(adminLabel(undefined, 'adm')).toBe('adm');
  });

  it('reads as an em dash when nobody has acted yet (an unapproved ticket has no approver)', () => {
    expect(adminLabel(undefined, undefined)).toBe('—');
  });

  it('keeps an empty display name out of the way — `??` only skips null/undefined, so this is the real rule', () => {
    // The rows this reads carry either a real name or no field at all; an empty string means the
    // backend sent one, and echoing it verbatim is the honest report of that.
    expect(adminLabel('', 'adm-0123456789')).toBe('');
  });
});

describe('plural', () => {
  it('keeps the singular at exactly one', () => {
    expect(plural(1, 'result')).toBe('1 result');
  });

  it('pluralizes everything else, zero included', () => {
    expect(plural(0, 'result')).toBe('0 results');
    expect(plural(2, 'listing')).toBe('2 listings');
    expect(plural(42, 'suspicious pair')).toBe('42 suspicious pairs');
  });
});

describe('pct', () => {
  it('formats a fraction as a percentage with one decimal place', () => {
    expect(pct(0.5)).toBe('50.0%');
  });

  it('rounds to one decimal place', () => {
    expect(pct(0.12345)).toBe('12.3%');
  });

  it('formats 0 and 1 as the boundary percentages', () => {
    expect(pct(0)).toBe('0.0%');
    expect(pct(1)).toBe('100.0%');
  });
});

describe('sparklinePoints', () => {
  it('spans the full width, one point per sample', () => {
    const pts = sparklinePoints([0, 5, 10]).split(' ');
    expect(pts).toHaveLength(3);
    expect(pts[0]!.split(',')[0]).toBe('0.0');
    expect(pts[2]!.split(',')[0]).toBe(String(SPARK_W.toFixed(1)));
  });

  it('puts the largest sample near the top and zero near the bottom', () => {
    const [lo, hi] = sparklinePoints([0, 10]).split(' ').map((p) => Number(p.split(',')[1]));
    expect(lo).toBe(SPARK_H - 3); // 3px inset from the bottom edge
    expect(hi).toBe(3); // 3px inset from the top
  });

  it('degenerates a single sample to one point at x=0 instead of dividing by zero', () => {
    expect(sparklinePoints([7])).toBe('0.0,3.0');
  });

  it('draws an all-zero series flat along the bottom rather than producing NaN', () => {
    // max is floored at 1, so 0/max is 0 rather than 0/0.
    expect(sparklinePoints([0, 0, 0])).toBe('0.0,77.0 300.0,77.0 600.0,77.0');
  });

  it('is empty for an empty series (the DOM half renders "No data" instead)', () => {
    expect(sparklinePoints([])).toBe('');
  });

  it('honours an explicit viewport', () => {
    expect(sparklinePoints([1, 1], 10, 20)).toBe('0.0,3.0 10.0,3.0');
  });
});

describe('msToLocalInput', () => {
  it('formats a timestamp as a datetime-local value in local time', () => {
    const d = new Date(2026, 7, 13, 9, 5);
    expect(msToLocalInput(d.getTime())).toBe(expectedLocalInput(d));
  });

  it('zero-pads month, day, hour and minute', () => {
    const d = new Date(2026, 0, 2, 3, 4);
    expect(msToLocalInput(d.getTime())).toBe(expectedLocalInput(d));
    expect(msToLocalInput(d.getTime())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('localInputToMs', () => {
  it('inverts msToLocalInput for a whole-minute timestamp', () => {
    const original = new Date(2026, 7, 13, 9, 5).getTime();
    expect(localInputToMs(msToLocalInput(original))).toBe(original);
  });

  it('parses a datetime-local string the same way the platform does', () => {
    const s = '2026-08-13T09:05';
    expect(localInputToMs(s)).toBe(new Date(s).getTime());
  });

  it('returns NaN for an unparseable or cleared field', () => {
    expect(localInputToMs('not-a-date')).toBeNaN();
    expect(localInputToMs('')).toBeNaN();
  });
});

describe('msToLocalInput / localInputToMs round trip', () => {
  it('survives a DST boundary and a year end', () => {
    for (const d of [
      new Date(2026, 2, 29, 3, 30), // EU DST spring forward
      new Date(2026, 9, 25, 2, 30), // EU DST fall back
      new Date(2026, 11, 31, 23, 59),
      new Date(2027, 0, 1, 0, 0),
    ]) {
      expect(localInputToMs(msToLocalInput(d.getTime()))).toBe(d.getTime());
    }
  });
});

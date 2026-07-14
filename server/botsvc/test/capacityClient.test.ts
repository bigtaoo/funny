import { describe, it, expect } from 'vitest';
import { shedTarget } from '../src/capacityClient';

const base = { targetOnline: 100, shedStartAt: 2500, shedFullAt: 2800 };

describe('shedTarget', () => {
  it('holds full target below the shed-start threshold', () => {
    expect(shedTarget({ ...base, currentOnline: 2000 })).toBe(100);
    expect(shedTarget({ ...base, currentOnline: 2500 })).toBe(100);
  });

  it('ramps linearly between shedStartAt and shedFullAt', () => {
    expect(shedTarget({ ...base, currentOnline: 2650 })).toBe(50);
  });

  it('sheds to zero at and beyond shedFullAt — bots never block real players', () => {
    expect(shedTarget({ ...base, currentOnline: 2800 })).toBe(0);
    expect(shedTarget({ ...base, currentOnline: 3000 })).toBe(0);
  });
});

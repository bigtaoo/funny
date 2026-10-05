import { describe, expect, it } from 'vitest';
import { COMPOUND_SEAMS, compoundSeam } from '../src/i18n/compoundBreaks';
import { de } from '../src/i18n/locales/de';

describe('compoundSeam', () => {
  it('splits a listed German card name at its seam', () => {
    expect(compoundSeam('Bogenschütze', 'de')).toEqual(['Bogen', 'schütze']);
  });

  it('returns null for an unlisted word or another locale', () => {
    expect(compoundSeam('Kaserne', 'de')).toBeNull();
    expect(compoundSeam('Bogenschütze', 'en')).toBeNull();
  });

  it('lists each seam once, on a word that is a German card name', () => {
    const names = new Set(Object.entries(de).filter(([k]) => /^card\.[^.]+\.name$/.test(k)).map(([, v]) => v));
    for (const seam of COMPOUND_SEAMS.de ?? []) {
      const name = seam.replace('|', '');
      expect(names.has(name), name).toBe(true);
      expect(seam.split('|'), seam).toHaveLength(2);
      expect(compoundSeam(name, 'de')?.join(''), name).toBe(name);
    }
  });
});

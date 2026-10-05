// compoundBreaks.ts — where a long single-word name may be split across two lines.
//
// German card names are single compound words ("Bogenschütze", "Meteoreinschlag"). When one is
// still wider than its box at the legibility floor, the only fallback PIXI offers is `breakWords`,
// which cuts at whatever glyph runs out of room ("Bogenschüt" / "ze"). A compound has one natural
// seam — between its parts — and a reader expects the hyphen there, so the seams are listed here
// rather than guessed: no hyphenation dictionary ships with the game, and the names are a fixed set.
//
// Kept out of the locale dictionaries on purpose: those values are compared verbatim against
// rendered text by the layout tests, and a soft hyphen (U+00AD) inside them would render or measure
// differently across the canvas backends we ship on.
import type { Locale } from './index';

/** `head|tail` per word; the bar marks the one place the word may be broken. */
export const COMPOUND_SEAMS: Partial<Record<Locale, readonly string[]>> = {
  de: [
    'Bogen|schütze', 'Schild|träger', 'Pfeil|turm', 'Sturm|angriff', 'Meteor|einschlag',
    'Fels|sturz', 'Brücken|einsturz', 'Eisen|wächter', 'Infan|terie', 'Sani|täter',
  ],
};

const index = new Map<Locale, Map<string, readonly [string, string]>>();

/** The two halves `word` may be split into in `locale`, or null if it has no listed seam. */
export function compoundSeam(word: string, locale: Locale): readonly [string, string] | null {
  let m = index.get(locale);
  if (!m) {
    m = new Map();
    for (const s of COMPOUND_SEAMS[locale] ?? []) {
      const [head, tail] = s.split('|');
      m.set(head + tail, [head, tail]);
    }
    index.set(locale, m);
  }
  return m.get(word) ?? null;
}

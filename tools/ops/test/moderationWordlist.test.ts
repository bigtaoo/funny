// src/logic/moderationWordlist.ts — the list-merge + redundancy logic (CONTENT_MODERATION_DESIGN.md §3.2). This is
// where the page decides what a proposed word would actually accomplish, and it has to agree with
// @nw/shared `effectiveWordlist`/`matchRaw` — union of global floor + region floor + global overlay +
// region overlay, matched case-insensitively as a SUBSTRING. Getting that wrong shows the operator a
// clean "added" for a word that blocks nothing, which is exactly the mistake the page exists to prevent.
// `pageModerationWordlist` builds DOM and stays untested, same split as feedback.test.ts / flags.test.ts.
import { describe, it, expect } from 'vitest';
import {
  activeWords, addedText, checkMessage, checkWord, coveredBy, describeCover, effectiveSummary,
  isBlocked, orderRegions, overlayMetaText, REGION_LABEL, REGION_ORDER, removedText, removeTitle,
  WORD_MAX,
} from '../src/logic/moderationWordlist';
import type { ChatRegion, ModerationWordlistView } from '../src/types';

const view = (region: ChatRegion, builtin: string[], overlay: string[] = []): ModerationWordlistView =>
  ({ region, builtin, overlay });

/** Shaped like the real GET /admin/moderation/wordlists payload: all four regions, always. */
const rows = [
  view('global', ['fuck', 'http://'], ['scam']),
  view('cn', ['外挂'], ['代练']),
  view('de', ['scheisse'], []),
  view('en', ['asshole'], []),
];

describe('activeWords', () => {
  it('stacks global floor + region floor + global overlay + region overlay, in that order', () => {
    expect(activeWords(rows, 'cn')).toEqual([
      { word: 'fuck', region: 'global', source: 'builtin' },
      { word: 'http://', region: 'global', source: 'builtin' },
      { word: '外挂', region: 'cn', source: 'builtin' },
      { word: 'scam', region: 'global', source: 'overlay' },
      { word: '代练', region: 'cn', source: 'overlay' },
    ]);
  });

  it('does not double-count the global lists when the region IS global', () => {
    expect(activeWords(rows, 'global')).toEqual([
      { word: 'fuck', region: 'global', source: 'builtin' },
      { word: 'http://', region: 'global', source: 'builtin' },
      { word: 'scam', region: 'global', source: 'overlay' },
    ]);
  });

  it('a region with an empty overlay still inherits the global overlay', () => {
    expect(activeWords(rows, 'de').map((a) => a.word)).toContain('scam');
  });

  it('lowercases entries (matching is case-insensitive) and drops empties', () => {
    const messy = [view('global', ['FUCK', ''], ['ScAm'])];
    expect(activeWords(messy, 'global')).toEqual([
      { word: 'fuck', region: 'global', source: 'builtin' },
      { word: 'scam', region: 'global', source: 'overlay' },
    ]);
  });

  it('attributes a duplicated word to the floor, not the overlay that shadows it', () => {
    const dup = [view('global', ['scam'], ['scam'])];
    expect(activeWords(dup, 'global')).toEqual([{ word: 'scam', region: 'global', source: 'builtin' }]);
  });

  it('survives a payload missing regions entirely (no global row, unknown region)', () => {
    expect(activeWords([], 'cn')).toEqual([]);
    expect(activeWords([view('cn', ['外挂'])], 'cn')).toEqual([
      { word: '外挂', region: 'cn', source: 'builtin' },
    ]);
  });
});

describe('coveredBy', () => {
  it('reports the built-in floor entry for an exact floor duplicate', () => {
    expect(coveredBy('fuck', rows, 'cn')).toEqual({ word: 'fuck', region: 'global', source: 'builtin' });
  });

  it('reports the global overlay for a word inherited into a region', () => {
    expect(coveredBy('scam', rows, 'de')).toEqual({ word: 'scam', region: 'global', source: 'overlay' });
  });

  it('reports the shorter live word for a substring extension ("scammer" adds nothing over "scam")', () => {
    expect(coveredBy('scammer', rows, 'de')).toEqual({ word: 'scam', region: 'global', source: 'overlay' });
  });

  it('returns null for a word that widens coverage, including a BROADER prefix of a live word', () => {
    expect(coveredBy('phish', rows, 'de')).toBeNull();
    // 'sca' is contained in 'scam', not the reverse — it blocks strictly more, so it is a real addition.
    expect(coveredBy('sca', rows, 'de')).toBeNull();
  });

  it("skips the word's own overlay entry so a stored word can be audited against everything else", () => {
    // '代练' is cn's only overlay word and nothing else covers it → not redundant.
    expect(coveredBy('代练', rows, 'cn')).toBeNull();
    // ...but the same word also sitting in the global overlay does make the cn entry redundant.
    const alsoGlobal = [view('global', ['fuck'], ['代练']), view('cn', ['外挂'], ['代练'])];
    expect(coveredBy('代练', alsoGlobal, 'cn')).toEqual({ word: '代练', region: 'global', source: 'overlay' });
  });

  it('attributes a sibling entry in the SAME overlay, not just other lists', () => {
    // Both live in cn's overlay: '代练' covers '代练群' (that is what the row's no-op badge points at).
    const siblings = [view('global', ['fuck']), view('cn', ['外挂'], ['代练', '代练群'])];
    expect(coveredBy('代练群', siblings, 'cn')).toEqual({ word: '代练', region: 'cn', source: 'overlay' });
  });

  it('works for the global card itself, where there is no region list to inherit from', () => {
    expect(coveredBy('fucker', rows, 'global')).toEqual({ word: 'fuck', region: 'global', source: 'builtin' });
    // A cn-only word must NOT be treated as covering anything in global (inheritance is one-way).
    expect(coveredBy('代练', rows, 'global')).toBeNull();
  });

  it('normalizes case and surrounding whitespace before comparing', () => {
    expect(coveredBy('  SCAMMER ', rows, 'de')).toEqual({ word: 'scam', region: 'global', source: 'overlay' });
  });

  it('treats an empty word as covering nothing rather than matching everything', () => {
    expect(coveredBy('   ', rows, 'cn')).toBeNull();
  });
});

describe('checkWord', () => {
  it('rejects blank input the server would 400 on', () => {
    expect(checkWord('   ', rows, 'cn')).toEqual({ kind: 'empty' });
  });

  it(`rejects over ${WORD_MAX} characters, mirroring the server's validateWord`, () => {
    expect(checkWord('a'.repeat(WORD_MAX), rows, 'cn')).toMatchObject({ kind: 'ok' });
    expect(checkWord('a'.repeat(WORD_MAX + 1), rows, 'cn')).toMatchObject({ kind: 'too_long' });
    // Trimming happens first, so trailing spaces must not push a legal word over the limit.
    expect(checkWord(`${'a'.repeat(WORD_MAX)}   `, rows, 'cn')).toMatchObject({ kind: 'ok' });
  });

  it("flags a word already in this region's own overlay as a duplicate, not merely redundant", () => {
    expect(checkWord('代练', rows, 'cn')).toEqual({ kind: 'duplicate', word: '代练' });
    // Case-insensitively too — the server stores lowercase.
    expect(checkWord('ScAm', rows, 'global')).toEqual({ kind: 'duplicate', word: 'scam' });
  });

  it('flags a floor duplicate / inherited word / substring extension as redundant, carrying the covering entry', () => {
    expect(checkWord('fuck', rows, 'cn')).toEqual({
      kind: 'redundant', word: 'fuck', by: { word: 'fuck', region: 'global', source: 'builtin' },
    });
    expect(checkWord('scam', rows, 'de')).toMatchObject({ kind: 'redundant', by: { region: 'global', source: 'overlay' } });
    expect(checkWord('bigscammer', rows, 'de')).toMatchObject({ kind: 'redundant', by: { word: 'scam' } });
  });

  it('accepts a genuinely new word, lowercased and trimmed as the server will store it', () => {
    expect(checkWord('  PhishSite ', rows, 'cn')).toEqual({ kind: 'ok', word: 'phishsite' });
  });

  it('accepts the same word in a different region when only that region lacks it', () => {
    // '代练' is in cn's overlay but nothing covers it for `en`.
    expect(checkWord('代练', rows, 'en')).toEqual({ kind: 'ok', word: '代练' });
  });
});

describe('describeCover', () => {
  it('names the built-in floor and the region it comes from', () => {
    expect(describeCover({ word: 'scam', region: 'en', source: 'builtin' }, 'scam'))
      .toBe('"scam" is already active via the built-in en floor');
  });

  it('names the overlay when the cover is an ops-added word', () => {
    expect(describeCover({ word: 'phish', region: 'global', source: 'overlay' }, 'phish'))
      .toBe('"phish" is already active via the global overlay');
  });

  it('adds the containment clause — in the right direction — only for a substring cover', () => {
    // The covering word is the SHORTER one; the candidate contains it, never the reverse.
    expect(describeCover({ word: 'scam', region: 'en', source: 'builtin' }, 'scammer'))
      .toBe('"scam" is already active via the built-in en floor, and every "scammer" contains it');
  });
});

describe('checkMessage', () => {
  const anyRows = rows;

  it('says nothing at all for a genuinely useful addition', () => {
    expect(checkMessage(checkWord('phishsite', anyRows, 'cn'))).toBeNull();
  });

  it('blocks exactly the three cases the operator cannot act on', () => {
    for (const raw of ['   ', 'a'.repeat(WORD_MAX + 1), '代练']) {
      expect(checkMessage(checkWord(raw, anyRows, 'cn'))).toMatchObject({ blocked: true });
    }
  });

  it('leaves a redundant word ADVISORY — the write is still allowed (CM2 caveat, module header)', () => {
    const msg = checkMessage(checkWord('scammer', anyRows, 'en'));
    expect(msg).toMatchObject({ blocked: false });
    expect(msg?.text).toContain('Blocks nothing new');
    expect(msg?.text).toContain('Add it anyway');
  });

  it('quotes the length limit it is enforcing, so the number cannot silently drift from the server', () => {
    expect(checkMessage(checkWord('a'.repeat(WORD_MAX + 1), anyRows, 'cn'))?.text).toContain(String(WORD_MAX));
  });
});

const stamp = (ms: number): string => `T${ms}`;

describe('REGION_ORDER / REGION_LABEL / orderRegions', () => {
  it('puts global first, because every other region inherits it', () => {
    expect(REGION_ORDER[0]).toBe('global');
  });

  it('labels every region it orders', () => {
    expect(REGION_ORDER.filter((r) => !REGION_LABEL[r])).toEqual([]);
  });

  it('sorts a shuffled payload into card order without touching the caller array', () => {
    const shuffled = [rows[2]!, rows[0]!, rows[3]!, rows[1]!];
    expect(orderRegions(shuffled).map((r) => r.region)).toEqual(['global', 'cn', 'de', 'en']);
    expect(shuffled[0]!.region).toBe('de');
  });

  it('handles a payload missing some regions', () => {
    expect(orderRegions([rows[3]!, rows[0]!]).map((r) => r.region)).toEqual(['global', 'en']);
  });
});

describe('isBlocked', () => {
  it('blocks the two cases the server itself would reject, plus an in-overlay duplicate', () => {
    expect(isBlocked(checkWord('', rows, 'cn'))).toBe(true);
    expect(isBlocked(checkWord('x'.repeat(WORD_MAX + 1), rows, 'cn'))).toBe(true);
    expect(isBlocked(checkWord('代练', rows, 'cn'))).toBe(true);
  });

  it('does NOT block a merely redundant word — that stays advisory', () => {
    expect(isBlocked(checkWord('scammer', rows, 'cn'))).toBe(false);
  });

  it('does not block a genuinely new word', () => {
    expect(isBlocked(checkWord('brandnew', rows, 'cn'))).toBe(false);
  });

  it('treats a region the payload never mentioned as having an empty overlay, not as a crash', () => {
    // Every real response carries all four regions, but the duplicate check has to tolerate a region
    // that is simply absent — otherwise a payload shrinking to three regions would throw here.
    const withoutDe = rows.filter((r) => r.region !== 'de');
    expect(checkWord('brandnew', withoutDe, 'de')).toEqual({ kind: 'ok', word: 'brandnew' });
  });

  it('agrees with checkMessage’s `blocked` flag on every kind — one rule, not three copies', () => {
    for (const raw of ['', 'x'.repeat(WORD_MAX + 1), '代练', 'scammer', 'brandnew']) {
      const c = checkWord(raw, rows, 'cn');
      expect(checkMessage(c)?.blocked ?? false).toBe(isBlocked(c));
    }
  });
});

describe('effectiveSummary', () => {
  it('counts the live list and splits it by source', () => {
    // cn sees: global floor (2) + cn floor (1) + global overlay (1) + cn overlay (1)
    expect(effectiveSummary(rows, 'cn')).toBe('Effective list for cn: 5 words (3 built-in + 2 overlay).');
  });

  it('counts only its own two lists for global itself', () => {
    expect(effectiveSummary(rows, 'global')).toBe('Effective list for global: 3 words (2 built-in + 1 overlay).');
  });

  it('reports zero for an unknown region rather than crashing', () => {
    expect(effectiveSummary([], 'de')).toBe('Effective list for de: 0 words (0 built-in + 0 overlay).');
  });
});

describe('overlayMetaText', () => {
  it('attributes the last overlay write, stamped through the formatter it was handed', () => {
    const row = { ...rows[1]!, updatedBy: 'Ada', updatedAt: 42 };
    expect(overlayMetaText(row, stamp)).toBe('Overlay last written by Ada · T42');
  });

  it('dashes a nameless writer', () => {
    expect(overlayMetaText({ ...rows[1]!, updatedBy: '', updatedAt: 42 }, stamp)).toBe('Overlay last written by — · T42');
  });

  it('says the region is floor-only when no overlay has ever been written', () => {
    expect(overlayMetaText(rows[2]!, stamp)).toBe('No overlay written yet — built-in floor only.');
  });
});

describe('write confirmations', () => {
  it('names the word, the region, and the propagation delay consumers actually have', () => {
    expect(addedText('scam', 'cn')).toBe('Added "scam" to the cn overlay (consumers pick it up within 60s).');
    expect(removedText('scam', 'cn')).toBe('Removed "scam" from the cn overlay (consumers pick it up within 60s).');
    expect(removeTitle('scam', 'de')).toBe('Remove "scam" from the de overlay');
  });
});

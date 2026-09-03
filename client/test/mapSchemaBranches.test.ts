/**
 * `game/campaign/maps/mapSchema.ts` — the rest of the chapter-map validation gate.
 *
 * `mapSchema.test.ts` checks that every bundled chapter parses and that a dangling levelId is
 * rejected. The remaining 10 branches are the other rejections plus the coordinate warning, and
 * they matter for the same reason `levelSchema`'s do: this is the only gate between a
 * hand-authored JSON file and the campaign entry screen, and its two failure modes are
 * deliberately different — a structural problem throws (the build/entry fails loudly), an
 * off-canvas coordinate only warns (the renderer clamps, so one sloppy point must not brick the
 * whole chapter). Each error carries a field path, which is what points an author at the line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseChapterMap, ChapterMapParseError } from '../src/game/campaign/maps/mapSchema';

const REAL_LEVEL = 'ch1_lv1';

function map(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chapter: 1,
    venueKey: 'campaign.ch1.venue',
    nodes: [{ levelId: REAL_LEVEL, x: 0.2, y: 0.3 }],
    ...over,
  };
}

function rejects(fn: () => unknown, path: string, messagePart?: string): void {
  expect(fn).toThrow(ChapterMapParseError);
  try {
    fn();
  } catch (err) {
    expect((err as ChapterMapParseError).path).toBe(path);
    if (messagePart) expect((err as Error).message).toContain(messagePart);
  }
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('top-level shape', () => {
  it('rejects anything that is not a plain object', () => {
    for (const bad of [null, undefined, [], 'ch1', 3]) {
      rejects(() => parseChapterMap(bad, 'ch1.json'), 'ch1.json', 'expected a chapter map object');
    }
  });

  it('requires a positive integer chapter index', () => {
    rejects(() => parseChapterMap(map({ chapter: 0 }), 'c'), 'c.chapter', 'positive chapter index');
    rejects(() => parseChapterMap(map({ chapter: -1 }), 'c'), 'c.chapter', 'positive chapter index');
    rejects(() => parseChapterMap(map({ chapter: 1.5 }), 'c'), 'c.chapter', 'expected an integer');
    rejects(() => parseChapterMap(map({ chapter: '1' }), 'c'), 'c.chapter', 'expected a finite number');
    rejects(() => parseChapterMap(map({ chapter: NaN }), 'c'), 'c.chapter');
  });

  it('requires a string venueKey', () => {
    rejects(() => parseChapterMap(map({ venueKey: 7 }), 'c'), 'c.venueKey', 'expected a string');
  });

  it('requires a non-empty nodes array — an empty chapter has no entry point at all', () => {
    rejects(() => parseChapterMap(map({ nodes: {} }), 'c'), 'c.nodes', 'expected a nodes array');
    rejects(() => parseChapterMap(map({ nodes: [] }), 'c'), 'c.nodes', 'at least one node');
  });

  it('keeps path and decor off the result when they are absent', () => {
    const parsed = parseChapterMap(map(), 'c');
    expect('path' in parsed).toBe(false);
    expect('decor' in parsed).toBe(false);
    expect(parsed).toMatchObject({ chapter: 1, venueKey: 'campaign.ch1.venue' });
  });
});

describe('nodes', () => {
  it('rejects a node that is not an object, naming its index', () => {
    rejects(() => parseChapterMap(map({ nodes: [1] }), 'c'), 'c.nodes[0]', 'expected a node object');
    rejects(
      () => parseChapterMap(map({ nodes: [{ levelId: REAL_LEVEL, x: 0, y: 0 }, null] }), 'c'),
      'c.nodes[1]',
    );
  });

  it('rejects a non-string levelId separately from an unknown one', () => {
    rejects(() => parseChapterMap(map({ nodes: [{ levelId: 3, x: 0, y: 0 }] }), 'c'), 'c.nodes[0].levelId', 'expected a string');
    rejects(
      () => parseChapterMap(map({ nodes: [{ levelId: 'ch9_lv9', x: 0, y: 0 }] }), 'c'),
      'c.nodes[0].levelId',
      "unknown level id 'ch9_lv9'",
    );
    // An empty id is "unknown" rather than "not a string" — it still fails, which is the point.
    rejects(() => parseChapterMap(map({ nodes: [{ levelId: '', x: 0, y: 0 }] }), 'c'), 'c.nodes[0].levelId');
  });

  it('rejects non-numeric node coordinates', () => {
    rejects(() => parseChapterMap(map({ nodes: [{ levelId: REAL_LEVEL, x: '0', y: 0 }] }), 'c'), 'c.nodes[0].x');
    rejects(() => parseChapterMap(map({ nodes: [{ levelId: REAL_LEVEL, x: 0 }] }), 'c'), 'c.nodes[0].y');
  });
});

describe('coordinates', () => {
  it('warns but accepts a coordinate outside 0..1, on each axis and each side', () => {
    // The soft/hard split: the renderer clamps, so a slightly-off authored point must not stop
    // the whole chapter from loading. It has to be visible in the console, though, or the
    // authoring mistake never gets fixed.
    const parsed = parseChapterMap(map({ nodes: [{ levelId: REAL_LEVEL, x: -0.2, y: 1.4 }] }), 'c');
    expect(parsed.nodes[0]).toEqual({ levelId: REAL_LEVEL, x: -0.2, y: 1.4 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside 0..1'));
  });

  it('accepts the exact 0 and 1 boundaries silently', () => {
    parseChapterMap(map({ nodes: [{ levelId: REAL_LEVEL, x: 0, y: 1 }] }), 'c');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('path', () => {
  it("accepts the 'auto' sentinel and an explicit point list", () => {
    expect(parseChapterMap(map({ path: 'auto' }), 'c').path).toBe('auto');
    expect(parseChapterMap(map({ path: [{ x: 0.1, y: 0.2 }] }), 'c').path).toEqual([{ x: 0.1, y: 0.2 }]);
    // An empty explicit list is legal — it means "draw nothing", distinct from omitting the key.
    expect(parseChapterMap(map({ path: [] }), 'c').path).toEqual([]);
  });

  it("rejects anything that is neither 'auto' nor an array", () => {
    rejects(() => parseChapterMap(map({ path: 'straight' }), 'c'), 'c.path', "expected 'auto'");
    rejects(() => parseChapterMap(map({ path: {} }), 'c'), 'c.path', "expected 'auto'");
    rejects(() => parseChapterMap(map({ path: 3 }), 'c'), 'c.path');
  });

  it('rejects a malformed point inside the list, naming its index', () => {
    rejects(() => parseChapterMap(map({ path: [1] }), 'c'), 'c.path[0]', 'expected a point object');
    rejects(() => parseChapterMap(map({ path: [{ x: 0.1, y: 0.2 }, { x: 0.1 }] }), 'c'), 'c.path[1].y');
  });

  it('warns on an out-of-range path point too', () => {
    parseChapterMap(map({ path: [{ x: 2, y: 0.5 }] }), 'c');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('decor', () => {
  it('accepts a decor list and keeps each entry verbatim', () => {
    const parsed = parseChapterMap(map({ decor: [{ kind: 'tree', x: 0.5, y: 0.5 }] }), 'c');
    expect(parsed.decor).toEqual([{ kind: 'tree', x: 0.5, y: 0.5 }]);
    expect(parseChapterMap(map({ decor: [] }), 'c').decor).toEqual([]);
  });

  it('rejects a non-array decor and a malformed entry', () => {
    rejects(() => parseChapterMap(map({ decor: {} }), 'c'), 'c.decor', 'expected a decor array');
    rejects(() => parseChapterMap(map({ decor: ['tree'] }), 'c'), 'c.decor[0]', 'expected a decor object');
    rejects(() => parseChapterMap(map({ decor: [{ x: 0, y: 0 }] }), 'c'), 'c.decor[0].kind', 'expected a string');
    rejects(() => parseChapterMap(map({ decor: [{ kind: 'tree', x: 0 }] }), 'c'), 'c.decor[0].y');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { parseChapterMap, ChapterMapParseError } from '../src/game/campaign/maps/mapSchema';
import { CHAPTER_MAPS, CHAPTER_ORDER } from '../src/game/campaign/maps';
import { CAMPAIGN_LEVELS } from '../src/game/campaign/levels';

/**
 * Chapter-map JSON validation guard (CAMPAIGN_DESIGN §12.3).
 *
 * Maps are JSON (no compile-time safety), so parseChapterMap is the sole gate.
 * These tests confirm every bundled chapter parses, that nodes only reference
 * real levels, and that the validator rejects the malformed shapes it claims to
 * — most importantly a node pointing at a non-existent level id.
 */

const minimal = () => ({
  chapter: 1,
  venueKey: 'campaign.ch1.venue',
  nodes: [{ levelId: 'ch1_lv1', x: 0.2, y: 0.3 }],
});

describe('parseChapterMap', () => {
  it('accepts every bundled chapter map', () => {
    expect(CHAPTER_ORDER).toEqual([1, 2, 3, 4, 5, 6]);
    for (const ch of CHAPTER_ORDER) {
      const map = CHAPTER_MAPS[ch]!;
      expect(map.chapter).toBe(ch);
      expect(map.nodes.length).toBeGreaterThan(0);
      // Every node references a real level.
      for (const node of map.nodes) {
        expect(CAMPAIGN_LEVELS[node.levelId]).toBeDefined();
      }
    }
  });

  it('accepts a minimal valid map', () => {
    expect(() => parseChapterMap(minimal(), 'min')).not.toThrow();
  });

  it('rejects a node pointing at an unknown level id', () => {
    const bad = minimal();
    bad.nodes[0]!.levelId = 'ch9_lv99';
    expect(() => parseChapterMap(bad, 'bad')).toThrow(ChapterMapParseError);
    expect(() => parseChapterMap(bad, 'bad')).toThrow(/unknown level id/);
  });

  it('rejects an empty nodes array', () => {
    const bad: any = minimal();
    bad.nodes = [];
    expect(() => parseChapterMap(bad, 'bad')).toThrow(/at least one node/);
  });

  it('rejects an invalid path value', () => {
    const bad: any = minimal();
    bad.path = 'snake';
    expect(() => parseChapterMap(bad, 'bad')).toThrow(/'auto'/);
  });

  it('warns but accepts out-of-range coordinates (renderer clamps)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oob: any = minimal();
    oob.nodes[0].x = 1.4;
    expect(() => parseChapterMap(oob, 'oob')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/outside 0\.\.1/));
    warn.mockRestore();
  });
});

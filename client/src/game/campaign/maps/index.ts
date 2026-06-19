import type { ChapterMap } from './ChapterMap';
import { parseChapterMap } from './mapSchema';

import ch1 from './ch1.json';
import ch2 from './ch2.json';
import ch3 from './ch3.json';
import ch4 from './ch4.json';
import ch5 from './ch5.json';
import ch6 from './ch6.json';

/**
 * Chapter-map registry (CAMPAIGN_DESIGN §12.3).
 *
 * Each `chN.json` describes one chapter page's spatial layout (node positions,
 * pencil trail, decor). Maps are authored as JSON and bundled at build time;
 * every one is run through {@link parseChapterMap}, which validates structure
 * and rejects any node pointing at a non-existent level — so a malformed map
 * fails fast at module load rather than rendering a dangling node.
 *
 * To add/extend a chapter: edit (or add) its `chN.json`, import it here, and
 * append to {@link CHAPTER_MAPS}.
 */

export type { ChapterMap, ChapterNode, ChapterDecor, NormPoint } from './ChapterMap';
export { parseChapterMap, ChapterMapParseError } from './mapSchema';

const MAP_LIST: ChapterMap[] = [
  parseChapterMap(ch1, 'ch1.json'),
  parseChapterMap(ch2, 'ch2.json'),
  parseChapterMap(ch3, 'ch3.json'),
  parseChapterMap(ch4, 'ch4.json'),
  parseChapterMap(ch5, 'ch5.json'),
  parseChapterMap(ch6, 'ch6.json'),
];

/** All chapter maps, keyed by chapter index. */
export const CHAPTER_MAPS: Record<number, ChapterMap> = Object.fromEntries(
  MAP_LIST.map((m) => [m.chapter, m]),
);

/** Chapter indices in ascending order — drives the table-of-contents page. */
export const CHAPTER_ORDER: number[] = MAP_LIST.map((m) => m.chapter).sort((a, b) => a - b);

/** Look up a chapter map by index, or null if none is authored. */
export function getChapterMap(chapter: number): ChapterMap | null {
  return CHAPTER_MAPS[chapter] ?? null;
}

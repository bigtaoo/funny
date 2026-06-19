import { CAMPAIGN_LEVELS } from '../levels';
import type { ChapterDecor, ChapterMap, ChapterNode, NormPoint } from './ChapterMap';

/**
 * Runtime validator for chapter maps loaded from JSON.
 *
 * Like {@link import('../levelSchema').parseLevelDefinition}, this is the sole
 * guard narrowing raw `unknown` (a bundled `maps/chN.json`) to a typed
 * {@link ChapterMap}. It fails fast with a field-path error on structural
 * problems and — critically — on any `levelId` that does not resolve in
 * CAMPAIGN_LEVELS, so a renamed/missing level can never ship a dangling node.
 *
 * Out-of-range coordinates (outside `0..1`) are a soft warning, not a failure:
 * the renderer clamps, and a slightly-off authored point shouldn't brick the
 * whole campaign entry.
 */

/** Thrown when a chapter map JSON fails validation. `path` locates the bad field. */
export class ChapterMapParseError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ChapterMapParseError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new ChapterMapParseError(path, message);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected a finite number, got ${typeof v}`);
  return v;
}

function int(v: unknown, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n)) fail(path, `expected an integer, got ${n}`);
  return n;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, `expected a string, got ${typeof v}`);
  return v;
}

/** Validate a 0..1 coordinate; out-of-range is a warning, returns the value as-is. */
function coord(v: unknown, path: string): number {
  const n = num(v, path);
  if (n < 0 || n > 1) {
    // eslint-disable-next-line no-console
    console.warn(`[chapterMap] ${path}: coordinate ${n} outside 0..1 (renderer will clamp)`);
  }
  return n;
}

function parseNode(v: unknown, path: string): ChapterNode {
  if (!isObject(v)) fail(path, 'expected a node object');
  const levelId = str(v.levelId, `${path}.levelId`);
  if (!CAMPAIGN_LEVELS[levelId]) {
    fail(`${path}.levelId`, `unknown level id '${levelId}' (not in CAMPAIGN_LEVELS)`);
  }
  return { levelId, x: coord(v.x, `${path}.x`), y: coord(v.y, `${path}.y`) };
}

function parsePoint(v: unknown, path: string): NormPoint {
  if (!isObject(v)) fail(path, 'expected a point object');
  return { x: coord(v.x, `${path}.x`), y: coord(v.y, `${path}.y`) };
}

function parseDecor(v: unknown, path: string): ChapterDecor {
  if (!isObject(v)) fail(path, 'expected a decor object');
  return { kind: str(v.kind, `${path}.kind`), x: coord(v.x, `${path}.x`), y: coord(v.y, `${path}.y`) };
}

/**
 * Narrow raw JSON to a validated {@link ChapterMap}. `ctx` is a label (the file
 * name) prefixed onto error paths so a failure points straight at the source.
 */
export function parseChapterMap(raw: unknown, ctx: string): ChapterMap {
  if (!isObject(raw)) fail(ctx, 'expected a chapter map object');

  const chapter = int(raw.chapter, `${ctx}.chapter`);
  if (chapter < 1) fail(`${ctx}.chapter`, `expected a positive chapter index, got ${chapter}`);

  const venueKey = str(raw.venueKey, `${ctx}.venueKey`) as ChapterMap['venueKey'];

  if (!Array.isArray(raw.nodes)) fail(`${ctx}.nodes`, 'expected a nodes array');
  if (raw.nodes.length === 0) fail(`${ctx}.nodes`, 'expected at least one node');
  const nodes = raw.nodes.map((n, i) => parseNode(n, `${ctx}.nodes[${i}]`));

  const map: ChapterMap = { chapter, venueKey, nodes };

  if (raw.path !== undefined) {
    if (raw.path === 'auto') {
      map.path = 'auto';
    } else if (Array.isArray(raw.path)) {
      map.path = raw.path.map((p, i) => parsePoint(p, `${ctx}.path[${i}]`));
    } else {
      fail(`${ctx}.path`, "expected 'auto' or an array of points");
    }
  }

  if (raw.decor !== undefined) {
    if (!Array.isArray(raw.decor)) fail(`${ctx}.decor`, 'expected a decor array');
    map.decor = raw.decor.map((d, i) => parseDecor(d, `${ctx}.decor[${i}]`));
  }

  return map;
}

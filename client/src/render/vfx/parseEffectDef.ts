/**
 * vfx/parseEffectDef.ts — validate + normalize raw JSON into an EffectDef.
 *
 * Mirrors level-editor's parseLevelDefinition pattern (design V4 / decision): the
 * runtime interpreter lost compile-time protection when effects became data, so
 * this is the single trusted gate. Hard-malformed input throws (caught at build
 * time via the registry); recoverable issues (unknown primitive, bad ease) warn
 * and are dropped/defaulted so one bad layer can't blank an effect.
 *
 * Design doc: design/tools/vfx-editor/DESIGN.md §validation/fault-tolerance
 */
import {
  EffectDef, LayerDef, ParamTrack, Keyframe, Ease, PrimitiveType,
} from './types';

const KNOWN_PRIMITIVES: ReadonlySet<string> = new Set<PrimitiveType>([
  'ring', 'arc', 'spokes', 'dots', 'burst', 'polyline', 'emitter',
]);
const KNOWN_EASES: ReadonlySet<string> = new Set<Ease>([
  'linear', 'easeIn', 'easeOut', 'easeInOut',
]);

function fail(where: string, msg: string): never {
  throw new Error(`VFX parse error in ${where}: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normEase(raw: unknown, where: string): Ease {
  if (raw === undefined) return 'linear';
  if (typeof raw === 'string' && KNOWN_EASES.has(raw)) return raw as Ease;
  console.warn(`VFX: ${where}: unknown ease "${String(raw)}" → linear.`);
  return 'linear';
}

function normTrack(raw: unknown, where: string): ParamTrack {
  if (typeof raw === 'number') return raw;
  if (Array.isArray(raw)) {
    const kfs: Keyframe[] = raw.map((k, i) => {
      if (!isPlainObject(k) || typeof k.t !== 'number' || typeof k.v !== 'number') {
        fail(where, `keyframe[${i}] must have numeric t and v`);
      }
      return { t: k.t as number, v: k.v as number, ease: normEase(k.ease, `${where}[${i}]`) };
    });
    if (kfs.length === 0) fail(where, 'empty keyframe array');
    return kfs;
  }
  if (isPlainObject(raw)) {
    if (typeof raw.from !== 'number' || typeof raw.to !== 'number') {
      fail(where, 'two-point track needs numeric from/to');
    }
    return { from: raw.from as number, to: raw.to as number, ease: normEase(raw.ease, where) };
  }
  fail(where, `param must be number | {from,to} | Keyframe[], got ${typeof raw}`);
}

function normLayer(raw: unknown, idx: number, effId: string): LayerDef | null {
  const where = `${effId}.layers[${idx}]`;
  if (!isPlainObject(raw)) fail(where, 'layer must be an object');
  const type = raw.type;
  if (typeof type !== 'string' || !KNOWN_PRIMITIVES.has(type)) {
    console.warn(`VFX: ${where}: unknown primitive "${String(type)}" → layer dropped.`);
    return null;
  }
  const layer: LayerDef = { type: type as PrimitiveType };

  if (raw.count !== undefined) {
    if (typeof raw.count !== 'number' || raw.count < 1) fail(where, 'count must be a number ≥ 1');
    layer.count = raw.count;
  }
  if (raw.seed !== undefined) {
    if (typeof raw.seed !== 'number') fail(where, 'seed must be a number');
    layer.seed = raw.seed;
  }
  if (raw.z !== undefined) {
    if (typeof raw.z !== 'number') fail(where, 'z must be a number');
    layer.z = raw.z;
  }
  if (raw.boil !== undefined) {
    if (!isPlainObject(raw.boil)) fail(where, 'boil must be an object');
    layer.boil = {
      variants: typeof raw.boil.variants === 'number' ? raw.boil.variants : undefined,
      fps:      typeof raw.boil.fps === 'number' ? raw.boil.fps : undefined,
    };
  }
  if (raw.points !== undefined) {
    if (!Array.isArray(raw.points) || raw.points.some(
      (pt) => !Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number',
    )) fail(where, 'points must be Array<[number, number]>');
    layer.points = raw.points as Array<[number, number]>;
  }
  if (raw.params !== undefined) {
    if (!isPlainObject(raw.params)) fail(where, 'params must be an object');
    const params: Record<string, ParamTrack> = {};
    for (const key of Object.keys(raw.params)) {
      params[key] = normTrack(raw.params[key], `${where}.params.${key}`);
    }
    layer.params = params;
  }
  return layer;
}

/**
 * Validate and normalize one effect's raw JSON.
 * @param raw    parsed JSON object
 * @param source filename/label for error messages
 * @throws on hard-malformed input (missing id/duration, bad track shape).
 */
export function parseEffectDef(raw: unknown, source: string): EffectDef {
  if (!isPlainObject(raw)) fail(source, 'effect must be an object');
  if (typeof raw.id !== 'string' || raw.id.length === 0) fail(source, 'missing string id');
  if (typeof raw.duration !== 'number' || raw.duration <= 0) fail(source, 'duration must be > 0');
  if (!Array.isArray(raw.layers)) fail(source, 'layers must be an array');

  const layers = (raw.layers as unknown[])
    .map((l, i) => normLayer(l, i, raw.id as string))
    .filter((l): l is LayerDef => l !== null);

  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    id: raw.id,
    duration: raw.duration,
    loop: raw.loop === true,
    defaultColor: (typeof raw.defaultColor === 'string' || typeof raw.defaultColor === 'number')
      ? raw.defaultColor : undefined,
    sfxKey: typeof raw.sfxKey === 'string' ? raw.sfxKey : null,
    layers,
  };
}

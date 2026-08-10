// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 2/8).
// The single objective-kind discriminated-union parser.
import type { ObjectiveSpec } from '../LevelDefinition';
import { fail, int, isObject, str } from './helpers';

export function parseObjective(v: unknown, path: string): ObjectiveSpec {
  if (!isObject(v)) fail(path, 'expected an objective object');
  const kind = str(v.kind, `${path}.kind`);
  if (kind === 'survive') return { kind: 'survive' };
  if (kind === 'destroy_base') {
    const spec: Extract<ObjectiveSpec, { kind: 'destroy_base' }> = { kind: 'destroy_base' };
    if (v.durationTicks !== undefined) {
      const durationTicks = int(v.durationTicks, `${path}.durationTicks`);
      if (durationTicks <= 0) fail(`${path}.durationTicks`, `must be > 0, got ${durationTicks}`);
      spec.durationTicks = durationTicks;
    }
    return spec;
  }
  if (kind === 'boss') return { kind: 'boss' };
  if (kind === 'timed_defense') {
    const durationTicks = int(v.durationTicks, `${path}.durationTicks`);
    if (durationTicks <= 0) fail(`${path}.durationTicks`, `must be > 0, got ${durationTicks}`);
    return { kind: 'timed_defense', durationTicks };
  }
  if (kind === 'leak_limit') {
    const maxLeaks = int(v.maxLeaks, `${path}.maxLeaks`);
    if (maxLeaks < 0) fail(`${path}.maxLeaks`, `must be >= 0, got ${maxLeaks}`);
    return { kind: 'leak_limit', maxLeaks };
  }
  if (kind === 'escort') {
    const req = v.required;
    if (req === 'all' || req === 'any') return { kind: 'escort', required: req };
    const n = int(req, `${path}.required`);
    if (n < 1) fail(`${path}.required`, `numeric required must be >= 1, got ${n}`);
    return { kind: 'escort', required: n };
  }
  return fail(`${path}.kind`, `unknown objective kind '${kind}' (expected 'survive' | 'timed_defense' | 'destroy_base' | 'leak_limit' | 'boss' | 'escort')`);
}

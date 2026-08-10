// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 5/8).
import type { HazardSpec } from '../LevelDefinition';
import { fail, int, isObject, num, str } from './helpers';

export function parseHazards(v: unknown, path: string): HazardSpec[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of hazards');
  const effects = new Set(['speed', 'fog', 'lava']);
  return v.map((h, i) => {
    const hp = `${path}[${i}]`;
    if (!isObject(h)) fail(hp, 'expected a hazard object');
    const col = int(h.col, `${hp}.col`);
    if (!Array.isArray(h.rowRange) || h.rowRange.length !== 2) {
      fail(`${hp}.rowRange`, 'expected a [from,to] tuple');
    }
    const effect = str(h.effect, `${hp}.effect`);
    if (!effects.has(effect)) fail(`${hp}.effect`, `unknown hazard effect '${effect}'`);
    const spec: HazardSpec = {
      col,
      rowRange: [int(h.rowRange[0], `${hp}.rowRange[0]`), int(h.rowRange[1], `${hp}.rowRange[1]`)],
      effect: effect as HazardSpec['effect'],
    };
    if (h.speedMult !== undefined) spec.speedMult = num(h.speedMult, `${hp}.speedMult`);
    if (h.rangeMod  !== undefined) spec.rangeMod  = num(h.rangeMod,  `${hp}.rangeMod`);
    if (h.dps       !== undefined) spec.dps       = num(h.dps,       `${hp}.dps`);
    return spec;
  });
}

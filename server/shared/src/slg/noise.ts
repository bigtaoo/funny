// SLG deterministic noise primitives (pure functions, no random source; same input → same output).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]) — shared by province.ts / mapgen.ts.

/** 32-bit integer hash (two coordinates + seed → uint32). */
function hash2(x: number, y: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
/** Coordinates → pseudo-random value in [0,1). */
export function rand2(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}
/** String → 32-bit seed (worldId → world seed). */
export function worldSeed(world: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < world.length; i++) {
    h ^= world.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** Value noise (bilinear interpolation + smoothstep), output [0,1], continuous and smooth — used for biome/level large-zone generation. */
export function valueNoise(x: number, y: number, freq: number, seed: number): number {
  const fx = x * freq;
  const fy = y * freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const s = (t: number) => t * t * (3 - 2 * t); // smoothstep
  const v00 = rand2(x0, y0, seed);
  const v10 = rand2(x0 + 1, y0, seed);
  const v01 = rand2(x0, y0 + 1, seed);
  const v11 = rand2(x0 + 1, y0 + 1, seed);
  const sx = s(tx);
  const sy = s(ty);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

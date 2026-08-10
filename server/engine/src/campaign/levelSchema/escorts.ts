// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 6/8).
import { BOARD_COLS, BOARD_ROWS } from '../../config';
import type { EscortSpec } from '../LevelDefinition';
import { fail, int, isObject, num, str } from './helpers';

export function parseEscorts(v: unknown, path: string): EscortSpec[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(path, 'expected an array of escort specs');
  if (v.length === 0) return [];
  return v.map((e, i) => {
    const ep = `${path}[${i}]`;
    if (!isObject(e)) fail(ep, 'expected an escort spec object');
    const id = str(e.id, `${ep}.id`);
    if (id.length === 0) fail(`${ep}.id`, 'must be a non-empty string');
    const hp    = num(e.hp,    `${ep}.hp`);
    if (hp <= 0) fail(`${ep}.hp`, `must be > 0, got ${hp}`);
    const speed = num(e.speed, `${ep}.speed`);
    if (speed <= 0) fail(`${ep}.speed`, `must be > 0, got ${speed}`);
    const startCol = int(e.startCol, `${ep}.startCol`);
    if (startCol < 0 || startCol >= BOARD_COLS) {
      fail(`${ep}.startCol`, `out of bounds 0..${BOARD_COLS - 1}, got ${startCol}`);
    }
    const startRow = int(e.startRow, `${ep}.startRow`);
    if (startRow < 0 || startRow >= BOARD_ROWS) {
      fail(`${ep}.startRow`, `out of bounds 0..${BOARD_ROWS - 1}, got ${startRow}`);
    }
    const spec: EscortSpec = { id, hp, speed, startCol, startRow };
    if (e.path !== undefined) {
      if (!Array.isArray(e.path)) fail(`${ep}.path`, 'expected an array of waypoints');
      spec.path = (e.path as unknown[]).map((w, j) => {
        const wp = `${ep}.path[${j}]`;
        if (!isObject(w)) fail(wp, 'expected a {col, row} waypoint');
        const wCol = int(w.col, `${wp}.col`);
        const wRow = int(w.row, `${wp}.row`);
        if (wCol < 0 || wCol >= BOARD_COLS) fail(`${wp}.col`, `out of bounds 0..${BOARD_COLS - 1}, got ${wCol}`);
        if (wRow < 0 || wRow >= BOARD_ROWS) fail(`${wp}.row`, `out of bounds 0..${BOARD_ROWS - 1}, got ${wRow}`);
        return { col: wCol, row: wRow };
      });
      // Waypoints must be strictly ascending in row (escort moves toward higher rows).
      for (let j = 1; j < spec.path!.length; j++) {
        if (spec.path![j]!.row <= spec.path![j - 1]!.row) {
          fail(`${ep}.path[${j}].row`, 'waypoint rows must be strictly ascending');
        }
      }
    }
    return spec;
  });
}

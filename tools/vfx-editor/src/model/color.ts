/**
 * color.ts — colour helpers + the editor's fixed preview palette.
 *
 * The palette is intentionally a small set of in-game colours (DESIGN §3.8 V10):
 * the editor validates that an effect reads well under each faction/intent colour
 * rather than offering an arbitrary picker (which would surface colours the game
 * never uses). Runtime colour is supplied by the caller's play(id,x,y,color).
 */

export interface Swatch {
  key: string;
  label: string;
  color: number; // -1 = "use the effect's defaultColor"
}

export const PALETTE: Swatch[] = [
  { key: 'default', label: 'Default',    color: -1 },
  { key: 'ally',    label: 'Ally blue',  color: 0x4a90d9 },
  { key: 'enemy',   label: 'Enemy red',  color: 0xd94a4a },
  { key: 'ink',     label: 'Ink black',  color: 0x222222 },
  { key: 'heal',    label: 'Heal green', color: 0x5fb85f },
  { key: 'warn',    label: 'Warn orange',color: 0xe08a2e },
];

/** Parse "0xRRGGBB" / "#RRGGBB" / number into a hex number, with fallback. */
export function toHex(c: string | number | undefined, fallback = 0x222222): number {
  if (typeof c === 'number' && Number.isFinite(c)) return c >>> 0;
  if (typeof c === 'string') {
    const m = c.trim().replace(/^#/, '').replace(/^0x/i, '');
    const n = parseInt(m, 16);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return fallback;
}

/** Format a hex number as a "0xRRGGBB" string. */
export function toHexString(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(6, '0');
}

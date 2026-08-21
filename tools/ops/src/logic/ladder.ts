// Pure layer for the ladder season page (ADR-070 Phase 4e): the remaining-time readout.
import { plural } from './shared';

const MS_PER_DAY = 86400_000;

/** Days at or below which the readout turns warning-coloured and says so. */
export const WARNING_DAYS = 3;

/**
 * How much of the season is left. `daysLeft` is rounded UP, so the last partial day still reads as
 * "1 day" rather than "0" — an operator deciding whether to roll cares that some of today remains.
 * A season past its end reads "Expired" (not "-2 days"), and `near` also holds there so the colour
 * stays on: an over-running season is exactly when someone should be looking.
 */
export function seasonCountdown(endAt: number, now: number): { daysLeft: number; near: boolean; text: string } {
  const daysLeft = Math.ceil((endAt - now) / MS_PER_DAY);
  const near = daysLeft <= WARNING_DAYS;
  return {
    daysLeft,
    near,
    text: daysLeft > 0 ? `${plural(daysLeft, 'day')}${near ? ' ⚠ ending soon' : ''}` : 'Expired',
  };
}

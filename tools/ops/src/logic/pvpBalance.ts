// Pure layer for the PvP card win-rate report (ADR-070 Phase 4e).
import type { PvpCardStatRow } from '../types';
import { pct } from './shared';

/** 0 for a card nobody played — the table prints an em dash for those, see winRateText. */
export function winRate(r: PvpCardStatRow): number {
  return r.games > 0 ? r.wins / r.games : 0;
}

/** Best win rate first. Copies rather than sorting in place: the caller owns the fetched array. */
export function rankByWinRate(rows: readonly PvpCardStatRow[]): PvpCardStatRow[] {
  return [...rows].sort((a, b) => winRate(b) - winRate(a));
}

/** An em dash, not "0.0%", when there are no games: those two mean very different things here. */
export function winRateText(r: PvpCardStatRow): string {
  return r.games > 0 ? pct(winRate(r)) : '—';
}

/**
 * How far off 50% counts as worth colouring. A deck-level heuristic, not a verdict — see the page
 * intro and design/game/BALANCE.md on why deck-composition win rate over-credits every card in a
 * winning deck.
 */
export const OFF_BALANCE_DELTA = 0.15;

export function isOffBalance(rate: number): boolean {
  return Math.abs(rate - 0.5) >= OFF_BALANCE_DELTA;
}

/** The date input is `YYYY-MM-DD`; the report endpoint wants `YYYYMMDD`. Empty stays undefined. */
export function sinceParam(dateInput: string): string | undefined {
  return dateInput ? dateInput.replace(/-/g, '') : undefined;
}

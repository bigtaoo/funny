export function formatDuration(totalSecRaw: number): string {
  const totalSec = Math.max(0, Math.floor(totalSecRaw));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Splits a millisecond duration into day/hour/minute/second integer parts (negative input
 * clamps to 0) for the `{d}{h}{m}{s}`-style i18n templates — same breakdown AuctionScene's
 * `auction.timeLeft` already uses, reused for the world-map shield/training-speedup buff
 * countdowns (2026-08-08 UI fix: raw "146282s" reads as gibberish, needs 天/时/分/秒 units —
 * those buffs can run well past an hour, so plain mm:ss like formatDuration above isn't
 * enough either).
 */
export function dhmsFromMs(ms: number): { d: number; h: number; m: number; s: number } {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return { d, h, m, s };
}

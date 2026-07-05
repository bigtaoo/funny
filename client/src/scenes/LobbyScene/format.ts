// Pure formatting helpers for LobbyScene — kept free of any PIXI import so they
// can be unit-tested under the game-logic vitest config (see client/test/).

/** Compact coin formatting for the header chip (e.g. 1234 → "1,234", 23456 → "23.5k"). */
export function fmtCoins(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v >= 10000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
  return v.toLocaleString('en-US');
}

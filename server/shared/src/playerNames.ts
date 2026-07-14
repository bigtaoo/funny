// Player-like nickname generator, shared by metaserver (guest/bot default display name) and
// matchsvc (AI-fallback opponent name). Goal: names that read like handles real players would
// pick, so bots and guests are indistinguishable from human accounts. Names are drawn from
// PLAYER_NAME_POOL — a curated sample of real Minecraft player nicknames — so the vocabulary,
// casing and digit distribution match how actual players name themselves (most carry no number).
// Output is always <= MAX_DISPLAY_NAME_LEN (24) and non-empty, so it passes validateDisplayName.
import { randomInt } from 'node:crypto';
import { PLAYER_NAME_POOL } from './playerNamePool';

/** Int source, injectable for deterministic tests. `n(max)` returns an integer in [0, max). Defaults to crypto.randomInt. */
export type IntSource = (max: number) => number;
const defaultInt: IntSource = (max) => randomInt(max);

/**
 * Pick a realistic, player-like display name from the curated pool. Roughly one in six names gets
 * a short trailing number — mirroring how a real player appends digits when their handle is taken,
 * and enough to keep a large bot fleet from showing too many exact-duplicate names, without making
 * numbers the norm. The `+ suffix` never overflows 24 chars: pool names are <= 14 chars.
 */
export function randomPlayerName(n: IntSource = defaultInt): string {
  const base = PLAYER_NAME_POOL[n(PLAYER_NAME_POOL.length)]!;
  if (n(6) !== 0) return base;
  return `${base}${n(900) + 10}`; // 2–3 digit suffix, no leading-zero look
}

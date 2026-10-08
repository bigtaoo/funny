// Ladder rank + ELO (S1-R). Pure functions, **shared between gameserver computation and client display**—
// avoids divergence between display and authoritative values caused by each side maintaining its own rank thresholds.
// Values defined in design/game/ECONOMY_BALANCE.md §2.3 (9 ranks); kept in server config for hot adjustment.

/** Stable ids for the 9 rank tiers (display names are handled by client i18n; the authority stores only the id). */
export type RankId =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'star'
  | 'master'
  | 'grandmaster'
  | 'king';

/** Rank → minimum ELO threshold (ascending). Below the first tier's minimum is always treated as the lowest rank. */
export const RANK_TIERS: ReadonlyArray<{ id: RankId; minElo: number }> = [
  { id: 'bronze', minElo: 0 },
  { id: 'silver', minElo: 1100 },
  { id: 'gold', minElo: 1200 },
  { id: 'platinum', minElo: 1350 },
  { id: 'diamond', minElo: 1500 },
  { id: 'star', minElo: 1700 },
  { id: 'master', minElo: 1900 },
  { id: 'grandmaster', minElo: 2100 },
  { id: 'king', minElo: 2400 },
];

/** Initial ELO for new accounts (matches pvp.elo in makeNewSave). */
export const INITIAL_ELO = 1000;

/** ELO K-factor (maximum ELO swing per game ≈ K). */
export const ELO_K = 32;

/** ELO is never negative. */
export const ELO_FLOOR = 0;

/** K-factor for AI-fallback (bot) matches — a quarter of a real ranked match, so bot matches can't substitute for real climbing. */
export const BOT_ELO_K = 8;

/** AI-fallback matches only move ELO below this threshold (onboarding calibration); at/above it a bot match still counts for the daily task but leaves ELO untouched. */
export const BOT_ELO_THRESHOLD = 1200;

/** Per-extra-streak-level K multiplier step (win streak accelerates gains; loss streak accelerates losses). */
export const STREAK_K_STEP = 0.3;

/** Multiplier cap so an extreme streak can't blow past a bounded swing per game. */
export const STREAK_K_CAP = 2.5;

/**
 * K multiplier from a same-direction streak *entering* this match (i.e. pvp.streak before this game
 * is settled). `streakLen` is the number of consecutive wins (or losses) already stacked — 0/1 is the
 * baseline (no acceleration yet: a single win, or coming off a break, doesn't get a bonus), each
 * additional consecutive result adds STREAK_K_STEP, capped at STREAK_K_CAP.
 */
export function streakMultiplier(streakLen: number): number {
  const level = Math.max(0, streakLen - 1);
  return Math.min(STREAK_K_CAP, 1 + level * STREAK_K_STEP);
}

/** Returns the rank id corresponding to the given ELO. */
export function eloToRank(elo: number): RankId {
  let rank: RankId = RANK_TIERS[0]!.id;
  for (const t of RANK_TIERS) {
    if (elo >= t.minElo) rank = t.id;
    else break; // ascending order: stop as soon as the minimum exceeds the current ELO
  }
  return rank;
}

/**
 * Standard ELO settlement. Expected win probability E_win = 1 / (1 + 10^((loserElo - winnerElo)/400));
 * winner gain = round(winnerK × (1 - E_win)), loser loss = round(loserK × (1 - E_win)) — upsets
 * (low-rated beating high-rated) score more. **Zero-sum only when winnerK === loserK** (the common
 * case, and always true for AI-fallback matches); a win/loss-streak multiplier on one side alone
 * (STREAK_K_STEP, applied by the caller) intentionally breaks zero-sum so streaks can pull a player
 * toward their real bracket faster than their opponent's counter-streak decays.
 */
export function computeEloDelta(
  winnerElo: number,
  loserElo: number,
  opts: { winnerK?: number; loserK?: number } = {},
): { winner: number; loser: number } {
  const winnerK = opts.winnerK ?? ELO_K;
  const loserK = opts.loserK ?? ELO_K;
  const expWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const winnerGain = Math.round(winnerK * (1 - expWin));
  const loserGain = Math.round(loserK * (1 - expWin));
  return { winner: winnerGain, loser: -loserGain };
}

/** New streak value after one game (pvp.streak: positive = win streak, negative = loss streak). */
export function nextStreak(prev: number, won: boolean): number {
  if (won) return prev > 0 ? prev + 1 : 1;
  return prev < 0 ? prev - 1 : -1;
}

/**
 * ELO loss protection (SEASON_DESIGN_IMPL_SPEC.md §15.5). Two slot pools, and each settled ranked
 * game consumes at most ONE slot — new-player slots first, otherwise a daily slot:
 *   - new-player (2026-10-07): an account's first NEWBIE_PROTECT_GAMES settled ranked games, counted
 *     off the lifetime `pvp.wins + pvp.losses` (written only by ranked settlement, kept across seasons);
 *   - daily (2026-10-07): the first DAILY_PROTECT_GAMES settled ranked games of each server-UTC day
 *     (retention.ts `makeDayKey`, the daily-task reset) that did NOT use a new-player slot, counted in
 *     `pvp.dailyProtect`.
 * So a brand-new account gets 6 protected games on its first day (1-3 new-player, 4-6 daily), then 3
 * per day. Wins and losses both use a slot; draws / voided matches never settle, so they don't. A
 * protected loss costs nothing; a protected win settles normally.
 */
export const NEWBIE_PROTECT_GAMES = 3;
/** Daily protection window size: first N settled ranked games per server-UTC day (§15.5). */
export const DAILY_PROTECT_GAMES = 3;

/** Which pool a protected game drew its slot from (transport.proto `EloDelta.protected_kind`; 0 = none). */
export const PROTECT_KIND_NEWBIE = 1;
export const PROTECT_KIND_DAILY = 2;
export type ProtectKind = typeof PROTECT_KIND_NEWBIE | typeof PROTECT_KIND_DAILY;

/** `SaveData.pvp.dailyProtect`: daily slots used on `dayKey`; a different (older) day means 0 used — reset is lazy. */
export interface DailyProtectState {
  dayKey: string;
  used: number;
}

/** The slot a settlement would use: `game` is 1-based within its pool, `total` that pool's size. */
export interface ProtectSlot {
  kind: ProtectKind;
  game: number;
  total: number;
}

/**
 * 1-based index (1..NEWBIE_PROTECT_GAMES) of the new-player slot that the next ranked settlement
 * would use, given the account's settled ranked games *before* it; 0 once the pool is used up.
 */
export function newbieProtectedGame(settledGames: number): number {
  const n = Number.isFinite(settledGames) ? Math.max(0, Math.floor(settledGames)) : NEWBIE_PROTECT_GAMES;
  return n < NEWBIE_PROTECT_GAMES ? n + 1 : 0;
}

/** Daily slots already used on `dayKey` (0 when the stored state is from another day or absent). */
export function dailyProtectUsed(state: DailyProtectState | undefined, dayKey: string): number {
  if (!state || state.dayKey !== dayKey) return 0;
  const used = Number(state.used);
  return Number.isFinite(used) ? Math.max(0, Math.floor(used)) : DAILY_PROTECT_GAMES;
}

/** 1-based index (1..DAILY_PROTECT_GAMES) of the daily slot the next settlement on `dayKey` would use; 0 once used up. */
export function dailyProtectedGame(state: DailyProtectState | undefined, dayKey: string): number {
  const used = dailyProtectUsed(state, dayKey);
  return used < DAILY_PROTECT_GAMES ? used + 1 : 0;
}

/** The slot the next ranked settlement on `dayKey` would use (new-player first, then daily); null = unprotected. */
export function nextProtectSlot(
  settledGames: number,
  daily: DailyProtectState | undefined,
  dayKey: string,
): ProtectSlot | null {
  const n = newbieProtectedGame(settledGames);
  if (n > 0) return { kind: PROTECT_KIND_NEWBIE, game: n, total: NEWBIE_PROTECT_GAMES };
  const d = dailyProtectedGame(daily, dayKey);
  if (d > 0) return { kind: PROTECT_KIND_DAILY, game: d, total: DAILY_PROTECT_GAMES };
  return null;
}

/**
 * `pvp.dailyProtect` after a settlement that used `slot`: only a daily slot advances it (to
 * `{ dayKey, used: slot.game }`, which also performs the lazy day reset); a new-player slot or an
 * unprotected game leaves it as it was.
 */
export function consumeDailyProtect(
  daily: DailyProtectState | undefined,
  dayKey: string,
  slot: ProtectSlot | null,
): DailyProtectState | undefined {
  return slot?.kind === PROTECT_KIND_DAILY ? { dayKey, used: slot.game } : daily;
}

/** Protected ranked games still available on `dayKey`: new-player slots left + daily slots left (the lobby hint). */
export function protectedGamesLeft(
  settledGames: number,
  daily: DailyProtectState | undefined,
  dayKey: string,
): number {
  const nextNewbie = newbieProtectedGame(settledGames);
  const newbieLeft = nextNewbie > 0 ? NEWBIE_PROTECT_GAMES - nextNewbie + 1 : 0;
  return newbieLeft + Math.max(0, DAILY_PROTECT_GAMES - dailyProtectUsed(daily, dayKey));
}

/**
 * One side's settled ELO delta + streak with loss protection applied (`isProtected` = this game drew
 * a slot from {@link nextProtectSlot}). A protected *loss* costs nothing and does not feed the losing
 * streak (it would otherwise amplify the first unprotected loss via the streak K multiplier) — it
 * still breaks a win streak, as any loss does. Wins and unprotected games settle exactly as
 * {@link computeEloDelta} / {@link nextStreak} say.
 */
export function applyLossProtection(
  rawDelta: number,
  prevStreak: number,
  won: boolean,
  isProtected: boolean,
): { delta: number; streak: number } {
  if (won || !isProtected) return { delta: rawDelta, streak: nextStreak(prevStreak, won) };
  return { delta: 0, streak: Math.min(prevStreak, 0) };
}

/**
 * Roll an AI opponent difficulty (1–10, see engine AISystem.ts) for a bot-fallback
 * match, scaled to the player's ELO. Below {@link BOT_ELO_THRESHOLD} draws from the
 * easier half (1–6); at/above it draws from the harder half (5–10) — the 5–6
 * overlap is an intentional transition band around the threshold rather than a
 * hard cliff. `randInt(n)` returns a uniform integer in [0, n); defaults to
 * `Math.random`-based (fine for client display rolls) — callers needing a CSPRNG
 * (matchsvc) should inject `crypto.randomInt`.
 */
export function pickBotDifficulty(
  elo: number,
  randInt: (maxExclusive: number) => number = (n) => Math.floor(Math.random() * n),
): number {
  return elo < BOT_ELO_THRESHOLD ? 1 + randInt(6) : 5 + randInt(6);
}

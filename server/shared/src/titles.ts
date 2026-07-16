// Title system (S10, TITLE_DESIGN.md).
// Pure data + pure functions, shared between server and client.
// TitleId naming convention: ladder.s{N}.{rank} | slg.s{N}.{key} | ach.{key} | event.{key}
import type { RankId } from './ladder';

export type TitleSource = 'ladder' | 'slg' | 'achievement' | 'event';

export interface TitleDef {
  /** Cross-source ordering (higher = more prestigious; auto-equip picks max). Formula = tier base T*1000 + source offset + in-tier index. */
  weight: number;
  source: TitleSource;
  /** i18n full-name key, e.g. title.event.founder.full */
  fullKey: string;
  /** i18n short-label key (≤4 chars), e.g. title.event.founder.short */
  shortKey: string;
}

// ── Ladder rank weights (by TITLE_DESIGN §6.1 T-tier bands) ─────────────────────────────
// Source offset: ladder +0 (in-tier indices occupy 0..9)
export const LADDER_RANK_WEIGHTS: Readonly<Record<RankId, number>> = {
  bronze:       1000, // T1
  silver:       1001,
  gold:         2000, // T2
  platinum:     2001,
  diamond:      3000, // T3
  star:         3001,
  master:       4000, // T4
  grandmaster:  4001,
  king:         5000, // T5
};

// ── Permanent / event title definition table (non-seasonal) ────────────────────────────────────────────
// Seasonal titles (ladder.s{N}.{rank} / slg.s{N}.*) are constructed dynamically; weights derived from LADDER_RANK_WEIGHTS.
export const TITLE_DEFS: Readonly<Record<string, TitleDef>> = {
  // — Event —
  'event.newbie': {
    weight: 1300,
    source: 'event',
    fullKey:  'title.event.newbie.full',
    shortKey: 'title.event.newbie.short',
  },
  'event.founder': {
    weight: 6300,
    source: 'event',
    fullKey:  'title.event.founder.full',
    shortKey: 'title.event.founder.short',
  },
  // — Achievement titles —
  'ach.all_chapters': {
    weight: 5200, // T5 top-tier achievement
    source: 'achievement',
    fullKey:  'title.ach.all_chapters.full',
    shortKey: 'title.ach.all_chapters.short',
  },
  'ach.pvp.veteran': {
    weight: 4200, // T4 high-tier PvP
    source: 'achievement',
    fullKey:  'title.ach.pvp.veteran.full',
    shortKey: 'title.ach.pvp.veteran.short',
  },
};

/**
 * Starter title every account owns from creation (TITLE_DESIGN §6, "新号起步称号").
 * Granted at save creation (makeNewSave) and lazily backfilled for pre-existing accounts on save read.
 * T1 weight (1300), so it never overrides a title the player actually earned.
 */
export const STARTER_TITLE = 'event.newbie';

// ── Weight lookup (supports dynamic seasonal titleId) ────────────────────────────────────────────

/** Returns the weight for any titleId. Dynamic seasonal titleIds are derived from LADDER_RANK_WEIGHTS; unknown titles return 0. */
export function titleWeight(titleId: string): number {
  if (titleId in TITLE_DEFS) return TITLE_DEFS[titleId]!.weight;
  // ladder.s{N}.{rank}
  const lm = titleId.match(/^ladder\.s\d+\.(\w+)$/);
  if (lm) return LADDER_RANK_WEIGHTS[lm[1] as RankId] ?? 0;
  // slg.s{N}.{key} — SLG seasonal title (§3; placeholder using T3 base; configure actual weight at launch)
  if (/^slg\.s\d+\./.test(titleId)) return 3500;
  return 0;
}

/** Returns the short-label i18n key for a titleId (used in compact displays such as leaderboards and nameplates). */
export function titleShortKey(titleId: string): string {
  if (titleId in TITLE_DEFS) return TITLE_DEFS[titleId]!.shortKey;
  // ladder.s{N}.{rank} → dynamically assembled; client prepends the S{N} prefix
  const lm = titleId.match(/^ladder\.s(\d+)\.(\w+)$/);
  if (lm) return `title.ladder.short`; // client assembles with formatLadderTitle
  return '';
}

// ── Grant logic (pure function; call before writing to the database to compute new state) ─────────────────────────

export interface TitleGrantResult {
  titles: string[];
  equippedTitle: string | undefined;
}

/**
 * Grants newTitleId to the player and updates the equipped slot following the "auto-equip highest/newest" rule (TITLE_DESIGN §6).
 * Pure function; the caller is responsible for atomically persisting the result.
 *
 * Algorithm:
 *   1. $addToSet (idempotent); new titleId appended at the end
 *   2. If new weight > current equipped weight → auto-equip the new title
 *   3. If weights are equal → take the last entry in titles (most recently acquired)
 *   4. No title equipped → auto-equip the new title
 */
export function grantTitle(
  prevTitles: string[],
  prevEquipped: string | undefined,
  newTitleId: string,
): TitleGrantResult {
  const alreadyHas = prevTitles.includes(newTitleId);
  const titles = alreadyHas ? prevTitles : [...prevTitles, newTitleId];

  const newW = titleWeight(newTitleId);
  const curW = prevEquipped ? titleWeight(prevEquipped) : -1;

  let equippedTitle = prevEquipped;
  if (!equippedTitle) {
    // No title equipped → auto-equip
    equippedTitle = newTitleId;
  } else if (newW > curW) {
    // New title has higher tier → auto-equip it
    equippedTitle = newTitleId;
  } else if (newW === curW && !alreadyHas) {
    // Same tier, newly acquired → take the newer one (higher tail index = just-appended newTitleId)
    equippedTitle = newTitleId;
  }

  return { titles, equippedTitle };
}

/** Builds a ladder seasonal title id. */
export function ladderTitleId(seasonNo: number, rank: RankId): string {
  return `ladder.s${seasonNo}.${rank}`;
}

/**
 * Derives the source and season number from a titleId (pure function; shared between server GET /titles and client display).
 * Naming convention: ladder.s{N}.{rank} | slg.s{N}.{key} | ach.{key} | event.{key}.
 * Note: grant time (grantedAt) is not persisted (titles stores only the id sequence), so it is not derived here.
 */
export function parseTitleId(titleId: string): { source: TitleSource; seasonNo?: number } {
  const lm = titleId.match(/^ladder\.s(\d+)\./);
  if (lm) return { source: 'ladder', seasonNo: Number(lm[1]) };
  const sm = titleId.match(/^slg\.s(\d+)\./);
  if (sm) return { source: 'slg', seasonNo: Number(sm[1]) };
  if (titleId.startsWith('event.')) return { source: 'event' };
  // Remaining (ach.* and table-defined entries) default to achievement source; explicit source in the table takes precedence.
  if (titleId in TITLE_DEFS) return { source: TITLE_DEFS[titleId]!.source };
  return { source: 'achievement' };
}

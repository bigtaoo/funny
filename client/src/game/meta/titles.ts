// Title system client module (S10, TITLE_DESIGN §2).
// Client-local mirror of @nw/shared — no Node dependency, pure TS.
// Shares data/algorithms with server/shared/src/titles.ts; changes must be kept in sync on both sides.

export type TitleSource = 'ladder' | 'slg' | 'achievement' | 'event';

export interface TitleDef {
  weight: number;
  source: TitleSource;
  fullKey: string;
  shortKey: string;
}

// ── Ladder rank weights ────────────────────────────────────────────────────
const LADDER_RANK_WEIGHTS: Readonly<Record<string, number>> = {
  bronze:       1000,
  silver:       1001,
  gold:         2000,
  platinum:     2001,
  diamond:      3000,
  star:         3001,
  master:       4000,
  grandmaster:  4001,
  king:         5000,
};

// ── SLG season title weights (mirror of @nw/shared SLG_TITLE_WEIGHTS) ────────
const SLG_TITLE_WEIGHTS: Readonly<Record<string, number>> = {
  champion: 5500,
  top3:     4500,
};
const SLG_TITLE_WEIGHT_DEFAULT = 3500;

// ── Permanent / event title definition table ───────────────────────────────
export const TITLE_DEFS: Readonly<Record<string, TitleDef>> = {
  'event.newbie': {
    weight: 1300, source: 'event',
    fullKey: 'title.event.newbie.full', shortKey: 'title.event.newbie.short',
  },
  'event.founder': {
    weight: 6300, source: 'event',
    fullKey: 'title.event.founder.full', shortKey: 'title.event.founder.short',
  },
  'ach.all_chapters': {
    weight: 5200, source: 'achievement',
    fullKey: 'title.ach.all_chapters.full', shortKey: 'title.ach.all_chapters.short',
  },
  'ach.pvp.veteran': {
    weight: 4200, source: 'achievement',
    fullKey: 'title.ach.pvp.veteran.full', shortKey: 'title.ach.pvp.veteran.short',
  },
};

// ── Weight lookup ──────────────────────────────────────────────────────────

export function titleWeight(titleId: string): number {
  if (titleId in TITLE_DEFS) return TITLE_DEFS[titleId]!.weight;
  const lm = titleId.match(/^ladder\.s\d+\.(\w+)$/);
  if (lm) return LADDER_RANK_WEIGHTS[lm[1]!] ?? 0;
  const sm = titleId.match(/^slg\.s\d+\.(\w+)$/);
  if (sm) return SLG_TITLE_WEIGHTS[sm[1]!] ?? SLG_TITLE_WEIGHT_DEFAULT;
  return 0;
}

/**
 * Get the i18n keys for the equipped title (full name / short label).
 * Dynamic season titles (ladder.s{N}.{rank} / slg.s{N}.{key}) are not in TITLE_DEFS; SLG uses per-key keys,
 * ladder uses a single key + formatLadderTitle for the S{N} part.
 */
export function getTitleKeys(titleId: string): { fullKey: string; shortKey: string } | null {
  if (titleId in TITLE_DEFS) {
    const d = TITLE_DEFS[titleId]!;
    return { fullKey: d.fullKey, shortKey: d.shortKey };
  }
  if (/^ladder\.s\d+\./.test(titleId)) {
    return { fullKey: 'title.ladder.full', shortKey: 'title.ladder.short' };
  }
  // slg.s{N}.{key} → per-key i18n (title.slg.champion.full / title.slg.top3.short, …)
  const sm = titleId.match(/^slg\.s\d+\.(\w+)$/);
  if (sm) {
    return { fullKey: `title.slg.${sm[1]}.full`, shortKey: `title.slg.${sm[1]}.short` };
  }
  return null;
}

/**
 * Format the display text for a ladder season title (for dynamic parts that i18n cannot cover).
 * Returns a short "S{N} {rank}" string for the UI to concatenate alongside the i18n key.
 */
export function formatLadderTitle(titleId: string): string {
  const m = titleId.match(/^ladder\.s(\d+)\.(\w+)$/);
  if (!m) return titleId;
  return `S${m[1]} ${m[2]}`;
}

/**
 * Format the fallback display text for an SLG season title (used only when its i18n key is missing).
 * Returns "S{N} {key}"; the season stamp gives the prize its year.
 */
export function formatSlgTitle(titleId: string): string {
  const m = titleId.match(/^slg\.s(\d+)\.(\w+)$/);
  if (!m) return titleId;
  return `S${m[1]} ${m[2]}`;
}

/**
 * Find the best titleId in the titles array (highest weight; for equal weight, take the last one).
 * Used for TitlesScene initial display — equipped['title'] is the authoritative equipped slot,
 * but this function decides which title to highlight when rendering the titles wall.
 */
export function highestTitle(titles: string[]): string | undefined {
  if (titles.length === 0) return undefined;
  return titles.reduce((best, cur) => {
    const bw = titleWeight(best);
    const cw = titleWeight(cur);
    if (cw > bw) return cur;
    if (cw === bw) return cur; // take the last (more recent) on tie
    return best;
  });
}

/** Sort the titles list in descending weight order (stable: equal weights preserve original order). */
export function sortTitlesByWeight(titles: string[]): string[] {
  return [...titles].sort((a, b) => titleWeight(b) - titleWeight(a));
}

/**
 * Full title-wall catalog: every fixed title (event/achievement, always shown so the
 * player can see what's ungained and how to earn it) plus any owned dynamic
 * (ladder/slg seasonal) titles, deduped. Seasonal titles the player never earned
 * aren't enumerated — there's no fixed catalog for past/future seasons.
 */
export function allTitleIds(owned: string[]): string[] {
  const fixed = Object.keys(TITLE_DEFS);
  const dynamicOwned = owned.filter((id) => !(id in TITLE_DEFS));
  return [...fixed, ...dynamicOwned];
}

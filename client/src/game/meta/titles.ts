// Title system client module (S10, TITLE_DESIGN §2) — the DISPLAY half.
//
// The data half (TITLE_DEFS, the ladder/SLG weight bands, titleWeight) used to be hand-copied here
// with a header asking for both sides to "be kept in sync". It no longer is: server/shared's
// titles.ts has no runtime imports (its single `import type { RankId }` comes from ladder.ts,
// which is import-free too, and erases at compile time), so it is browser-safe on its own and is
// aliased as `@nw/shared/titles` — the treatment cards.ts / equipment.ts / battlepass.ts already
// had (ADR-087). The two TITLE_DEFS tables were verified identical (modulo line breaks) before the
// copy was deleted.
//
// What stays local is what the server has no use for: the i18n key lookup and the two dynamic-part
// formatters (the server has titleShortKey for its own purposes, but the client needs BOTH keys
// plus the "S{N} {rank}" text i18n cannot express), and the two title-wall list helpers.
import { TITLE_DEFS, titleWeight } from '@nw/shared/titles';

export type { TitleDef, TitleSource } from '@nw/shared/titles';
export {
  /** Fixed (event/achievement) title catalog; seasonal titles are constructed dynamically. */
  TITLE_DEFS,
  /** Weight for any titleId — fixed table, ladder rank band, SLG key band, else 0. */
  titleWeight,
} from '@nw/shared/titles';

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

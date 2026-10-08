import type { PlayerStats } from '@nw/engine/types';
import { t } from '../../i18n';
import type { IconKind } from '../../render/icons';

/** Result-screen badge definitions and scoring (pure — no PIXI). */

export interface Badge {
  key: string;
  /** Hand-drawn glyph shown on the badge medallion. */
  icon: IconKind;
  /** Resolved lazily via t() so the active locale is applied at build time. */
  title: () => string;
  detail: (s: PlayerStats) => string;
  /** Bare stat number for the medallion (no unit/sentence). */
  value: (s: PlayerStats) => string;
  score: (s: PlayerStats) => number;
}

/**
 * Divisors below calibrate each badge's raw stat to a roughly comparable "how
 * notable was this" scale (~1.0 = a solid performance). Without this, raw
 * magnitudes aren't comparable across units — e.g. BUILDER's tick-sum over
 * every surviving building dwarfs a base-HP-scale damage number by 30-100x,
 * so it silently won almost every match regardless of actual performance.
 */
const REF_DAMAGE   = 150; // ~1.5x BASE_HP=100, a strong hit/defense on the enemy/own base
const REF_UNITS    = 60;  // units sent in a busy match
const REF_BUILD_S  = 250; // seconds of building-survival summed across buildings
const REF_HITS     = 5;   // spell hits in a spell-heavy match
// kills-per-100-ink ratio. EFFICIENT is the only badge scored as an (unbounded)
// *rate* rather than a bounded magnitude, so its reference must match REAL play
// or it silently wins almost every match: a solid game runs ~8-13 kills/100 ink
// (a unit costs ~4-6 ink and typically trades for ≥1 enemy), so REF=5 scored
// ~1.6-2.6x while the other badges peak near ~1.0. Calibrated to 12 so a solid
// game centers at ~1.0 and it only wins when you were genuinely ink-efficient.
const REF_EFFICIENT = 12; // kills-per-100-ink ratio (see note above)

const BADGES: Badge[] = [
  {
    key:    'TOP_DMG',
    icon:   'swords',
    title:  () => t('badge.topDmg.title'),
    detail: (s) => t('badge.topDmg.detail', { n: s.damageDealtToBase }),
    value:  (s) => t('badge.topDmg.short', { n: s.damageDealtToBase }),
    score:  (s) => s.damageDealtToBase / REF_DAMAGE,
  },
  {
    key:    'IRON_WALL',
    icon:   'armor',
    title:  () => t('badge.ironWall.title'),
    detail: (s) => t('badge.ironWall.detail', { n: s.damageTakenByBase }),
    value:  (s) => t('badge.ironWall.short', { n: s.damageTakenByBase }),
    // Was `-damageTakenByBase`, which is never > 0 for a real damage value — this
    // badge could never actually be picked. Score rewards taking less than REF_DAMAGE.
    score:  (s) => (REF_DAMAGE - s.damageTakenByBase) / REF_DAMAGE,
  },
  {
    key:    'FLOOD',
    icon:   'flag',
    title:  () => t('badge.flood.title'),
    detail: (s) => t('badge.flood.detail', { n: s.unitsSent }),
    value:  (s) => t('badge.flood.short', { n: s.unitsSent }),
    score:  (s) => s.unitsSent / REF_UNITS,
  },
  {
    key:    'BUILDER',
    icon:   'castle',
    title:  () => t('badge.builder.title'),
    detail: (s) => t('badge.builder.detail', { n: Math.round(s.buildingSurvivalTicks / 30) }),
    value:  (s) => t('badge.builder.short', { n: Math.round(s.buildingSurvivalTicks / 30) }),
    score:  (s) => (s.buildingSurvivalTicks / 30) / REF_BUILD_S,
  },
  {
    key:    'PRECISION',
    icon:   'atkspd',
    title:  () => t('badge.precision.title'),
    detail: (s) => t('badge.precision.detail', { n: s.spellHits }),
    value:  (s) => t('badge.precision.short', { n: s.spellHits }),
    score:  (s) => s.spellHits / REF_HITS,
  },
  {
    key:    'EFFICIENT',
    icon:   'coin',
    title:  () => t('badge.efficient.title'),
    detail: (s) => t('badge.efficient.detail', { n: s.unitsKilled }),
    value:  (s) => t('badge.efficient.short', { n: s.unitsKilled }),
    score:  (s) => (s.goldSpent > 0 ? (s.unitsKilled / s.goldSpent * 100) / REF_EFFICIENT : 0),
  },
];

/** How the match ended for the local player — the badges only praise a match that wasn't lost. */
export type MatchOutcome = 'win' | 'loss' | 'draw';

export function computeBadges(stats: PlayerStats, outcome: MatchOutcome): Badge[] {
  // A defeat gets no praise: "[Iron Defense]" over a destroyed base read as a contradiction
  // (CrazyGames review audit, 2026-10-07). The loss screen shows `result.keepGoing` instead.
  if (outcome === 'loss') return [];
  // Return up to 3 badges with score > 0, sorted by score descending
  return BADGES
    .filter((b) => b.score(stats) > 0)
    .sort((a, b) => b.score(stats) - a.score(stats))
    .slice(0, 3);
}

/**
 * Telemetry payload for the `match_badges` analytics event (ANALYTICS_DESIGN §5.8).
 * Uses the SAME {@link computeBadges} the scene renders from, so the logged `hero`/
 * `shown` can never drift from what the player actually saw. The raw stat inputs are
 * carried too so the backend can recalibrate the REF_* constants above from real
 * distributions instead of estimates (badge_dist ops dashboard).
 */
export function matchBadgeTelemetry(local: PlayerStats, outcome: MatchOutcome): Record<string, unknown> {
  const keys = computeBadges(local, outcome).map((b) => b.key);
  return {
    hero: keys[0] ?? 'none', // top badge = the "title" the player sees; 'none' if all scores ≤ 0
    shown: keys,             // up to 3 medallions shown, hero first
    kills: local.unitsKilled,
    gold_spent: local.goldSpent,
    units_sent: local.unitsSent,
    dmg_dealt: local.damageDealtToBase,
    dmg_taken: local.damageTakenByBase,
    spell_hits: local.spellHits,
    build_ticks: local.buildingSurvivalTicks,
  };
}


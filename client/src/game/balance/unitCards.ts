// Client-side unit progression card constants — mirrors @nw/shared/unitCards but does not import it (shared carries a mongo dependency).
// Keep both copies in sync when changing any values.
export const MERGE_COPIES = 5;
export const UNIT_CARD_MAX_LEVEL = 9;

export const PROGRESSABLE_UNIT_IDS = ['infantry', 'max', 'shieldbearer', 'lena', 'archer', 'mara'] as const;
export type ProgressableUnitId = (typeof PROGRESSABLE_UNIT_IDS)[number];

export function cardKey(unitId: string, level: number): string {
  return `${unitId}:${level}`;
}

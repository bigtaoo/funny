import interludeCh1Url from '../assets/story/interlude_ch1_debate.png';
import interludeCh2Url from '../assets/story/interlude_ch2_argument.png';
import interludeCh3Url from '../assets/story/interlude_ch3_notebooks.png';
import interludeCh4Url from '../assets/story/interlude_ch4_confide.png';
import interludeCh5Url from '../assets/story/interlude_ch5_falter.png';
import interludeCh6Url from '../assets/story/interlude_epilogue_desk.png';
import type { LevelDefinition, OwnerId } from '../game';
import type { TranslationKey } from '../i18n';

/**
 * Chapter-end "real layer" interlude art — Tao/Anna's real-world relationship beats running
 * alongside the six-chapter campaign (world.md「章末真实层：涛与 Anna」). Keyed by chapter
 * number (1-6); each chapter's last level (`chN_lv10.json`) carries the matching
 * `story.realLayerKey` i18n key (see `LevelDefinition.ts`). Prompts + design notes in
 * `chapter-interlude-art-prompts.md`.
 */
export const REAL_LAYER_INTERLUDE_ART: Readonly<Record<number, string>> = {
  1: interludeCh1Url,
  2: interludeCh2Url,
  3: interludeCh3Url,
  4: interludeCh4Url,
  5: interludeCh5Url,
  6: interludeCh6Url,
};

/**
 * Decides whether a just-finished match should chain into the chapter-end illustrated
 * interlude, and if so, with which art + text. Pulled out of `nav/game.ts`'s `onGameEnd` as a
 * pure function so the win/realLayerKey/chapter-lookup branching is unit-testable without
 * driving an actual match: only local-player wins (`winner === 0`) on a level whose
 * `story.realLayerKey` is set (i.e. that chapter's last level) qualify; everything else — a
 * loss, a draw, or a level with no `realLayerKey` — returns `undefined`.
 */
export function resolveRealLayerInterlude(
  level: LevelDefinition,
  winner: OwnerId | null,
): { illustrationUrl: string; textKey: TranslationKey } | undefined {
  if (winner !== 0) return undefined;
  const textKey = level.story?.realLayerKey as TranslationKey | undefined;
  if (!textKey) return undefined;
  const illustrationUrl = REAL_LAYER_INTERLUDE_ART[level.chapter];
  if (!illustrationUrl) return undefined; // defensive — every chapter 1-6 is mapped above
  return { illustrationUrl, textKey };
}

import interludeCh1Url from '../assets/story/interlude_ch1_debate.png';
import interludeCh2Url from '../assets/story/interlude_ch2_argument.png';
import interludeCh3Url from '../assets/story/interlude_ch3_notebooks.png';
import interludeCh4Url from '../assets/story/interlude_ch4_confide.png';
import interludeCh5Url from '../assets/story/interlude_ch5_falter.png';
import interludeCh6Url from '../assets/story/interlude_epilogue_desk.png';

/**
 * Chapter-end "real layer" interlude art — Tao/Anna's real-world relationship beats running
 * alongside the six-chapter campaign (world.md「章末真实层：陶与 Anna」). Keyed by chapter
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

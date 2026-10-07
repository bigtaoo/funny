// The three guided beats of the tutorial level (ONBOARDING_DESIGN §11.3) and the director's timing — data for TutorialDirector,
// split out of it for the 500-line rule (claudedocs/client-modules.md).
import { t } from '../../i18n';
import type { TutorialBeatDone } from './types';

export type BeatKind = TutorialBeatDone['beat'];

export interface BeatSpec {
  cardId: string;
  kind: BeatKind;
  /** Lane the guided card goes to (unit/building); for the spell, the lane the cluster walks down. */
  col: number;
  /** Run the engine to this tick (this beat's enemies on the board), then freeze and prompt. */
  setupTick: number;
}

// Tuned with a headless run of ch0_tutorial.json (waves @2 lane 4, @100 lane 7 ×3, @230 lanes 2+3 ×2;
// laneLength shortens those lanes so nobody walks for 15 s; enemyScale.hp makes every enemy die to one
// tower arrow / one infantry exchange):
//   tick 45  Beat 1 — red soldier ~1.5 rows in → drop infantry → it is dead by ~tick 125
//   tick 140 Beat 2 — 3 soldiers coming down lane 7 → drop tower → last one falls ~tick 280
//   tick 268 Beat 3 — 4 soldiers bunched in lanes 2/3 → meteor clears all four at once
export const BEATS: readonly BeatSpec[] = [
  { cardId: 'infantry_1', kind: 'unit',     col: 4, setupTick: 45 },
  { cardId: 'tower_1',    kind: 'building', col: 7, setupTick: 140 },
  { cardId: 'meteor_1',   kind: 'spell',    col: 2, setupTick: 268 },
];

export const BEAT_STEP_KEY: Record<BeatKind, string> = {
  unit: 'beat_unit',
  building: 'beat_building',
  spell: 'beat_spell',
};

/** Instruction + post-release feedback per beat (read at draw time — the locale can change). */
export function beatText(kind: BeatKind): { title: string; body: string; done: string | null } {
  switch (kind) {
    case 'unit': return { title: t('tutorial.b1.title'), body: t('tutorial.b1.body'), done: t('tutorial.b1.done') };
    case 'building': return { title: t('tutorial.b2.title'), body: t('tutorial.b2.body'), done: t('tutorial.b2.done') };
    case 'spell': return { title: t('tutorial.b3.title'), body: t('tutorial.b3.body'), done: null };
  }
}

// ── Director timing (seconds unless noted) ──

/** Seconds of no card touch before the ghost-hand demo starts, per beat (§11.4). */
export const IDLE_GHOST_SEC = [2, 4, 4];
/** Ghost-hand loop: glide, then hold on the target. */
export const GHOST_MOVE_SEC = 1.2;
export const GHOST_HOLD_SEC = 0.6;
/** Base labels: fully visible for this long, then fade. */
export const BASE_LABEL_HOLD_SEC = 2.6;
export const BASE_LABEL_FADE_SEC = 0.4;
/** Post-release feedback line lifetime (then fades over STRIP_FADE_SEC). */
export const FEEDBACK_SEC = 2;
export const STRIP_FADE_SEC = 0.3;
/** Finale: wait at most this long for the field to clear after the meteor, then this beat before WIN. */
export const FINALE_MAX_SEC = 2;
export const FINALE_PAUSE_SEC = 0.5;
/** WIN banner → graduation card. */
export const GRAD_CARD_DELAY_SEC = 0.5;
export const GRAD_POP_SEC = 0.25;
/** Meteor screen shake. */
export const SHAKE_SEC = 0.35;
export const SHAKE_AMP = 9;
/** A drop this many cells off the guided target still counts (and is snapped onto it). */
export const LANE_SNAP_COLS = 1;
export const METEOR_SNAP_CELLS = 2;

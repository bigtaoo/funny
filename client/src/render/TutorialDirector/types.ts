// Shared by TutorialDirector.ts and panels.ts (claudedocs/client-modules.md "单文件 500 行收敛").
// 'intro' = opening seconds (engine running, base labels up), 'beat' = the three guided plays,
// 'finale' = meteor landed, waiting for the field to clear, 'graduate' = win card up, 'done' = left.
export type Phase = 'intro' | 'beat' | 'finale' | 'graduate' | 'done';

/** Per-beat completion record for the `tutorial_beat_done` analytics event (ONBOARDING_DESIGN §11.9). */
export interface TutorialBeatDone {
  beat: 'unit' | 'building' | 'spell';
  /** Real time between the prompt appearing and the guided card landing. */
  idle_ms: number;
  /** Whether the ghost-hand demo played at least once during this beat. */
  ghost_shown: boolean;
  /** Drops of a wrong card / onto a wrong spot during this beat. */
  wrong_drops: number;
}

/** What the scene hands the tutorial director (GameSceneOptions.tutorial). */
export interface TutorialConfig {
  /** Graduation card button label. */
  ctaLabel: string;
  /** Optional reward line under the graduation message (only when it is true for this player). */
  teaser?: string;
  /** Step-level analytics (A9-9); keys match analyticsvc's TUTORIAL_ORDERED_KEYS. */
  onStep?(stepKey: string): void;
  onBeatDone?(info: TutorialBeatDone): void;
}

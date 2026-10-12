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
  /**
   * Optional small print at the foot of the graduation card — the notice-only build's analytics
   * notice (COMPLIANCE_GLOBAL §3.3b), so a player who plays straight on into level 1 has read it
   * within the first minute. {@link onFootnoteShown} fires once, when the card pops in.
   */
  footnote?: string;
  onFootnoteShown?(): void;
  /**
   * Seconds after the graduation card has landed before it presses its own button, with a bar
   * filling along the button's foot meanwhile (ONBOARDING_DESIGN §13). Absent = wait for the tap.
   * Set only on the fresh-account path, where the button leads into ch1_lv1: in the first week on
   * CrazyGames 11% of sessions ended on this card, idle 5–20 s, while players who went on tapped it
   * within 2 s (p90 4 s) — a WIN stamp read as "the game is over".
   */
  autoContinueSec?: number;
  /** Step-level analytics (A9-9); keys match analyticsvc's TUTORIAL_ORDERED_KEYS. */
  onStep?(stepKey: string): void;
  onBeatDone?(info: TutorialBeatDone): void;
}

// Shared by TutorialDirector.ts and panels.ts (claudedocs/client-modules.md "单文件 500 行收敛").
// 'intro' = opening seconds (engine running, base labels up), 'beat' = the three guided plays,
// 'free' = after the meteor (ONBOARDING_DESIGN §17.1): every card plays, the remaining waves run and a new
// card unlocks mid-fight; 'graduate' = WIN in (card up only when it carries a notice), 'done' = left.
export type Phase = 'intro' | 'beat' | 'free' | 'graduate' | 'done';

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

/**
 * One free-phase idle prompt for the `tutorial_idle_prompt` event (ONBOARDING_DESIGN §17.7): 'shown'
 * when the fight freezes on it, 'resumed' at the play that lifts it. Tells a player who left on the
 * frozen prompt apart from one who left mid-fight.
 */
export interface TutorialIdlePrompt {
  outcome: 'shown' | 'resumed';
  /** 1-based count of prompts this run. */
  n: number;
  /** Engine tick the fight froze at ('shown' only). */
  tick?: number;
  /** Real time the prompt was up ('resumed' only). */
  wait_ms?: number;
}

/** What the scene hands the tutorial director (GameSceneOptions.tutorial). */
export interface TutorialConfig {
  /**
   * Graduation card button label. The card itself only shows when it has a {@link footnote} to carry
   * (§17.1); otherwise the WIN stamp leaves on its own after a beat.
   */
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
  /**
   * Step-level analytics (A9-9); keys match analyticsvc's TUTORIAL_ORDERED_KEYS, plus `free_won` —
   * the free fight settled, before the WIN stamp / graduation card (§17.7).
   */
  onStep?(stepKey: string): void;
  /**
   * Tick of the level's last scripted spawn. The free phase calls the win this long plus
   * FREE_SETTLE_TICKS after it, should the engine not have settled by then (§17.1).
   */
  lastSpawnTick?: number;
  onBeatDone?(info: TutorialBeatDone): void;
  onIdlePrompt?(info: TutorialIdlePrompt): void;
}

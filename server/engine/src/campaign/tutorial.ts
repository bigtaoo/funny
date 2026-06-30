// Tutorial level constants (ONBOARDING_DESIGN §3). The engine uses them to select TutorialDrawPolicy; the client director
// (TutorialDirector) uses them to determine whether the current run is the tutorial level and which guide card belongs to each beat — single source of truth, prevents divergence.

/** Tutorial level id. Not counted toward campaign chapter progress (not included in CAMPAIGN_LEVEL_ORDER). */
export const TUTORIAL_LEVEL_ID = 'ch0_tutorial';

/**
 * The three hands-on guide cards in beat order: deploy troops → place a blocking building → cast a spell to clear the field (§3.2).
 * TutorialDrawPolicy guarantees they are drawn in this order; the director highlights the target card accordingly.
 */
export const TUTORIAL_TEACHING_CARDS = ['infantry_1', 'tower_1', 'meteor_1'] as const;

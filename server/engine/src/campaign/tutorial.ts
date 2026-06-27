// 专属教学关常量（ONBOARDING_DESIGN §3）。引擎用它选 TutorialDrawPolicy、客户端导演
// (TutorialDirector) 用它判定「跑的是不是教学关」与每个 beat 的引导卡 —— 单一来源，避免口径漂移。

/** 教学关 id。不计入战役章节进度（不进 CAMPAIGN_LEVEL_ORDER）。 */
export const TUTORIAL_LEVEL_ID = 'ch0_tutorial';

/**
 * 动手三拍的引导卡，按 beat 顺序：放兵 → 放建筑挡路 → 放法术清场（§3.2）。
 * TutorialDrawPolicy 保证它们按此序到手；导演据此高亮目标卡。
 */
export const TUTORIAL_TEACHING_CARDS = ['infantry_1', 'tower_1', 'meteor_1'] as const;

// cue 目录：「这个 cue 在混音里占多重、抢不抢得到声道」的数据面（AUDIO_DESIGN.md §4 混音）。
//
// 为什么单独一张表，而不是把 gain/priority 写在触发点旁边：AUDIO_DESIGN.md §6 的架构红线要求
// 音频是纯表现层，而混音是**内容决策**（哪个 cue 该压过哪个），跟「什么时候触发」是两件事。
// 触发点散在 EventsPanel 和各场景里，混音必须能一眼看全、一处调完——否则「为什么攻击音把结算
// 盖住了」得翻十个文件。
//
// 声明成穷尽的 `Record<AudioCue, CueDef>`：往 union 里加 cue，在这里给它决策之前编译不过。
import type { AudioCue } from './types';
import { variantCount } from './cueAssets';

export interface CueDef {
  /**
   * 单个声道的线性增益，作用在 SFX 总线音量**之下**（AUDIO_DESIGN.md §4：实际增益 =
   * master × 通道 × 这里）。
   *
   * 基准 1.0 = 「和合成音的响度一样」。素材到位后按合成音峰值对齐（daydayup 那套 pipeline 的
   * 第 5 步），于是换样本不改变混音权重，这张表也不需要跟着调。每一个偏离 1.0 的值都是**混音
   * 决策**，不是对素材响度的修正。
   */
  gain: number;
  /**
   * 并发上限的抢占排名，越高越优先（AUDIO_DESIGN.md §5 "超量丢弃"，这里改成按优先级抢占而不是
   * 丢最旧的——见 `VoiceBudget`）。
   *
   * 阶梯（高→低）：结算 stinger > 玩家自己按出来的 UI 音 > 领奖/揭示 > 出牌 > 受击/阵亡 >
   * 每次攻击都响的那个。
   */
  priority: number;
}

/**
 * 每个 cue 的混音决策。
 *
 * 优先级的两条实质判断：
 *
 * 1. **UI 音（110）排在全部战斗音之上**，只在结算 stinger 之下。玩家按下按钮却没有声音，读起来
 *    是「这一下没按到」；掉一个 `sfx.unit.attack` 读起来什么都不是。UI 音稀疏到不会影响混音。
 * 2. **`sfx.unit.attack` 是最低的 20**。它是全局发射频率最高的 cue（每个单位每次攻击一次，
 *    一条线上可能十几个单位同时打），上限撞满时它就是那个该被牺牲的；同优先级抢占失败是刻意的，
 *    否则一串攻击音会互相砍成断续的咔哒声。
 */
export const CUE_CATALOGUE: Record<AudioCue, CueDef> = {
  // ── 战斗内 ────────────────────────────────────────────────────────────────
  // 出牌是玩家的主要操作反馈，要在混战里听得见，但它不是"重"的声音——笔尖落纸。
  'sfx.card.play':    { gain: 1.0,  priority: 85 },
  // 非法出牌报告的是「什么都没发生」，必须比成功出牌更显眼，否则和丢帧无法区分。
  'sfx.card.invalid': { gain: 1.0,  priority: 95 },
  // 每次攻击都响 → 压到 0.7，并给最低优先级（见上）。
  'sfx.unit.attack':  { gain: 0.7,  priority: 20 },
  'sfx.unit.hit':     { gain: 0.9,  priority: 60 },
  // 基地掉血是唯一的输赢信号，比单位受击重要一档。
  'sfx.base.hit':     { gain: 1.05, priority: 90 },
  'sfx.spell.cast':   { gain: 1.0,  priority: 88 },
  'sfx.unit.death':   { gain: 0.85, priority: 55 },
  // 墨滴回涨是背景节拍，AUDIO_DESIGN.md §4 的"安静的底、有冲击力的战斗"——压到最轻。
  'sfx.ink.tick':     { gain: 0.5,  priority: 25 },

  // ── 结算 stinger：一局一次，谁都不许抢 ─────────────────────────────────────
  'sfx.result.victory': { gain: 1.0, priority: 120 },
  'sfx.result.defeat':  { gain: 1.0, priority: 120 },
  // Same weight as the other two: a draw settles the match just as finally, and the three are
  // mutually exclusive (one match ends exactly one way), so there is nothing here to rank.
  'sfx.result.draw':    { gain: 1.0, priority: 120 },

  // ── UI ───────────────────────────────────────────────────────────────────
  'sfx.ui.tap':    { gain: 1.0, priority: 110 },
  'sfx.ui.back':   { gain: 1.0, priority: 110 },
  'sfx.ui.reward': { gain: 1.0, priority: 112 },
  // 揭示三档共享一个优先级：它们互斥（一抽只可能是其中一个），排名之间没有可比的语义。
  'sfx.ui.gacha.reveal.common': { gain: 0.95, priority: 112 },
  'sfx.ui.gacha.reveal.rare':   { gain: 1.0,  priority: 112 },
  'sfx.ui.gacha.reveal.epic':   { gain: 1.05, priority: 115 },
  'sfx.ui.error':  { gain: 1.0, priority: 110 },
};

/** 全部 cue，运行时可枚举。从 catalogue 派生，所以不会像手写清单那样跟 union 走偏。 */
export const ALL_CUES: readonly AudioCue[] = Object.keys(CUE_CATALOGUE) as AudioCue[];

/** 有至少一个样本 variant 的 cue——启动预载要处理的集合。 */
export function cuesWithSamples(): readonly AudioCue[] {
  return ALL_CUES.filter((cue) => variantCount(cue) > 0);
}

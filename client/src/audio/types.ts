// 音频层的类型契约（AUDIO_DESIGN.md §2 资产清单 / §3 播放层抽象）。
//
// 只有类型，没有运行时代码——`audioBus.ts` 持有接缝，`cueCatalogue.ts` 持有混音数据，
// 两者都从这里取 `AudioCue`。
//
// 架构红线（AUDIO_DESIGN.md §6）：音频是**表现层**。这里的任何东西都不进 `@nw/engine`，
// 不写回 `GameState`，不读 sim 的 `Prng`——两个客户端音量不同、静音、样本没加载完，
// 模拟结果必须逐字节一致。

/**
 * 一次性短音的完整词汇表。id 沿用 AUDIO_DESIGN.md §2.1/§2.2 的命名（`sfx.` 前缀不是冗余：
 * 那份文档把 SFX 和 BGM 放在**同一个扁平 id 命名空间**里，BGM 是 `bgm.*`。BGM 走的是另一套
 * 接口形状（单实例 + 淡入淡出，见 §3 的 `playBgm`/`stopBgm`），所以还没进这个 union；
 * 保留前缀是为了那一天到来时不用改名）。
 *
 * 加一个 cue 到这个 union，在 `CUE_CATALOGUE` 里给它混音决策之前是**编译错误**——
 * 这是刻意的：一个没有 gain/priority 的 cue 只会以"听起来不对"的形式暴露，那太晚了。
 */
export type AudioCue =
  // ── 战斗内（引擎事件驱动，AUDIO_DESIGN.md §2.1）─────────────────────────────
  /** 出牌/落子——笔尖落纸"唰"。P0 */
  | 'sfx.card.play'
  /** 费不够/非法出牌——橡皮擦短"吱"。P0 */
  | 'sfx.card.invalid'
  /** 单位攻击——铅笔短戳。P0，每场发射次数最多的 cue。 */
  | 'sfx.unit.attack'
  /** 单位受击——软"噗"/揉纸。P0 */
  | 'sfx.unit.hit'
  /** 基地受击——厚本子闷响。P0 */
  | 'sfx.base.hit'
  /** 法术（陨石等）——翻页 + 落石涂抹。P1 */
  | 'sfx.spell.cast'
  /** 单位阵亡——纸团揉碎。P1 */
  | 'sfx.unit.death'
  /** 墨滴回涨节点——水滴"嘀"。P2 */
  | 'sfx.ink.tick'

  // ── 结算 stinger（AUDIO_DESIGN.md §2.3 尾注：走 SFX 管线，不占 BGM 槽）──────
  | 'sfx.result.victory'
  | 'sfx.result.defeat'
  // A draw is its own outcome, not a quieter win or a gentler loss. Playing either of the two above
  // would report the wrong result — which is why `game_draw` was silent until this cue existed
  // (AUDIO_DESIGN.md §7 step 6).
  | 'sfx.result.draw'

  // ── UI（**不由引擎事件驱动**，AUDIO_DESIGN.md §2.2）─────────────────────────
  //
  // 与上面所有 cue 的唯一区别是「谁触发」：UI cue 回答的是玩家自己的手指，来自场景层的
  // 墙钟交互，不是模拟出来的事件。它们共用同一份 catalogue、同一个混音器、同一个并发上限、
  // 同一个后端——所以这里不需要平行的第二套管线。
  /** 按钮/格子点击。P0 */
  | 'sfx.ui.tap'
  /** 返回/关闭。P1——必须和 `tap` 听起来不同：手机上前进和后退是同一根手指、几乎同一个位置。 */
  | 'sfx.ui.back'
  /** 领奖/获得物品。P1 */
  | 'sfx.ui.reward'
  // 盲盒揭示按稀有度分层（AUDIO_DESIGN.md §2.2 "普通/稀有/史诗+"）。三个独立 cue 而不是
  // 一个 cue 的三个 variant：variant 是用来抗重复疲劳的随机取样，语义分层必须是可寻址的
  // 不同 cue，否则调用方无法表达"这一抽是史诗"。
  | 'sfx.ui.gacha.reveal.common'
  | 'sfx.ui.gacha.reveal.rare'
  | 'sfx.ui.gacha.reveal.epic'
  /** 失败/余额不足 toast。P2——全局唯一一个报告「什么都没发生」的 cue。 */
  | 'sfx.ui.error';

/**
 * 可替换的音频设备（AUDIO_DESIGN.md §3）。
 *
 * **不挂在 `IPlatform` 上**，尽管 §3 原文写的是 `IPlatform.audio`——见 AUDIO_DESIGN.md §3
 * 的实现注记：那个接口已经承载 20 余个成员（画布/输入/存储/网络/IAP/广告/分享…），而音频
 * 与它们没有任何耦合。改走 `assets/assetIO.ts` 已经立下的先例：模块级单例 + 入口安装一次
 * （`audioBus.ts`）。
 *
 * 所有调用都是**渲染时钟 + 发后不理**：没有返回值、不抛出、不 await。
 */
export interface AudioBus {
  /**
   * 拉取 + 解码全部已发货样本（AUDIO_DESIGN.md §5 "进场景前 preload"）。
   *
   * 尽力而为，启动流程**绝不 await 它**：解析完成之前——以及彻底失败时——cue 落回程序化
   * 合成音，那是「有声但不同」而不是「静音」。可重复调用，第二次只重试还没加载上任何东西的 cue。
   */
  preload(): Promise<void>;
  /**
   * 播放一个一次性 cue。`count` 是本帧合并进这一个 cue 的事件数（AUDIO_DESIGN.md §4）——
   * 它**抬高增益，不会把 cue 播两遍**。
   */
  play(cue: AudioCue, count?: number): void;
  /** SFX 总线增益，0..1（AUDIO_DESIGN.md §4 三档音量的 `sfx` 通道）。 */
  setSfxVolume(v: number): void;
  /** BGM 总线增益，0..1。BGM 尚未实现，接受并忽略——设置页可以先接上滑杆。 */
  setMusicVolume(v: number): void;
  /** 越过浏览器/小游戏的 autoplay 闸门（AUDIO_DESIGN.md §5）；必须在用户手势里调。 */
  resume(): void;
}

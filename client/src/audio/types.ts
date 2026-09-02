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
 * 接口形状（单实例 + 淡入淡出 + 流式，见下面的 {@link MusicTrack} 与 `AudioBus.updateMusic`），
 * 所以不在这个 union 里。保留 `sfx.` 前缀当初是为了 BGM 落地那天不用改名——**2026-09-01 那天
 * 到了，一个 cue id 都没动**）。
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
 * BGM 轨的完整词汇表（AUDIO_DESIGN.md §2.3 / §7 第 7 步）。
 *
 * **与 `AudioCue` 共用同一个扁平 id 命名空间**（`sfx.` / `bgm.` 两个前缀），但**刻意是两个
 * union**，因为它们进的是两条形状完全不同的路：cue 是一次性的、解码进 `SampleBank`、走
 * `VoiceBudget` 抢占；轨是**流式**的、单实例、靠交叉淡入闭环。把它们塞进一个 union 只会让每个
 * 消费者第一件事就是把它拆开。
 *
 * **§2.3 列了四条轨，这里只有两条，那是拍板过的收敛而不是欠账**（2026-09-01）：
 *  - `bgm.intro` 不存在——§2.3 自己写着「可与 BGM_lobby 共用」，而一条只在首启放一次的独立轨要
 *    多付一次生成、一份下载量和一个永远只有一个人听过的验收。它由 `IntroScene` 省略 `music`
 *    字段自动落到 `bgm.lobby`。
 *  - `bgm.victory` / `bgm.defeat` 从来就不是轨：§2.3 的尾注已经把结算 stinger 归给 SFX 管线
 *    （`sfx.result.*`，catalogue 里优先级最高的三个 cue），它们不占 BGM 槽。
 */
export type MusicTrack =
  /** 大厅 / 菜单 / 商店 / 世界地图 / 结算 / 首启故事——轻松、低存在感。 */
  'bgm.lobby';

// **`bgm.battle` 不在这个 union 里，尽管 §2.3 列着它、尽管三个对局场景正等着它。**
// 它没有 master（brief 在 `art/audio/suno/BRIEFS.md`），而一条没有文件的轨如果先进 union，
// 它会以「这个界面就是安静的」的形式存在——那和设计意图长得**一模一样**，永远不会有人发现。
// 所以对局场景现在声明的是 `music: null`（刻意的安静），等 master 到了再一起改成 `'bgm.battle'`：
// 那时 `MUSIC_CATALOGUE` 缺条目会**编译不过**，缺文件会**构建不过**，两道都是硬的。

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
  /** BGM 总线增益，0..1（同上的 `bgm` 通道）。 */
  setMusicVolume(v: number): void;
  /**
   * **一帧的 BGM**（AUDIO_DESIGN.md §7 第 7 步）。`desired` 是此刻**应该**在响的轨；传一个
   * 已经在放的轨是空操作。
   *
   * **为什么是每帧一次的推导，而不是"切场景时通知一声"**——这是这一步唯一真正的接口决定：
   *
   *  - **没有钩子可挂，就没有能漏掉的时刻。** 本仓库有 40 个场景、三族互不相同的按钮机制
   *    （§7 第 4 步为此漏了两遍），而"新加一个场景"每周都在发生。事件式的版本要求每个新入口
   *    记得通知一次；推导式的版本读的是**已经每帧都在读的东西**。
   *  - **没有触发点，就没有重复触发。** 设置已经在放的轨在 {@link MusicTrack} 播放器里是空操作，
   *    所以来回切标签页、模态开关、场景淡入淡出中途再来一次 `goto`，都不可能把一条床重启。
   *  - **autoplay 闸门自己会过去。** 手势之前这个调用无事可做；手势之后的那一帧，同一个调用把
   *    床起起来。不需要队列、不需要重试、不需要记"刚才试过没有"。
   *
   * `dtMs` 驱动的是交叉淡入的包络和 ducking 的衰减，**不是**循环回绕的判据——回绕读的是正在
   * 播的那条流自己的 `position()`（累积时钟会在每一次卡帧、后台、音频中断上悄悄漂移，症状是
   * 接缝错位，听起来像一条切坏了的循环而不是像一个计数器的 bug）。
   *
   * `null` = 什么都不该响，走同一条淡出。
   */
  updateMusic(desired: MusicTrack | null, dtMs: number): void;
  /** 越过浏览器/小游戏的 autoplay 闸门（AUDIO_DESIGN.md §5）；必须在用户手势里调。 */
  resume(): void;
}

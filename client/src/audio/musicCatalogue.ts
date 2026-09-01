// BGM 目录（AUDIO_DESIGN.md §2.3 / §7 第 7 步）——「这条轨是什么、它的文件在哪」的数据那一半。
//
// **这个文件同时持有 BGM 的 `import`**，与 cue 侧的 `cueAssets.ts` 是同一个理由（那个文件的头
// 注释写了全部）：本仓库的资源 URL 由 webpack 在**构建期**烘焙，字面量路径在微信和任何设了
// `NW_ASSET_CDN` 的 web 构建上都是 404，而一个写错的文件名在这里是**构建失败**而不是运行时静默
// 无声。cue 侧把目录（混音数据）和资产（URL）拆成两个文件；音乐这边不拆，因为 `path` 和
// `lengthS` 是同一个决定的两半——回绕在 `lengthS - XFADE_S` 处触发，所以换文件不换长度是一个
// **听得见**的错误，把它们放进同一个对象字面量是让那件事不可能发生的最便宜的办法。
//
// **与 cue 的其余不同，也就是这个文件的大部分：**
//
//  - **轨是流式的，永远不进 `SampleBank`。** 一条 60 秒的立体声循环在 48 kHz 下解码成约 23 MB
//    的 `AudioBuffer`。就是这一个数字决定了音乐跑在两个长期存活的 deck 上（web 是 `Audio` 元素、
//    微信是 `InnerAudioContext`），而不是走 22 个样本共用的那条路。
//  - **长度是决定的一部分，不是一条趣闻。** 循环是**播放器**闭合的，不是文件闭合的（见
//    `MusicPlayer.ts` 的头注释：MP3 帧补齐让样本级精确回绕不存在），所以它必须**知道**长度。
//    这里的数由 `process_music.py` 打印（"decoded ... s"，注意它不等于要求的区段长度），并由
//    `musicAssets.test.ts` 钉在发货文件的真实时长上——一个漂了的长度会把交叉淡入放在错误的位置，
//    症状是一次踉跄，而不是一个错误。
//  - **电平的决定不在这里，在资产里。** 每条发货的循环都被归一到 250–2000 Hz RMS = −29 dBFS
//    （`tools/audio-pipeline/process_music.py` 的 `MID_TARGET_DBFS`，由 `audit.py --class music`
//    把关），推导写在那个门禁的注释里。下面的 `gain` 是叠在其上的混音旋钮，而**每一条发货值都是
//    1.0**——与 `CueDef.gain` 同一条纪律、同一个理由：一个电平有两处可设，就等于没有人找得到它。
//
// **没有 `borrowedFrom` 字段**（daydayup 的同名文件有）。那边三条轨里有一条没有 master，需要一个
// 机器可读的"这是替身"记录，免得一次只写在注释里的替代永远发货下去。这里两条轨都有自己的
// master，而 §2.3 的 `bgm.intro` 不是"借用 lobby 的替身"——它压根不是一条轨（见 `types.ts` 里
// `MusicTrack` 的注释）。一个没有使用者的字段是一条没人能违反的规则。
import type { AudioCue, MusicTrack } from './types';

import lobbyUrl from '../assets/audio/music/bgm-lobby.mp3';

/**
 * 交叉淡入的长度，秒。**这个数与资产管线共享，不许单边改动。**
 *
 * `tools/audio-pipeline/audit.py` 的 `XFADE_S` 是同一个 2.0，而两条发货的循环是**按它验收的**：
 * `music` 门禁的 `xfade_band_diff` 比较的正是这个宽度的头尾窗口，也正是因为有它，两条循环只需要
 * 在 2 秒内音色相容、而不需要样本级连续。在这里调大，等于用一个没人测量过的窗口去评判它们；
 * 调小，等于把已经测到手的接缝质量丢在桌上。`musicAssets.test.ts` 断言两边这个数一致。
 */
export const XFADE_S = 2.0;

export interface TrackDef {
  /** 构建期烘焙出来的文件 URL。 */
  path: string;
  /**
   * 该文件的真实时长，秒。{@link MusicPlayer} 在 `lengthS - XFADE_S` 处启动下一个 deck，
   * 所以它是**承重的**而不是描述性的。由 `process_music.py` 测量、`musicAssets.test.ts` 复查。
   */
  lengthS: number;
  /**
   * 这条轨的线性增益，叠在 BGM 总线音量与资产自带的电平之上。1.0 = 「按 −29 dBFS 频带目标
   * 交付的原样」。每一条发货值都是 1.0——见本文件头注释里为什么第二个电平旋钮是被**留着不用**
   * 而不是删掉（一条用替身顶着的轨是唯一一种"不重新切就该压一压"的正当情况）。
   */
  gain: number;
}

/**
 * 游戏能要求的每一条轨，连同它的音乐决定。
 *
 * 刻意是**穷举的 `Record`**：往 `MusicTrack` 加一个成员，在这里有条目之前是编译错误——
 * 与 `CUE_CATALOGUE` 对 cue 提供的是同一个保证。
 */
export const MUSIC_CATALOGUE: Record<MusicTrack, TrackDef> = {
  // `lengthS` 是 `process_music.py` 打印的 **decoded** 秒数，不是它被要求切的区段长度
  // （MP3 帧补齐让两者可以不等）。回绕在 `lengthS - XFADE_S` = 72.0 s 处触发。
  'bgm.lobby': { path: lobbyUrl, lengthS: 74.0, gain: 1.0 },
};

/** 每一条轨，运行时可枚举。从目录导出，所以不会像手写清单那样与 union 漂开。 */
export const ALL_TRACKS: readonly MusicTrack[] = Object.keys(MUSIC_CATALOGUE) as MusicTrack[];

/**
 * 播放时把 BGM 短暂压低的 cue（AUDIO_DESIGN.md §4 的 Ducking，可选项 P2）。
 *
 * **这张表住在音乐这边而不是 `cueCatalogue.ts` 里**，因为「什么东西该给我让路」是**音乐的**混音
 * 决定：往 `CueDef` 加一个 `ducks: boolean` 会要求 18 个 cue 每个都回答一个与它自己无关的问题，
 * 而答案取决于 BGM 存不存在——那正是 §4 把 ducking 标成可选的原因。
 *
 * 六个成员，恰好是 §4 点名的两类：**盲盒揭示**与**结算 stinger**。它们的共同点不是"响"，是
 * **一次性且承载结果**——玩家在那一瞬间要听清的是这一下，而床在别的时候都不碍事。
 * 三个 gacha 档全都在内（十连只会触发一次揭示，见 §7 第 4 步的 `revealCue`），三个结算档也全都
 * 在内（平局与胜负同等重要，那正是 `sfx.result.draw` 存在的理由）。
 */
export const DUCK_CUES: ReadonlySet<AudioCue> = new Set<AudioCue>([
  'sfx.ui.gacha.reveal.common',
  'sfx.ui.gacha.reveal.rare',
  'sfx.ui.gacha.reveal.epic',
  'sfx.result.victory',
  'sfx.result.defeat',
  'sfx.result.draw',
]);

/**
 * 场景没有声明 `music` 时该放哪条轨（`SceneManager` 的 `Scene.music`）。
 *
 * **默认值而不是必填项**，与 §7 第 4 步给 UI cue 定的是同一条：本仓库有 40 个场景，其中绝大多数
 * 就是外壳界面；让每一个都写一遍 `music: 'bgm.lobby'` 只会让漏写的那几个看起来像刻意的决定。
 */
export const DEFAULT_TRACK: MusicTrack = 'bgm.lobby';

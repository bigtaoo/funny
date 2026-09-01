// BGM 轨目录：id → 文件 URL + 混音权重（AUDIO_DESIGN.md §2.3 / §7 第 7 步）。
//
// 这是 `cueAssets.ts` + `cueCatalogue.ts` 两张表在音乐这边的合并版。**合并是刻意的**：SFX 那边
// 分成两张，是因为「哪个 cue 用哪个文件」会随素材批次变，而「哪个 cue 在混音里多重」是内容决策、
// 变化频率完全不同；音乐这边一条轨就是一个文件，两者同生同灭，拆开只会让人多翻一个文件。
//
// import 而不是拼路径，理由与 `cueAssets.ts` 逐字相同：URL 由 webpack 在构建期烘焙成
// `<CDN>/cdn/<hash>.mp3`（ASSET_PACKAGING §4），字面量路径在微信和任何设了 `NW_ASSET_CDN` 的
// web 构建里都是 404；而写错文件名在这里是**构建失败**，不是运行时静默无声。
import type { MusicTrack } from './types';

import lobbyUrl from '../assets/audio/bgm-lobby.mp3';

export interface MusicDef {
  /** 构建期烘焙的绝对 URL。 */
  url: string;
  /**
   * 线性增益，作用在 BGM 通道音量**之下**（实际增益 = master × bgm × 这里）。
   *
   * **与 `CUE_CATALOGUE.gain` 的基准不同，这一条必须说清楚。** SFX 那边 1.0 的含义是「和合成音
   * 一样响」，而每个样本文件都被 `process.py` 按
   * `file_peak = delivered_peak /(gain × bus)` 缩放过，所以 gain 是纯粹的混音权重。音乐没有
   * 那一步：`process_music.py` **不做峰值对齐**（一首成品的动态就是内容本身，为了对齐一个数字
   * 而在有损编码前砍掉 13 dB 是净损失），于是文件带着作者自己的电平进来，交付电平的决定就落在
   * 这个数字上。
   *
   * `bgm.lobby` 取 0.20 的算式（默认档 master 1 × bgm 0.5）：
   *
   *     交付峰值 = 文件峰值 0.6911 × 0.20 × 0.5 = 0.0691
   *
   * 参照物是同一套默认档下已实测的 SFX 交付峰值（AUDIO_DESIGN §0.3/§0.4）：最响的
   * `sfx.base.hit` 是 0.151，最轻的 `sfx.ink.tick` 是 0.028，按钮音 `sfx.ui.tap` 是 0.0923。
   * 音乐的**峰值**因此落在按钮音之下、墨滴之上；而它是连续声源，真正该比的是它的 **RMS**——
   * 这首的波峰因数是 13.8 dB，于是交付 RMS ≈ 0.0691 / 4.9 = **0.014**，比全表最轻的那个 cue
   * 的峰值还低一半。也就是说任何一个 SFX 事件都会明确浮在音乐之上，而音乐仍然听得见。
   */
  gain: number;
  /** 循环播放。结算 stinger 那种一次性乐句将来会是 `false`（走的仍是 SFX 管线，见 §2.3 尾注）。 */
  loop: boolean;
}

/**
 * 每条轨的文件与混音决策。**只登记真的有文件的轨。**
 *
 * AUDIO_DESIGN §2.3 还列着 `bgm.battle` / `bgm.intro`，它们**不在这里**：`cueAssets.ts` 学到的
 * 那一课（一个空条目与疏漏完全无法区分）在这里同样成立，而 `MusicTrack` union 是穷尽的，
 * 所以「还没有的轨」只能以「union 里没有这个 id」的形式存在——想播它的代码编译不过。
 */
export const MUSIC_TRACKS: Record<MusicTrack, MusicDef> = {
  'bgm.lobby': { url: lobbyUrl, gain: 0.2, loop: true },
};

/** 运行时可枚举的全部轨。从表派生，不会像手写清单那样跟 union 走偏。 */
export const ALL_MUSIC_TRACKS: readonly MusicTrack[] = Object.keys(MUSIC_TRACKS) as MusicTrack[];

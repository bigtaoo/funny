// 一个 WebAudio 形状的上下文之上的 `AudioBus`（AUDIO_DESIGN.md §3）。
//
// **为什么这个文件住在平台中立的 `audio/` 而不是某个 `platform/` 下**：它一行平台代码都没有。
// 原先这段逻辑整段长在 `platform/web/WebAudioBus.ts` 里，看起来像是"web 的音频后端"；等第二个
// 平台（微信，见 `platform/wechat/WechatAudioBus.ts`）落地时才看清楚，那个类里真正属于 web 的
// 只有两行——**上下文从哪来**（`new AudioContext()`）和**手势从哪来**（`window.addEventListener`）。
// 剩下的（总线 GainNode、SFX 音量、SampleBank/CueMixer 的装配、preload、autoplay 闸门、
// `loaded` 统计）在任何提供 WebAudio 表面的宿主上都逐字相同。
//
// 所以两个后端不是"两套实现"，是同一套实现的两组注入：平台侧各自只回答那两个问题
// （{@link ContextAudioBusDeps}），本类回答其余全部。这也让整条管线只有一份要测的行为——
// `platform/**` 不在覆盖率门禁的 include 里，而 `src/audio/**` 在，把逻辑搬进来的同时它就从
// "没有任何用例的类"变成了被守着的类。
//
// 一个 cue 究竟发出什么声音仍然不是这里的决定，是 `audio/CueMixer.ts` 的（有样本用样本、
// 没有用合成音）。本类只负责**拿到上下文**、**持有 SFX 总线的 GainNode**。
//
// 确定性（AUDIO_DESIGN.md §6）：这里读引擎事件、按渲染时钟播放，从不碰 `GameState`、
// 从不取 sim 的 `Prng`，所以不可能造成不同步。
import type { AudioBus, AudioCue, MusicTrack } from './types';
import { SampleBank } from './SampleBank';
import { CueMixer } from './CueMixer';
import { MusicPlayer, type MusicSource, type MusicState } from './MusicPlayer';
import { assetIO } from '../assets/assetIO';

/** SFX 通道默认音量（AUDIO_DESIGN.md §4 "SFX 0.8"）。 */
export const DEFAULT_SFX_VOLUME = 0.8;
/** BGM 通道默认音量（AUDIO_DESIGN.md §4 "master 1 × bgm 0.5"）。 */
export const DEFAULT_MUSIC_VOLUME = 0.5;

/** 平台要回答的**两个**问题，其余全在 {@link ContextAudioBus} 里。 */
export interface ContextAudioBusDeps {
  /**
   * 造一个 WebAudio 上下文。**返回 `null` 就是"这个宿主没有音频设备"**——静音，不抛出：
   * SSR、node 下的单元测试、老 WebView、以及没有 `wx.createWebAudioContext` 的低版本基础库
   * 都会走到这里，而它们一个都不该因为音频把启动带崩。
   */
  createContext(): AudioContext | null;
  /**
   * 注册"用户碰过屏幕"的回调，用来越过 autoplay 闸门（AUDIO_DESIGN.md §5）。
   * 宿主没有可监听的手势源时省略即可——那种宿主上下文通常一开始就是 `running`。
   */
  onGesture?(cb: () => void): void;
  /**
   * 单个样本文件拉不到 / 解不开时往哪里报。省略即 `console.warn`（`SampleBank` 的默认）。
   *
   * 透出这个接缝是因为「往哪报」本来就是平台的事：web 有开发者控制台，微信小游戏的日志要进
   * `wx` 那条管子才捞得回来。它同时是单元测试的出口——`preload()` 在 node 下必然逐文件失败
   * （没有 fetch base URL），而那是**正确行为**，不该让 22 行退回提示淹掉测试输出。
   */
  warn?(message: string, err: unknown): void;
  /**
   * 造一条流式音乐播放器（AUDIO_DESIGN.md §2.3）。**不走 `AudioContext`**——理由整段写在
   * `MusicPlayer.ts` 的头注释里（82 MB 的解码内存 + 跨源 `createMediaElementSource` 的静音陷阱）。
   *
   * 省略或返回 `null` = 这个宿主放不了音乐，SFX 照常。SFX 有设备而音乐没有是一个真实的组合：
   * node 下的单元测试有假的 `AudioContext`，但没有 `HTMLAudioElement`。
   */
  createMusicSource?(): MusicSource | null;
  /**
   * 注册"页面可见性变了"的回调（AUDIO_DESIGN.md §4 "失焦自动暂停"）。web 是
   * `visibilitychange`，微信是 `wx.onHide`/`wx.onShow`。
   *
   * 只有音乐需要它：最长的 cue 也只有几百毫秒，切后台时早就播完了（同 `WechatAudioBus` 对
   * 音频中断只接 `End` 那一半的理由）。
   */
  onVisibility?(cb: (visible: boolean) => void): void;
}

export class ContextAudioBus implements AudioBus {
  // 字段名是 `entries/web-e2e.ts` 的 `__nwAudio.nodes()` 穿透 TS 私有取的两个名字
  // （AUDIO_DESIGN.md §0.2 开头第 2 条：`preload()` 启动就建好了上下文，事后 patch 拿不到总线）。
  // 改名会静默打断那条测量面——它是运行时的反射，编译器看不见。
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private sfxVolume = DEFAULT_SFX_VOLUME;
  private bank: SampleBank | null = null;
  private mixer: CueMixer | null = null;
  /** 造过一次就不再重试：宿主要么有 WebAudio，要么没有，逐次 `play()` 重试只是每帧一次 try/catch。 */
  private failed = false;
  /** 音乐与 SFX 相互独立：一边没有设备不影响另一边（构造时决定一次，同 `failed` 的理由）。 */
  private music: MusicPlayer | null = null;
  private musicVolume = DEFAULT_MUSIC_VOLUME;

  constructor(private readonly deps: ContextAudioBusDeps) {
    deps.onGesture?.(() => this.resume());
    let source: MusicSource | null = null;
    try {
      source = deps.createMusicSource?.() ?? null;
    } catch {
      // 同 `ensure()` 对上下文构造失败的处理：宿主声称有这个 API 但造不出来，降级成没有音乐。
      source = null;
    }
    if (source) {
      this.music = new MusicPlayer(source);
      this.music.setChannelVolume(this.musicVolume);
      deps.onVisibility?.((visible) => this.music?.setHidden(!visible));
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;
    let ctx: AudioContext | null = null;
    try {
      ctx = this.deps.createContext();
    } catch {
      // 宿主声称有这个 API 但构造失败（基础库的兼容层最可能在这里翻车）。降级成静音，
      // 而不是让一个每帧被调用的 `play()` 每帧抛一次。
      ctx = null;
    }
    if (!ctx) {
      this.failed = true;
      return null;
    }
    this.ctx = ctx;
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVolume;
    this.sfx.connect(ctx.destination);
    this.bank = new SampleBank({
      ctx,
      // 平台字节读取（ASSET_PACKAGING §4.1）：web 是 fetch，微信是 wx.downloadFile + 本地缓存。
      // 传函数引用而不是 `assetIO()` 的结果，因为入口可能在本对象构造之后才 `setAssetIO`。
      readBinary: (url) => assetIO().loadBinary(url),
      warn: this.deps.warn,
    });
    this.mixer = new CueMixer({ ctx, bus: this.sfx, bank: this.bank });
    return ctx;
  }

  /**
   * 解码**不需要**先过 autoplay 闸门——suspended 的上下文照样能解码——所以这个可以在启动时跑，
   * 通常远早于第一次手势就完成了（AUDIO_DESIGN.md §5 "进场景前 preload"）。
   *
   * 自 2026-09-01 起这里真的有活干：10 个 cue 共 22 个样本（AUDIO_DESIGN.md §7 第 6 步），
   * 另外 8 个 cue 刻意只有合成音。**逐文件尽力而为**——任何一个文件拉不到或解不开，只有那个
   * variant 退回合成音，其余照常，所以「素材坏了」永远不会升级成「音频没了」。
   */
  async preload(): Promise<void> {
    if (!this.ensure() || !this.bank) return;
    await this.bank.load();
  }

  resume(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
    // 音乐这边不需要"补播积压"（它只有一条 want，不是队列），但**需要重试一次 play()**：
    // 首次进入大厅的音乐请求几乎必然发生在第一次点击之前，那一次 `play()` 被 autoplay 策略
    // 拒掉了，而这里是它唯一的补救机会。
    this.music?.resume();
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfx) this.sfx.gain.value = this.sfxVolume;
  }

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    this.music?.setChannelVolume(this.musicVolume);
  }

  /**
   * 声明现在该放哪条 BGM（`null` = 安静）。幂等，换轨走淡出淡入——全部在 `MusicPlayer` 里。
   *
   * 与 {@link play} 的一处关键差别：**这里不检查 `ctx.state === 'running'`。** SFX 在闸门打开
   * 前一律丢弃（否则第一次点击会一次性听到积压的全部声音），而音乐是持续声源，"积压"没有意义——
   * 它该做的是现在就试着播、被拒就等 `resume()` 再试。这也是它不共用 `AudioContext` 的又一个
   * 结果：`HTMLAudioElement` 有它自己的 autoplay 闸门，与 `AudioContext.state` 无关。
   */
  playMusic(track: MusicTrack | null): void {
    this.music?.setTrack(track);
  }

  /**
   * 按住/放开音乐，不走淡出（AUDIO_DESIGN.md §4 "失焦自动暂停"）。
   *
   * `onVisibility` 走的是同一条路，`protected` 是为了让平台子类接上**别的**同义信号——微信的
   * `onAudioInterruptionBegin/End`（来电）对播放器而言就是"切后台"，只是触发它的不是用户。
   */
  protected setMusicHidden(hidden: boolean): void {
    this.music?.setHidden(hidden);
  }

  /** 音乐播放器的可观测状态；这个宿主放不了音乐时为 `null`。e2e 测量面用（`__nwAudio.music()`）。 */
  get musicState(): MusicState | null {
    return this.music?.state ?? null;
  }

  play(cue: AudioCue, count = 1): void {
    const ctx = this.ensure();
    // `running` 之前什么都不播：suspended 的上下文会把声道排到闸门打开的那一刻，于是玩家的
    // 第一次点击会一次性听到之前积压的全部声音。
    if (!ctx || !this.mixer || ctx.state !== 'running') return;
    this.mixer.play(cue, count);
  }

  /** 已解码的 cue 数 / variant 数——启动日志和浏览器冒烟用它回答"样本到底加载上了吗"。 */
  get loaded(): { cues: number; variants: number } {
    return { cues: this.bank?.loadedCues ?? 0, variants: this.bank?.loadedVariants ?? 0 };
  }
}

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
import { MusicPlayer, type MusicDeck } from './MusicPlayer';
import { DUCK_CUES } from './musicCatalogue';
import { assetIO } from '../assets/assetIO';

/** SFX 通道默认音量（AUDIO_DESIGN.md §4 "SFX 0.8"）。 */
export const DEFAULT_SFX_VOLUME = 0.8;

/**
 * BGM 通道默认音量（同上的 "bgm 0.5"）。
 *
 * **这个数是发货资产电平的另一半**：两条轨都被归一到 250–2000 Hz RMS = −29 dBFS，而那个目标是
 * 按 `−29 dBFS × 0.5` 交付去推的（推导见 `tools/audio-pipeline/audit.py` 的 `music` 门禁）。
 * 改这里而不重切资产，就是把整条床相对于 cue 集平移。
 */
export const DEFAULT_MUSIC_VOLUME = 0.5;

/** 平台要回答的**四个**问题（BGM 落地前是两个），其余全在 {@link ContextAudioBus} 里。 */
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
   * 造这个宿主的两个音乐 deck，或 `null` = 这个宿主放不了 BGM（AUDIO_DESIGN.md §7 第 7 步）。
   *
   * **收的是可能为 `null` 的 `ctx`，而且那不是疏忽**：web 的 deck 需要它
   * （`createMediaElementSource` + 每 deck 一个 `GainNode`，因为 iOS 上 `audioEl.volume` 只读），
   * 微信的 deck 完全不需要它（`InnerAudioContext` 没有音频图）。于是「没有 `createWebAudioContext`
   * 的低版本基础库」这台设备**丢掉的是 SFX 样本，不是音乐**——这个签名就是那个性质的落点。
   *
   * 省略即"这个宿主没有 BGM"，与省略 `onGesture` 一样是合法状态（node 下的单元测试、e2e 入口）。
   */
  createMusicDecks?(ctx: AudioContext | null): readonly [MusicDeck, MusicDeck] | null;
  /**
   * 注册"前后台切换"的回调，`true` = 进后台（AUDIO_DESIGN.md §4 的失焦自动暂停）。
   *
   * web 是 `visibilitychange`，微信是 `wx.onHide`/`wx.onShow`（那个运行时没有 DOM）。
   * **只有 BGM 需要它**：最长的 cue 是几百毫秒，切后台时它早就播完了，没有要暂停的东西——
   * 而一条 60 秒的床不暂停，就是"切出去接个电话回来，音乐已经跑到了别处"。
   */
  onFocusChange?(cb: (hidden: boolean) => void): void;
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

  // ── BGM（AUDIO_DESIGN.md §7 第 7 步）────────────────────────────────────────────────────
  private music: MusicPlayer | null = null;
  private musicFailed = false;
  private musicVolume = DEFAULT_MUSIC_VOLUME;
  /**
   * 用户碰过屏幕没有——BGM 的 autoplay 闸门。
   *
   * **刻意不复用 `play()` 那条 `ctx.state === 'running'` 的判据**：那条把音乐拴在了 SFX 的
   * `AudioContext` 上，而微信的 deck 根本不需要那个上下文（见 `createMusicDecks`）。用手势本身
   * 作判据，两个平台同一条，且低版本基础库上音乐照样起得来。
   */
  private gestured = false;
  /**
   * 最近一次收到的前后台状态。**存下来，而不是就地用掉。**
   *
   * `onFocusChange` 是在构造函数里注册的，而平台侧可以（web 侧就是）在注册的同时**把当前值也
   * 报一次**——那一刻 `this.music` 必然还是 `null`（播放器由 `ensureMusic()` 懒造），所以就地
   * `this.music?.setPaused(hidden)` 会把那个值静默丢掉。这个字段是它的落点：`ensureMusic()`
   * 造完播放器后照它 hold 一次。
   *
   * 拿掉它的后果不是"少一层保险"，而是让 web 侧那行"当前值也报一次"整段变成空转——在一个
   * 后台标签页里加载完成的页面此后收不到任何 `visibilitychange`（切回来发的是 `visible`），
   * 于是床会在后台响起来。2026-09-02 的用例就是钉这一条的。
   */
  private hidden = false;

  constructor(private readonly deps: ContextAudioBusDeps) {
    // 宿主没有可监听的手势源（node、e2e 入口）就当作已经解锁——那种宿主的上下文本来一开始就是
    // `running`，再等一个永远不会来的手势等于永远静音。
    this.gestured = deps.onGesture === undefined;
    deps.onGesture?.(() => {
      this.gestured = true;
      this.resume();
    });
    deps.onFocusChange?.((hidden) => {
      this.hidden = hidden;
      this.music?.setPaused(hidden);
    });
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
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfx) this.sfx.gain.value = this.sfxVolume;
  }

  /** BGM 总线增益（AUDIO_DESIGN.md §4 的 `bgm` 通道）。**2026-09-01 起真的接了东西**——在此之前
   *  它接受并忽略，好让设置页的滑杆不是一个盲控件。 */
  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    this.music?.setBusVolume(this.musicVolume);
  }

  /**
   * 一帧的 BGM（`AudioBus.updateMusic`）。由 `SceneManager.onTick` 每帧无条件调一次。
   *
   * 手势之前直接返回：这时候没有任何能做的事，而**下一帧**就是解锁后的第一帧，同一个调用会把床
   * 起起来——不需要队列、不需要重试。这也顺带保证了第一次下载不会在启动最忙的那几百毫秒里跟
   * 22 个 cue 的 preload 抢带宽。
   */
  updateMusic(desired: MusicTrack | null, dtMs: number): void {
    if (!this.gestured) return;
    const player = this.ensureMusic();
    player?.update(desired, dtMs);
  }

  play(cue: AudioCue, count = 1): void {
    // Ducking（AUDIO_DESIGN.md §4）在**闸门之外**判：它读的是"游戏刚刚发生了什么"，而不是
    // "这一声实际有没有出来"。放在下面那个 return 之后的话，一个正好没有样本、或者上下文还
    // suspended 的瞬间就会让床忘记让路——而床是照放的，因为它走的是另一条闸门（`gestured`）。
    if (DUCK_CUES.has(cue)) this.music?.requestDuck();
    const ctx = this.ensure();
    // `running` 之前什么都不播：suspended 的上下文会把声道排到闸门打开的那一刻，于是玩家的
    // 第一次点击会一次性听到之前积压的全部声音。
    if (!ctx || !this.mixer || ctx.state !== 'running') return;
    this.mixer.play(cue, count);
  }

  /**
   * 懒造音乐播放器。**刻意不走 `ensure()`**：那个函数在拿不到 `AudioContext` 时会置 `failed`
   * 并让整个后端静音，而音乐在微信上不需要那个上下文。这里只借 `ensure()` 顺手把 `ctx` 建起来
   * （web 的 deck 需要它），拿到 `null` 也照常往下走，由平台侧的 `createMusicDecks` 决定这台设备
   * 到底有没有 BGM。
   */
  private ensureMusic(): MusicPlayer | null {
    if (this.music) return this.music;
    if (this.musicFailed || !this.deps.createMusicDecks) return null;
    let decks: readonly [MusicDeck, MusicDeck] | null = null;
    try {
      decks = this.deps.createMusicDecks(this.ensure());
    } catch (err) {
      this.deps.warn?.('music: 这个宿主造不出音乐 deck；本次会话没有 BGM', err);
      decks = null;
    }
    if (!decks) {
      this.musicFailed = true;
      return null;
    }
    this.music = new MusicPlayer({ decks, warn: this.deps.warn });
    this.music.setBusVolume(this.musicVolume);
    // 见 `hidden` 的注释：这个播放器可能是在**已经处于后台**的时候才造出来的，而那个事实是在它
    // 存在之前就报过来的。`MusicPlayer.update()` 在 hold 期间整段返回，所以这一行的效果是"这条
    // 床压根不会起来"，而不是"起来了再暂停"。
    if (this.hidden) this.music.setPaused(true);
    return this.music;
  }

  /** 已解码的 cue 数 / variant 数——启动日志和浏览器冒烟用它回答"样本到底加载上了吗"。 */
  get loaded(): { cues: number; variants: number } {
    return { cues: this.bank?.loadedCues ?? 0, variants: this.bank?.loadedVariants ?? 0 };
  }
}

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
import type { AudioBus, AudioCue } from './types';
import { SampleBank } from './SampleBank';
import { CueMixer } from './CueMixer';
import { assetIO } from '../assets/assetIO';

/** SFX 通道默认音量（AUDIO_DESIGN.md §4 "SFX 0.8"）。 */
export const DEFAULT_SFX_VOLUME = 0.8;

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

  constructor(private readonly deps: ContextAudioBusDeps) {
    deps.onGesture?.(() => this.resume());
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
    });
    this.mixer = new CueMixer({ ctx, bus: this.sfx, bank: this.bank });
    return ctx;
  }

  /**
   * 解码**不需要**先过 autoplay 闸门——suspended 的上下文照样能解码——所以这个可以在启动时跑，
   * 通常远早于第一次手势就完成了（AUDIO_DESIGN.md §5 "进场景前 preload"）。
   *
   * 当前 `cueAssets.ts` 是空的，于是这里是一次立即完成的空转。这条调用仍然要接：它是那种
   * 缺失了**完全看不出来**的接线（合成音会把整个混音扛住，没有任何测试会红），素材落地那天
   * 再补反而更容易忘。
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

  /** BGM 尚未实现（AUDIO_DESIGN.md §2.3 的四条轨还不存在）——接受并忽略，让设置页可以先接滑杆。 */
  setMusicVolume(_v: number): void {}

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

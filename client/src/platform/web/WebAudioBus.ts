// Web 音频后端（AUDIO_DESIGN.md §3 "Web / CrazyGames：WebAudio"）。
//
// 覆盖 web / CrazyGames / Capacitor iOS 壳三个入口——它们跑的都是真浏览器引擎，`AudioContext`
// 一视同仁，所以这一个实现就是全部；放在 `platform/web/` 下与 `WebPlatform.ts` 同级，因为它是
// 一个平台实现，而不是 `audio/` 那套平台中立的管线。
//
// 本类只负责两件事：**拿到上下文**、**持有 SFX 总线的 GainNode**。一个 cue 究竟发出什么声音是
// `audio/CueMixer.ts` 的决定（有样本用样本、没有用合成音）——将来微信侧的
// `InnerAudioContext` 后端要复用的正是那一层，所以那些判断一行都不该出现在这里。
//
// 确定性（AUDIO_DESIGN.md §6）：这里读引擎事件、按渲染时钟播放，从不碰 `GameState`、
// 从不取 sim 的 `Prng`，所以不可能造成不同步。
import type { AudioBus, AudioCue } from '../../audio/types';
import { SampleBank } from '../../audio/SampleBank';
import { CueMixer } from '../../audio/CueMixer';
import { assetIO } from '../../assets/assetIO';

/** SFX 通道默认音量（AUDIO_DESIGN.md §4 "SFX 0.8"）。 */
const DEFAULT_SFX_VOLUME = 0.8;

export class WebAudioBus implements AudioBus {
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private sfxVolume = DEFAULT_SFX_VOLUME;
  private bank: SampleBank | null = null;
  private mixer: CueMixer | null = null;

  constructor() {
    // WebAudio 在用户手势之前处于 suspended（autoplay 策略），iOS Safari 尤其严格
    // （AUDIO_DESIGN.md §5 前两行）。
    //
    // 挂在 `window` 上而不是走 `InputManager`：后者是设计好的输入管线，但它会在场景淡入淡出和
    // 模态框期间**闸掉**指针事件（见 InputManager.suppressed / modals）——而 autoplay 闸门要的
    // 只是"用户碰过页面"，被游戏逻辑丢弃的那一次点击同样能解锁。用 window 监听拿到的是严格更宽
    // 的手势集合，而且完全不必往输入管线里塞一个与它无关的关注点。
    if (typeof window !== 'undefined') {
      const onGesture = (): void => this.resume();
      for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
        window.addEventListener(ev, onGesture, { passive: true });
      }
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    // 有些环境（SSR、node 下的单元测试、老 WebView）没有 AudioContext——静音而不是抛出。
    const g = globalThis as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = this.sfxVolume;
    this.sfx.connect(this.ctx.destination);
    this.bank = new SampleBank({
      ctx: this.ctx,
      // 平台字节读取（ASSET_PACKAGING §4.1）：web 是 fetch，微信是 wx.downloadFile + 本地缓存。
      // 传函数引用而不是 `assetIO()` 的结果，因为入口可能在本对象构造之后才 `setAssetIO`。
      readBinary: (url) => assetIO().loadBinary(url),
    });
    this.mixer = new CueMixer({ ctx: this.ctx, bus: this.sfx, bank: this.bank });
    return this.ctx;
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

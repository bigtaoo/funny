// 一个微信音乐 deck（AUDIO_DESIGN.md §7 第 7 步）：一个长期存活的 `InnerAudioContext`。
//
// **本仓库唯一一个 `InnerAudioContext`，而 §5 的订正 2 早就预告了这一点**：SFX 走
// `wx.createWebAudioContext()` 的标准图（`WechatAudioBus`），对象池不需要——池真正想要的
// 「并发上限 + 优先级抢占」在平台中立的 `VoiceBudget.ts` 里。`InnerAudioContext` 剩下的正当用途
// 只有 BGM：单实例、流式、长文件。这一步才轮到它。
//
// **它与 `WechatAudioBus` 刻意无关**（不共享上下文、不共享构造顺序）：一个缺
// `createWebAudioContext` 的低版本基础库（< 2.19.0）应该丢掉 SFX 样本，**不该连音乐一起丢掉**。
// `createInnerAudioContext` 从很早的基础库就有，所以那台设备上音乐照放。
//
// **这里没有音频图**——没有 `GainNode`，没有可以插在流和输出之间的任何东西。所以整个增益乘积
// （`fade × bus × duck`，在 `MusicPlayer.applyGains` 一处算完）只能写进那唯一的 `.volume`。
// 这也正是 `MusicDeck` 的增益入口只有一个 `setGain` 的原因：把乘积留在平台中立的一侧，两个
// deck 实现就没有形状差异了。
import type { MusicDeck } from '../../audio/MusicPlayer';

/**
 * 本文件用到的 wx 表面切片（声明在 `src/wx.d.ts`）。**导出**是因为 `WechatAudioBus.ts` 也需要它，
 * 而那个文件里有一个局部的 `declare const wx: {...}` 遮住了全局的 `wx` 命名空间——在那里
 * `wx.IInnerAudioContext` 会解析不到类型。一个别名比在两处各写一遍那个切片便宜。
 */
export type InnerAudio = wx.IInnerAudioContext;

export interface WechatMusicDeckDeps {
  /**
   * 造一条流。注入而不是就地 `wx.createInnerAudioContext()`，是为了让「这个基础库有没有这个
   * API」的降级判断只发生一次、发生在它该在的地方（`WechatAudioBus`），而不是每个 deck 各判一次。
   */
  create(): InnerAudio;
  warn?(message: string, err: unknown): void;
}

export class WechatMusicDeck implements MusicDeck {
  private readonly inner: InnerAudio;
  private playing = false;
  private src = '';

  constructor(private readonly deps: WechatMusicDeckDeps) {
    this.inner = deps.create();
    this.inner.loop = false; // 回绕由 `MusicPlayer` 交叉淡入，见那个文件的头注释
    this.inner.volume = 0;
    this.inner.onError((res) => {
      this.playing = false;
      this.deps.warn?.(`music: InnerAudioContext failed on ${this.src}`, res?.errMsg ?? res);
    });
  }

  play(path: string): void {
    // 重新赋 `src` 会让流从 0 重新开始，而那**正是**回绕想要的——所以这里没有 web 那边的
    // "seek 回 0"分支，只有赋值；同一个 src 时用 `stop()` 倒带（`stop` 的语义就是"再 play
    // 从头开始"，见 `wx.d.ts` 的注释），比 `seek(0)` 在流式源上可靠。
    if (path !== this.src) {
      this.src = path;
      this.inner.src = path;
    } else {
      this.inner.stop();
    }
    this.playing = true;
    this.inner.play();
  }

  setGain(level: number): void {
    this.inner.volume = Math.max(0, Math.min(1, level));
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.inner.stop();
  }

  position(): number | null {
    if (!this.playing) return null;
    const t = this.inner.currentTime;
    // `currentTime` 在有效 src 到位之前是未定义/NaN（`wx.d.ts`："Only returned when a valid src
    // is set"）。返回 `null` 而不是 0：0 是一个**合法的位置**，而 NaN 参与回绕比较会静默地永远
    // 为假——也就是一条再也不回绕的循环。
    return Number.isFinite(t) ? t : null;
  }

  setPaused(paused: boolean): void {
    if (!this.playing) return;
    if (paused) this.inner.pause();
    else this.inner.play();
  }
}

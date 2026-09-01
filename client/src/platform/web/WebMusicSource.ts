// Web 侧的流式 BGM 播放器（AUDIO_DESIGN.md §2.3 / §7 第 7 步）。
//
// 一个裸的 `HTMLAudioElement`，**刻意不接进 `AudioContext`**——为什么见 `audio/MusicPlayer.ts`
// 的头注释（跨源 `createMediaElementSource` 会静默变成一条静音流，而本项目的资源全部在
// `NW_ASSET_CDN` 上）。淡入淡出因此由平台中立的 `MusicPlayer` 直接写 `.volume`。
//
// 覆盖 web / CrazyGames / Capacitor iOS 壳三个入口，同 `WebAudioBus`：它们跑的都是真浏览器引擎。
import type { MusicSource } from '../../audio/MusicPlayer';

export class WebMusicSource implements MusicSource {
  private el: HTMLAudioElement | null = null;

  /** `null` = 这个宿主没有 `<audio>`（SSR、node 单测、极老 WebView）——静音，不抛出。 */
  static create(): WebMusicSource | null {
    return typeof Audio === 'function' ? new WebMusicSource() : null;
  }

  load(url: string, loop: boolean): void {
    const el = this.el ?? (this.el = new Audio());
    el.src = url;
    el.loop = loop;
    // 流式而不是整段下载：这条轨 2.0 MB，`auto` 会在进大厅的同一瞬间和美术资源抢带宽，而音乐
    // 是全屏里最不着急的那一个。`metadata` 让浏览器先取头部，播放开始后自己往下拉。
    el.preload = 'metadata';
    el.crossOrigin = null;   // 见文件头：不接 WebAudio，就不需要（也不要）CORS 握手
    el.load();
  }

  play(): void {
    // 在首次手势之前**必然**被拒（autoplay 策略），而那不是错误：`MusicPlayer.resume()` 会在
    // 手势到来时再调一次。吞掉 rejection 而不是让它变成一条 unhandled rejection——后者会在
    // 每个玩家的控制台里出现一次，且看起来像 bug。
    // `play()` 在极老的 WebView 上返回 undefined 而不是 promise，所以先取回来再判。
    const started = this.el?.play() as Promise<void> | undefined;
    void started?.catch(() => {});
  }

  pause(): void {
    this.el?.pause();
  }

  setVolume(v: number): void {
    if (this.el) this.el.volume = Math.max(0, Math.min(1, v));
  }

  isPlaying(): boolean {
    // `paused` 是同步的：`play()` 立刻把它翻成 false，被 autoplay 拒掉时再翻回 true。所以它
    // 恰好回答了淡入要问的那个问题，而且在缓冲期间是 false（缓冲中的流确实在走）。
    return this.el !== null && !this.el.paused;
  }

  /** 测量面用（`entries/web-e2e.ts` 的 `__nwAudio.music()`）；生产代码不读。 */
  get element(): HTMLAudioElement | null {
    return this.el;
  }
}

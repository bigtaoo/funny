// 微信小游戏侧的流式 BGM 播放器（AUDIO_DESIGN.md §2.3 / §5 / §7 第 7 步）。
//
// **这是 `InnerAudioContext` 在本项目里唯一的正当用途，而它是被设计文档预告过的。**
// §5 那条订正写着：SFX 不需要 `InnerAudioContext` 对象池（微信有标准 WebAudio 表面，整条管线
// 原样复用，并发上限在平台中立的 `VoiceBudget.ts` 里），"`InnerAudioContext` 剩下的正当用途
// 只有 BGM（单实例、流式、`loop=true`）"。这个文件就是那句话。
//
// 它和 web 侧的 `HTMLAudioElement` 是同一种东西的两个名字——按 URL 播放的单实例流播放器，带
// `loop` 和 `volume`——所以两边都只实现 `MusicSource` 那四个方法，淡入淡出、暂停语义、换轨顺序
// 全在平台中立的 `MusicPlayer` 里，一份。
import type { MusicSource } from '../../audio/MusicPlayer';

/** 本文件用到的 wx 表面切片（完整声明在 `src/wx.d.ts`）。 */
declare const wx: {
  createInnerAudioContext?(opts?: { useWebAudioImplement?: boolean }): {
    src: string;
    loop: boolean;
    volume: number;
    readonly paused: boolean;
    play(): void;
    pause(): void;
    destroy(): void;
  };
};

type InnerAudio = NonNullable<ReturnType<NonNullable<typeof wx.createInnerAudioContext>>>;

export class WechatMusicSource implements MusicSource {
  private ctx: InnerAudio | null = null;

  /** `null` = 这个宿主没有 `createInnerAudioContext`——静音，不抛出（同 `WechatAudioBus` 对低版本基础库的处理）。 */
  static create(): WechatMusicSource | null {
    return typeof wx !== 'undefined' && typeof wx.createInnerAudioContext === 'function'
      ? new WechatMusicSource()
      : null;
  }

  load(url: string, loop: boolean): void {
    this.ctx ??= wx.createInnerAudioContext!();
    this.ctx.loop = loop;
    this.ctx.src = url;
  }

  play(): void {
    this.ctx?.play();
  }

  pause(): void {
    this.ctx?.pause();
  }

  setVolume(v: number): void {
    if (this.ctx) this.ctx.volume = Math.max(0, Math.min(1, v));
  }

  isPlaying(): boolean {
    return this.ctx !== null && !this.ctx.paused;
  }
}

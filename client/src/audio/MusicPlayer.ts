// BGM 播放器：单实例、循环、淡入淡出、失焦暂停（AUDIO_DESIGN.md §2.3 / §4 / §7 第 7 步）。
//
// **为什么它不复用 SFX 那条管线。** SFX 走 `AudioContext` + 解好的 `AudioBuffer`：短、可并发、
// 要混音要抢占。音乐三条都不是——它是一条几分钟长的单实例流。把它也解成 buffer 意味着
// 213 秒 × 48 kHz × 2 声道 × 4 字节 ≈ **82 MB 常驻内存**，在手机浏览器和小游戏上都不可接受，
// 而这条轨在 CDN 上只有 2.0 MB。所以音乐走**流式播放器**：web 是 `HTMLAudioElement`，微信是
// `wx.createInnerAudioContext()`（§5 那条订正说的正是这个——对象池对 SFX 不需要了，
// `InnerAudioContext` 剩下的正当用途就是这里）。
//
// 顺带躲开一个只会以「静音」形式暴露的坑：**不把 `HTMLAudioElement` 接进 WebAudio 图**
// （`createMediaElementSource`）。那样做会给音乐一个 GainNode（听起来更"对称"），代价是媒体元素
// 一旦跨源就必须带正确的 CORS 响应头，否则接出来的是一条**静音**的流——而本项目的资源全部在
// `NW_ASSET_CDN` 上，正好是跨源。裸 `HTMLAudioElement` 没有这个约束。ducking（§4 可选 P2）
// 将来若要做，再连图不迟，那时 CORS 是一个必须先解决的已知前提，而不是一个惊喜。
//
// 于是淡入淡出由本文件用一个定时器算，而不是 `AudioParam.linearRampToValueAtTime`：两个平台
// 只需要提供一个 `setVolume(0..1)`，淡入曲线、时长、暂停语义就都是平台中立的一份。
import type { MusicTrack } from './types';
import { MUSIC_TRACKS } from './musicTracks';

/** 平台侧要提供的最小流式播放器。四个方法都必须是「调了不抛」的。 */
export interface MusicSource {
  /** 指向一条轨并从头准备播放。换轨时调用一次。 */
  load(url: string, loop: boolean): void;
  /**
   * 开始/继续播放。**可能因为 autoplay 闸门被拒**（首次手势之前），实现里自己吞掉即可——
   * {@link MusicPlayer.resume} 会在手势到来时再调一次，重复调用是无害的。
   */
  play(): void;
  /** 暂停但保留播放位置。 */
  pause(): void;
  /** 0..1，已经含了全部通道增益。 */
  setVolume(v: number): void;
  /**
   * 流**现在真的在走**吗（既不是被 autoplay 拒掉、也不是暂停）。
   *
   * 存在的唯一理由是淡入：`MusicPlayer` 的淡入跑的是墙钟，而首次进大厅的 `play()` 几乎必然
   * 被 autoplay 闸门拒掉。不问这个问题的话，闸门打开之前那 900 ms 照样在推进，于是玩家第一次
   * 点屏幕时音乐**直接以满音量出现**——淡入静静地跑完了，只是没有声音跟着它。实测确认过
   * （AUDIO_DESIGN §0.5）：手势之前 `level` 已经到 0.67，而 `element.paused` 还是 true。
   *
   * 可选：宿主答不上来（返回 `undefined`）就按老样子推进——那是个更差但不会更糟的默认值。
   */
  isPlaying?(): boolean;
}

/** 淡入比淡出慢：进场是"安顿下来"，离场是"让路"（同 `SceneManager` 的 90/180 ms 取向，只是尺度大一档）。 */
export const FADE_IN_MS = 900;
export const FADE_OUT_MS = 450;
/** 淡入淡出的推进步长。50 ms（20 Hz）在最短的 450 ms 淡出里也有 9 级，听不出阶梯。 */
export const FADE_STEP_MS = 50;

/** {@link MusicPlayer} 的可观测状态——e2e 测量面和单元用例读它，生产代码不读。 */
export interface MusicState {
  /** 应该在放的轨（`playMusic` 最后一次要求的）。 */
  want: MusicTrack | null;
  /** 播放器当前装着的轨。淡出结束后仍然装着——保留播放位置，回大厅时接着放而不是重新缓冲。 */
  loaded: MusicTrack | null;
  /** 淡入淡出的当前系数 0..1。 */
  level: number;
  /** 送到平台播放器的最终音量（`level × 通道音量 × 轨 gain`）。 */
  volume: number;
  /** 平台播放器是否处于暂停态（淡出结束或页面切后台）。 */
  paused: boolean;
}

/**
 * 平台中立的 BGM 播放器。
 *
 * 接口是**声明式**的：`setTrack(t)` 说的是"现在**应该**放什么"，不是"放一次"。
 * 这样 `SceneManager` 每次换场景无脑调一次即可——同一条轨连着要求十次不会重头开始，也不会
 * 叠成十个实例，而这正是「大厅 → 商店 → 大厅」这类导航的常态。
 */
export class MusicPlayer {
  private want: MusicTrack | null = null;
  private loaded: MusicTrack | null = null;
  private level = 0;
  private target = 0;
  /** BGM 通道音量（master × bgm，静音时为 0），由 `audioSettings` 推下来。 */
  private channel = 1;
  /** 页面/小游戏切后台。与淡入淡出正交：它不改 `level`，只是把播放器按住。 */
  private hidden = false;
  private paused = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly source: MusicSource) {}

  /** 声明现在应该放哪条轨；`null` = 应该安静。 */
  setTrack(track: MusicTrack | null): void {
    if (track === this.want) return;
    this.want = track;
    if (track === null) {
      this.target = 0;
    } else if (this.loaded === track) {
      // 同一条轨：接着放（可能是淡出到一半又要回来，也可能是从暂停里醒过来）。
      this.target = 1;
      this.resumeSource();
    } else if (this.level === 0) {
      this.swapTo(track);
    } else {
      // 另一条轨正在响：先淡出，`tick` 落到 0 时再换。
      this.target = 0;
    }
    this.startTimer();
    this.apply();
  }

  /** BGM 通道音量（0..1），来自 `audioSettings` 的 `master × bgm`（静音时 0）。 */
  setChannelVolume(v: number): void {
    this.channel = Math.max(0, Math.min(1, v));
    this.apply();
  }

  /**
   * 页面/小游戏切后台时按住，回前台放开（AUDIO_DESIGN.md §4 "失焦自动暂停"）。
   *
   * **不走淡出**：切后台这件事本身已经是硬切了，再花 450 ms 淡出只会让音乐在别的 app 上面
   * 多响半秒。
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.pauseSource();
    } else if (this.want !== null) {
      this.resumeSource();
      this.startTimer();
    }
    this.apply();
  }

  /**
   * 用户手势到达（autoplay 闸门打开）。`ContextAudioBus.resume()` 会转调过来。
   *
   * 幂等：已经在放的时候再调一次 `play()` 什么都不会发生，而在**被拒过一次**的情况下这是
   * 唯一的补救机会——首次进入大厅的音乐请求几乎必然发生在第一次点击之前。
   */
  resume(): void {
    if (this.want === null || this.hidden) return;
    this.resumeSource();
    // 淡入在被拒的那段时间里是**停住**的（见 `tick`），所以补播之后要把定时器重新点着。
    this.startTimer();
  }

  /** 立即静音并停住（切账号/退出等）。保留已装载的轨。 */
  stop(): void {
    this.want = null;
    this.target = 0;
    this.level = 0;
    this.pauseSource();
    this.stopTimer();
    this.apply();
  }

  get state(): MusicState {
    return {
      want: this.want,
      loaded: this.loaded,
      level: Math.round(this.level * 1e4) / 1e4,
      volume: this.currentVolume(),
      paused: this.paused,
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private swapTo(track: MusicTrack): void {
    const def = MUSIC_TRACKS[track];
    this.loaded = track;
    this.level = 0;
    this.target = 1;
    this.apply();               // 先把音量压到 0 再 load，否则新轨的第一帧是全音量
    this.source.load(def.url, def.loop);
    this.resumeSource();
  }

  private resumeSource(): void {
    if (this.hidden) return;
    this.paused = false;
    this.source.play();
  }

  private pauseSource(): void {
    if (this.paused) return;
    this.paused = true;
    this.source.pause();
  }

  private currentVolume(): number {
    const def = this.loaded ? MUSIC_TRACKS[this.loaded] : null;
    return def ? this.level * this.channel * def.gain : 0;
  }

  private apply(): void {
    this.source.setVolume(this.currentVolume());
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(FADE_STEP_MS), FADE_STEP_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 推进一步淡入淡出。**导出给用例用假时钟驱动**，生产代码只由 `startTimer` 调。 */
  tick(dtMs: number): void {
    if (this.target === 1 && this.source.isPlaying?.() === false) {
      // 流还没真的在走（autoplay 闸门没开，或页面在后台）。**不推进淡入**——否则闸门打开的
      // 那一刻音乐是满音量出现，而不是淡进来。停掉定时器而不是空转 20 Hz：把它重新点着的
      // 只有 `resume()` 和 `setHidden(false)`，而那正是这个状态唯一能改变的两条路。
      this.stopTimer();
      return;
    }
    const span = this.target === 1 ? FADE_IN_MS : FADE_OUT_MS;
    const step = span > 0 ? dtMs / span : 1;
    this.level = this.target > this.level
      ? Math.min(this.target, this.level + step)
      : Math.max(this.target, this.level - step);

    if (this.level === 0) {
      if (this.want !== null && this.loaded !== this.want) {
        // 淡出跑完，换到那条真正要放的轨上，接着淡入。
        this.swapTo(this.want);
        return;
      }
      // 真的该安静了：停住播放器（保留位置），也停掉定时器——一个每 50 ms 空转的定时器
      // 在大厅之外的每一分钟里都是白烧的电。
      this.pauseSource();
      this.stopTimer();
    } else if (this.level === 1) {
      this.stopTimer();
    }
    this.apply();
  }
}

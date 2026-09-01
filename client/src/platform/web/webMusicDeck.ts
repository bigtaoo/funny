// 一个 web 音乐 deck（AUDIO_DESIGN.md §7 第 7 步）：一个 `Audio` 元素经 `MediaElementSource`
// 进入本 deck 自己的 `GainNode`。
//
// **为什么不用 `audioEl.volume`，那明明能省掉整个音频图。** iOS Safari 上 `HTMLMediaElement.volume`
// 是**只读**的——赋值被静默忽略、读回来还是 1。而交叉淡入每帧都要写它，所以那条捷径在 iOS 上会
// 把每一次淡入淡出退化成硬切，且**只在 iOS 上**，也就是本仓库最难验证的那个目标
// （Capacitor 壳，AUDIO_DESIGN.md §3 "Web / CrazyGames / Capacitor iOS 壳"共用这一个实现）。
//
// **`crossOrigin = 'anonymous'` 是必需的，不是保险。** 本项目按 ASSET_PACKAGING §4 方案 A 把资源
// 托管在 CDN（`NW_ASSET_CDN`），于是这个元素加载的是**跨源**媒体；一个跨源的媒体元素被接进
// WebAudio 图之后，图的输出会被污染成**静音**——不是报错，是安静地没有声音。设了这个属性走 CORS
// 之后才是有声的。SFX 那条路（`assetIO` 的 fetch）本来就要求同一套 CORS 头，所以这里不需要 CDN
// 侧任何新配置。
import type { MusicDeck } from '../../audio/MusicPlayer';

export interface WebMusicDeckDeps {
  ctx: AudioContext;
  warn?(message: string, err: unknown): void;
}

export class WebMusicDeck implements MusicDeck {
  private readonly el: HTMLAudioElement;
  private readonly gain: GainNode;
  private playing = false;

  constructor(private readonly deps: WebMusicDeckDeps) {
    const { ctx } = deps;
    this.el = new Audio();
    this.el.crossOrigin = 'anonymous'; // 见头注释：不设就是静音，且不报错
    this.el.preload = 'auto';
    this.el.loop = false; // 回绕由 `MusicPlayer` 交叉淡入，见那个文件的头注释
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    ctx.createMediaElementSource(this.el).connect(this.gain);
    this.gain.connect(ctx.destination);
    // 每个 deck 一行日志就够：一条播不出来的流，最可能的成因是 CDN 或 CORS，那是一个真实的诊断
    // 而不是噪声。
    this.el.addEventListener('error', () => {
      this.playing = false;
      this.deps.warn?.(`music: <audio> failed on ${this.el.src}`, this.el.error);
    });
  }

  play(path: string): void {
    if (this.el.src !== path) this.el.src = path;
    // 同一个文件重播（回绕时进来的那一端在换轨后又轮回本 deck）。这时元数据早就到齐了——
    // 这个 deck 已经完整放过一遍它——所以 seek 到 0 是可靠的，而流式元素在元数据到齐**之前**
    // seek 才是那件在两个平台上都不可靠的事。
    else if (this.el.currentTime !== 0) this.el.currentTime = 0;
    this.playing = true;
    // `play()` 在 autoplay 闸门之前返回一个 rejected promise。`ContextAudioBus` 已经把音乐挡在
    // 第一次手势之后（见那里的 `gestured`），所以走到这里通常是 CDN 的问题——但仍然要接住它，
    // 一个未处理的 rejection 会把控制台刷成红色而于事无补。
    void this.el.play().catch((err: unknown) => {
      this.playing = false;
      this.deps.warn?.(`music: <audio> refused to start ${path}`, err);
    });
  }

  setGain(level: number): void {
    this.gain.gain.value = level;
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.el.pause();
    this.el.currentTime = 0;
    // **`src` 刻意不清空。** 清掉它才是"释放流"的字面意思，但它同时会在某些浏览器上触发一次
    // `error` 事件（上面那个监听器会把它当成一次真实失败报出来），并且让下一次 `play()` 从零开始
    // 重新下载——而下一次 `play()` 最可能的来源正是**回绕**，也就是那个必须准时的时刻。
    // 真正要止住的是"挂在增益 0 上继续解码"，而 `pause()` 已经止住了它。
  }

  position(): number | null {
    return this.playing ? this.el.currentTime : null;
  }

  setPaused(paused: boolean): void {
    if (!this.playing) return;
    if (paused) this.el.pause();
    else void this.el.play().catch(() => {});
  }
}

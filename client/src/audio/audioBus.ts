// 音频设备的平台接缝：模块级单例 + 入口安装一次。
//
// **为什么不是 `IPlatform.audio`**（AUDIO_DESIGN.md §3 原本这么写的，本次同步订正了那一节）：
//
//  * `IPlatform` 已经承载 20 余个成员——画布/屏幕/安全区/存储/网络类型/语言/输入/SDK 生命周期/
//    广告/鉴权/socket/IAP/分享。音频跟它们没有任何耦合：它不需要 canvas，不需要 layout，
//    不参与鉴权。塞进去只是让那个接口再长一截，并强迫**四个**平台实现（web/wechat/crazygames/
//    以及 e2e 入口）各自都得给出一个音频成员，哪怕其中两个只想要同一个 web 实现。
//  * 本仓库已经有一个正好合用的先例：`assets/assetIO.ts`。它也是"平台可替换、但与 IPlatform
//    其余部分无关"的能力，做法就是模块级单例 + 入口 `setAssetIO(...)` 安装一次。音频照抄这个
//    形状，于是两处接缝的心智模型是同一个。
//
// **未安装就是安全状态**，而且是测试里的常态：默认是一个真正的空操作总线，所以任何构造场景、
// 跑 UI 冒烟、或者 headless 跑 `createAppCore` 的测试都不需要打桩音频，也不会因为没有
// `AudioContext` 而抛错。
import type { AudioBus, AudioCue, MusicTrack } from './types';

/**
 * 什么都不做的音频设备。**不是**降级路径的一部分——降级是"样本没有就用合成音"
 * （见 `CueMixer`）；这个是"这个宿主上没有音频设备"。
 *
 * 现在只有一个真实使用者：**测试 / headless**（默认值，没人安装过任何东西）。
 *
 * > **这里原先记着第二个使用者——微信小游戏——那条注释是错的，2026-08-31 删除。** 它写的是
 * > "`wx.d.ts` 只声明了 `createInnerAudioContext`，没有振荡器、没有 GainNode，所以整条管线在
 * > 那个运行时上一行都跑不起来"。**前半句是真的、后半句不是**：`wx.d.ts` 是我们自己写的声明
 * > 文件，它没写的东西不等于运行时没有。小游戏从基础库 2.19.0 起提供
 * > `wx.createWebAudioContext()`（标准 WebAudio 表面），微信现在装的是
 * > `platform/wechat/WechatAudioBus.ts`，与 web 共用同一条管线。
 * >
 * > 留着这段是因为它是本仓库里"**把自己的类型声明当成外部世界的事实**"的一个现成样本，而这类
 * > 错误在别处一样会犯：一个平台 API 在 `.d.ts` 里缺席，唯一的症状就是没人去用它。
 */
export class NullAudioBus implements AudioBus {
  async preload(): Promise<void> {}
  play(_cue: AudioCue, _count?: number): void {}
  setSfxVolume(_v: number): void {}
  setMusicVolume(_v: number): void {}
  updateMusic(_desired: MusicTrack | null, _dtMs: number): void {}
  resume(): void {}
}

let _bus: AudioBus = new NullAudioBus();

/**
 * 安装平台音频设备（例如 `new WebAudioBus()`）。入口在 `startApp` 之前调用一次，
 * 与 `setAssetIO` 并列。
 */
export function setAudioBus(bus: AudioBus): void {
  _bus = bus;
  warned = false;
  musicWarned = false;
}

/** 当前的音频设备（在某个平台安装自己的之前是 {@link NullAudioBus}）。 */
export function audioBus(): AudioBus {
  return _bus;
}

/**
 * 播一个 cue。**这是触发侧唯一该用的入口**（名字沿用 AUDIO_DESIGN.md §3 的 `playSfx`）——
 * 它比 `audioBus().play(...)` 短，而且更重要的是，
 * 它把"音频设备从哪来"这件事关在本模块里：将来触发点会散在 `EventsPanel` 和几十个场景里，
 * 它们一个都不该知道有个单例存在，更不该自己去 try/catch。
 *
 * 失败在这里被吞掉而不是放出去：调用点是渲染帧里/按钮回调里，玩家的动作已经发生了，
 * 一次抛出只会连累那一帧剩下的工作，换来的仅仅是一个声音。警告每个已安装的总线只打一次——
 * 最可能反复触发它的恰好是那个被反复按的按钮。
 */
let warned = false;
export function playSfx(cue: AudioCue, count = 1): void {
  try {
    _bus.play(cue, count);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[audio] cue ${cue} 播放失败；本次会话音频保持静默：`, err);
    }
  }
}

/**
 * 推一帧 BGM（AUDIO_DESIGN.md §7 第 7 步）。**这是 BGM 侧唯一该用的入口**，与 {@link playSfx}
 * 同一个形状、同一个理由：把"音频设备从哪来"关在本模块里。
 *
 * 唯一的调用者是 `SceneManager.onTick`——见 `AudioBus.updateMusic` 的注释里为什么是每帧一次的
 * 推导而不是切场景时通知一声。
 *
 * 失败在这里被吞掉的理由比 cue 那边更硬：这个调用跑在 `app.ticker` 上，**排在 PIXI 渲染器的
 * 监听器前面**——PIXI 7 里任何一个 ticker 监听器抛出都会中止更新循环、并且不再安排下一次
 * `requestAnimationFrame`，也就是整块画布永久冻结到刷新为止（`SceneManager.tickScene` 的注释
 * 记着那个真实的故障报告）。为了一条背景音乐冒这个险是不成比例的。每个已安装的总线只警告一次：
 * 一个坏掉的 deck 每秒坏 60 次。
 */
let musicWarned = false;
export function updateMusic(desired: MusicTrack | null, dtMs: number): void {
  try {
    _bus.updateMusic(desired, dtMs);
  } catch (err) {
    if (!musicWarned) {
      musicWarned = true;
      console.warn('[audio] BGM 更新失败；本次会话没有背景音乐：', err);
    }
  }
}

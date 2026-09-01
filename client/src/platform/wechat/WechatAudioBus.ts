// 微信小游戏音频后端（AUDIO_DESIGN.md §3 "微信小游戏"，§7 第 5 步）。
//
// **它没有重写任何东西。** 合成音、样本解码、并发上限、总线增益、同帧合并——整条管线原样复用
// `audio/ContextAudioBus.ts`，本类只回答那两个平台问题：上下文从哪来、手势从哪来。
//
// > **这一步之前本仓库写的是反话，纠正记在这里，因为它值钱的地方不是结论而是成因。**
// > `entries/wechat.ts` 和 `audio/audioBus.ts` 原先都断言"微信运行时没有振荡器、没有 GainNode，
// > 所以整条管线一行都跑不起来"，据此装 `NullAudioBus`（静音）。那个断言的依据是
// > **`client/src/wx.d.ts` 里只声明了 `createInnerAudioContext`**——也就是把"我们的 typing 写了
// > 什么"当成了"运行时提供什么"。真实的小游戏运行时从基础库 **2.19.0** 起就提供
// > `wx.createWebAudioContext()`，一个标准 WebAudio 表面；本项目
// > `wechatgame/project.private.config.json` 钉的是 **3.15.1**，早就在门槛之上。
// > AUDIO_DESIGN.md §3 当时其实把这条备选写进了脚注，只是标着"没有设备可验证"——所以真正拦住
// > 它的从来不是运行时，是没人去验。
//
// **于是 §5 那条"SFX 走 InnerAudioContext 对象池"也不需要了。** `InnerAudioContext` 是按 URL
// 播放的流式播放器：一个实例一次一条音轨，既没有振荡器（合成音无处安放）、也没有可写的总线增益
// （三档音量只能逐实例乘进去）、还没有 `AudioBuffer`（同一个 cue 的 n 次合并只能变成 n 个实例）。
// 用它铺 SFX 等于为这一个平台再养一套形状不同的混音器。而"并发上限 + 按优先级抢占"这个对象池
// **真正想要的东西**已经在 `audio/VoiceBudget.ts` 里了，平台中立、被用例守着，两个平台共用一份。
// `InnerAudioContext` 的正当用途只剩 BGM（单实例、流式、`loop=true`），那是 §7 第 7 步的事。
import { ContextAudioBus } from '../../audio/ContextAudioBus';

/** 本文件用到的 wx 表面切片（`src/wx.d.ts` 里补齐了声明，这里只是就近说明用途）。 */
declare const wx: {
  createWebAudioContext?(): AudioContext;
  onTouchStart?(cb: () => void): void;
  onAudioInterruptionBegin?(cb: () => void): void;
  onAudioInterruptionEnd?(cb: () => void): void;
};

export class WechatAudioBus extends ContextAudioBus {
  constructor() {
    super({
      // 低版本基础库（< 2.19.0）没有这个 API。返回 null = 那台设备静音，其余一切照常——
      // 这正是 `ContextAudioBus` 对"宿主没有音频设备"的既定处理，与 SSR/node 走同一条路。
      createContext: () =>
        typeof wx !== 'undefined' && typeof wx.createWebAudioContext === 'function'
          ? wx.createWebAudioContext()
          : null,
      // 这个运行时**没有 DOM**，所以 web 那边的 `window.addEventListener('pointerdown')` 在这里
      // 不存在；`wx.onTouchStart` 是全局触摸的等价物，而且和 web 侧同一个理由：它比
      // `InputManager` 严格更宽——autoplay 闸门要的只是"用户碰过屏幕"，被场景淡入淡出闸掉的那次
      // 触摸同样能解锁。
      onGesture: (cb) => {
        if (typeof wx !== 'undefined') wx.onTouchStart?.(cb);
      },
    });

    // 中断（来电/系统闹钟）。这个运行时没有 DOM，所以没有 `visibilitychange`，这两个回调是
    // **唯一**的信号。SFX 这边只需要恢复那一半：最长的 cue 是几百毫秒，中断开始时它早就播完了，
    // 没有要暂停的东西；而中断**结束**后上下文可能停在 suspended，不 `resume()` 就是"接完一个
    // 电话回来游戏哑了"，且此后再没有任何手势会去修它（`onTouchStart` 的解锁已经在开局用掉了）。
    if (typeof wx !== 'undefined') wx.onAudioInterruptionEnd?.(() => this.resume());
  }
}

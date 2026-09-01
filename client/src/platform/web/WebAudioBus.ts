// Web 音频后端（AUDIO_DESIGN.md §3 "Web / CrazyGames：WebAudio"）。
//
// 覆盖 web / CrazyGames / Capacitor iOS 壳三个入口——它们跑的都是真浏览器引擎，`AudioContext`
// 一视同仁，所以这一个实现就是全部。
//
// **本类只剩下两个平台答案**，其余全部在平台中立的 `audio/ContextAudioBus.ts` 里（2026-08-31
// 接微信后端时抽出去的——见那个文件的头注释）：上下文从哪来、手势从哪来。
import { ContextAudioBus } from '../../audio/ContextAudioBus';
import { WebMusicSource } from './WebMusicSource';

export class WebAudioBus extends ContextAudioBus {
  constructor() {
    super({
      createContext: () => {
        // 有些环境（SSR、node 下的单元测试、老 WebView）没有 AudioContext——静音而不是抛出。
        const g = globalThis as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const Ctor = g.AudioContext ?? g.webkitAudioContext;
        return Ctor ? new Ctor() : null;
      },
      // WebAudio 在用户手势之前处于 suspended（autoplay 策略），iOS Safari 尤其严格
      // （AUDIO_DESIGN.md §5 前两行）。
      //
      // 挂在 `window` 上而不是走 `InputManager`：后者是设计好的输入管线，但它会在场景淡入淡出和
      // 模态框期间**闸掉**指针事件（见 InputManager.suppressed / modals）——而 autoplay 闸门要的
      // 只是"用户碰过页面"，被游戏逻辑丢弃的那一次点击同样能解锁。用 window 监听拿到的是严格更宽
      // 的手势集合，而且完全不必往输入管线里塞一个与它无关的关注点。
      onGesture: (cb) => {
        if (typeof window === 'undefined') return;
        for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
          window.addEventListener(ev, cb, { passive: true });
        }
      },
      // BGM 走一条独立的流（AUDIO_DESIGN.md §2.3）——不是这个 `AudioContext` 的一部分，
      // 理由整段在 `audio/MusicPlayer.ts` 的头注释里。
      createMusicSource: () => WebMusicSource.create(),
      // 切后台暂停音乐（§4 "失焦自动暂停"）。SFX 不需要：最长的 cue 也只有几百毫秒。
      onVisibility: (cb) => {
        if (typeof document === 'undefined') return;
        document.addEventListener('visibilitychange', () => cb(!document.hidden));
        // **当前值也要报一次，不只报变化。** `visibilitychange` 只在**切换**时触发，而页面
        // 完全可能在后台标签页里加载完毕（用户按住 Ctrl 点开、从收藏夹批量打开、会话恢复）。
        // 只监听变化的话，那种情况下音乐会在一个没人在看的标签页里开始播——而且此后不会有任何
        // 事件来纠正它，因为"从后台切到前台"发的是 `visible`，不是 `hidden`。
        // 2026-09-01 §0.5 的实测正是在一个 `document.hidden === true` 的标签页里做的，这个洞
        // 就是那样冒出来的。
        cb(!document.hidden);
      },
    });
  }
}

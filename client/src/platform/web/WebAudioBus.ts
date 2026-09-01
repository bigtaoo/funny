// Web 音频后端（AUDIO_DESIGN.md §3 "Web / CrazyGames：WebAudio"）。
//
// 覆盖 web / CrazyGames / Capacitor iOS 壳三个入口——它们跑的都是真浏览器引擎，`AudioContext`
// 一视同仁，所以这一个实现就是全部。
//
// **本类只剩下两个平台答案**，其余全部在平台中立的 `audio/ContextAudioBus.ts` 里（2026-08-31
// 接微信后端时抽出去的——见那个文件的头注释）：上下文从哪来、手势从哪来。
import { ContextAudioBus } from '../../audio/ContextAudioBus';
import { WebMusicDeck } from './webMusicDeck';

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
      // BGM（AUDIO_DESIGN.md §7 第 7 步）。web 的 deck **需要**这个上下文：iOS Safari 上
      // `audioEl.volume` 是只读的，所以交叉淡入只能走 `MediaElementSource` + `GainNode`
      // （见 `webMusicDeck.ts` 的头注释）。没有上下文的宿主（SSR、node、极老 WebView）因此也
      // 没有 BGM——与 SFX 同一条降级，不是新增的一条。
      createMusicDecks: (ctx) => {
        if (!ctx || typeof Audio === 'undefined') return null;
        return [new WebMusicDeck({ ctx }), new WebMusicDeck({ ctx })] as const;
      },
      // 失焦暂停（AUDIO_DESIGN.md §4）。`visibilitychange` 而不是 `blur`：切标签页、锁屏、
      // 切到别的 app 都会发它，而 `blur` 还会在点开控制台或另一个窗口时发——那时游戏仍然可见，
      // 把音乐停掉只是让人以为它坏了。
      onFocusChange: (cb) => {
        if (typeof document === 'undefined') return;
        document.addEventListener('visibilitychange', () => cb(document.hidden));
        // **当前值也报一次，不只报变化。** `visibilitychange` 只在**切换**时触发，而页面完全
        // 可能在一个后台标签页里加载完毕（按住 Ctrl 点开、从收藏夹批量打开、会话恢复），此后
        // 也不会有任何事件来纠正——因为"从后台切到前台"发的是 `visible`，不是 `hidden`。
        // 2026-09-01 的 BGM 实测就是在一个 `document.hidden === true` 的标签页里做的，这个洞
        // 是那样冒出来的。`gestured` 闸门让它今天很难被触发（后台标签页收不到手势），但这一行
        // 的代价是零，而"很难被触发"不是"不会被触发"。
        cb(document.hidden);
      },
    });
  }
}

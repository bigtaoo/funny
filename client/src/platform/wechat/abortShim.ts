/**
 * abortShim.ts — `AbortController` / `AbortSignal` for the mini-game runtime, which has neither.
 *
 * ## 这个洞是 2026-09-12 被包内几何巡检（`entries/wechat-layout.ts`）**实测撞出来的**
 *
 * 那次跑的第一件事是注册一个账号，结果是：
 *
 * ```
 * register failed: {"ok":false,"errorKey":"auth.err.network","detail":"AbortController is not defined"}
 * ```
 *
 * 抛点是 `net/ApiClient/core.ts` 的 `const ctrl = new AbortController()`——**在 transport 之前**。
 * `net/WorldApiClient/core.ts` 还有两处同样的写法。也就是说：**微信包里每一个 REST 调用，从写下
 * 那天起就从没发出过一个包**（登录 / bootstrap / 存档同步 / 世界服全部），失败得还很像网络问题。
 *
 * 2026-09-01 那轮把 `fetch` 换成 `wx.request` 是对的、而且 `wechatTransport.ts` 把
 * `AbortSignal → RequestTask.abort()` 桥接得很完整——**它只是从来没被调用到**。那轮的结论是靠读
 * 代码得出的（记忆里那条「真机未验」说的就是这个），而这一层恰好是读代码看不见的：调用方用了一个
 * 平台中立的标准全局，没人问过这个运行时有没有它。
 *
 * ## 为什么这次「补全局」是对的，而 2026-09-01「不补 `fetch`」也是对的
 *
 * 那条原则是：**补一个宿主全局 = 改写全图的特性探测**——补上 `globalThis.fetch`，就等于把「包内
 * 文件不该走 HTTP」从物理不可能降级成但愿没人写。`AbortController` 不一样，两条都不成立：
 *
 * 1. **没有任何人探测它。** 全仓库零处 `typeof AbortController`，三个调用点都是无条件 `new`。
 *    补上它不会让任何代码换一条分支——只会让它们不再抛。
 * 2. **它不做 I/O。** 整个语义就是一个 bool 加一串回调；没有它能"假装成功"的东西。真正干活的还是
 *    `wechatTransport` 里那条 `RequestTask.abort()`，而那条一直是真的。
 *
 * 所以这不是给运行时装一个假的网络栈，是把调用方**已经依赖**的那点记账补齐。
 *
 * ## 装在哪
 *
 * `installHost.ts`（入口的第一个 import），与 `wechatHost.ts` 并列而不是塞进去：那个文件的范围是
 * **PIXI 绕过 adapter 直接嗅探的 DOM 面**，每一行都对着一个 PIXI 调用点。这一条是**我们自己的
 * 网络层**缺的东西，混进去只会让两边的边界都模糊。
 *
 * 只在缺席时安装（`??=`），所以真机基础库哪天补上了这两个类，用的就是它的。
 */

type Listener = (ev: { type: 'abort' }) => void;

class ShimAbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: Listener | null = null;
  private listeners: Listener[] = [];

  addEventListener(type: string, fn: Listener): void {
    if (type === 'abort') this.listeners.push(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    if (type !== 'abort') return;
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  /** `throwIfAborted` — part of the surface since 2022; cheap to keep honest. */
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  /** Internal: fired by the controller. Listeners run once, exactly like the real thing. */
  _fire(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const ev = { type: 'abort' as const };
    const once = this.listeners;
    this.listeners = [];
    // Each listener is isolated: one throwing must not stop the rest, and must not propagate back
    // into whatever called `abort()` (a timeout callback, in every one of our call sites).
    try { this.onabort?.(ev); } catch { /* contained */ }
    for (const fn of once) {
      try { fn(ev); } catch { /* contained */ }
    }
  }
}

class ShimAbortController {
  readonly signal = new ShimAbortSignal();

  abort(reason?: unknown): void {
    // The real default reason is a DOMException named 'AbortError'. There is no `DOMException`
    // here either, and the only consumer that reads it (`wechatTransport.ts`) builds its own
    // `AbortError`-named Error before rejecting — so a plain Error with the right `name` is the
    // honest stand-in, and it keeps the `e.name === 'AbortError'` branch every caller writes.
    let r = reason;
    if (r === undefined) {
      r = new Error('signal is aborted without reason');
      (r as Error).name = 'AbortError';
    }
    this.signal._fire(r);
  }
}

/**
 * Install both globals if the runtime lacks them. Idempotent, and a no-op wherever they exist —
 * so this module is safe to import from any entry, not just WeChat's.
 */
export function installAbortShim(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.AbortController ??= ShimAbortController;
  g.AbortSignal ??= ShimAbortSignal;
}

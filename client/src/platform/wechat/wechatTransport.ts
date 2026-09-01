/**
 * wechatTransport.ts — REST 走 `wx.request`（ASSET_PACKAGING §4.4 第 1 条 / §4.5）。
 *
 * `net/transport.ts` 那个接缝的微信实现，由 `entries/wechat.ts` 无条件装上（同 `setAssetIO` /
 * `setAudioBus` 那两行）。**小游戏运行时没有 `fetch`**，`wx.request` 是它唯一的 HTTP 客户端。
 *
 * ## ⚠️ 这个文件不碰资源
 *
 * 包内 / CDN 的字节走 `assets/WechatAssetIO.ts`（`wx.downloadFile` + `USER_DATA_PATH` 缓存），
 * `wechatPixiAdapter.fetch` 是**故意抛错**的。这里只该看见 API base URL。真要有人拿资源 URL 进
 * 来，它会以一条普通的网络失败结束，而不是响亮地失败——所以别把这条路让出去。
 *
 * ## `wx.request` 与 `fetch` 的四处真实差异（都在下面被显式处理或记账）
 *
 * | 项 | `fetch` | `wx.request` | 这里怎么办 |
 * |---|---|---|---|
 * | 请求头字段名 | `headers` | **`header`** | 映射 |
 * | 响应体 | 原样字符串，`json()` 自己 parse | `dataType` 默认 `'json'`，**它替你 parse 且失败时静默给回字符串** | 明确要非 `'json'`，parse 由 `json()` 做，与 `fetch` 同样在非法 JSON 上抛 |
 * | 取消 | `AbortSignal` | `RequestTask.abort()` | 桥接，且**由我们**先 reject（见下） |
 * | cookie | 有 jar，`credentials` 有意义 | **没有 jar**，`cookies` 只在响应里回显、不存不重放 | `credentials:'omit'` 天然成立，字段忽略 |
 *
 * 另外两条只能记账、没法在代码里补：
 *
 * - **`keepalive` 没有对应物。** 退到后台时 `wx.onHide` 是在进程**还活着**的时候触发的（不像
 *   `beforeunload` 是在拆卸途中），所以 `analytics` 的 hide flush 通常还是发得出去；但这是
 *   best-effort，不是 `keepalive` 那种规范保证。
 * - **域名白名单。** `wx.request` 有一份**独立于 `downloadFile` 的**「request 合法域名」清单，
 *   后台配不上就是所有 REST 全挂（开发者工具可以勾「不校验合法域名」，真机不行）。这条挂在
 *   ASSET_PACKAGING §4.2 遗留 1 里。
 */
import type { NetRequest, NetResponse, NetTransport } from '../../net/transport';

/** 本文件用到的 wx 表面切片（惯例同 `WechatAssetIO.ts` / `wechatHost.ts`：就近声明用到的那点）。 */
declare const wx: {
  request(opts: {
    url: string;
    method?: string;
    header?: Record<string, string>;
    data?: string;
    dataType?: string;
    responseType?: 'text' | 'arraybuffer';
    success?(res: { data: unknown; statusCode: number }): void;
    fail?(err: { errMsg?: string; errno?: number }): void;
  }): WxRequestTask;
};

interface WxRequestTask {
  abort(): void;
}

/** 与 `fetch` 一致：取消以 `name === 'AbortError'` 的 Error 拒绝（调用方按名字分支）。 */
function abortError(req: NetRequest): Error {
  const e = new Error(`wx.request aborted: ${req.method} ${req.url}`);
  e.name = 'AbortError';
  return e;
}

/**
 * 响应包装。
 *
 * `data` **按说**是字符串（我们要了非 `'json'` 的 `dataType`），但基础库在这一点上历史上不一致，
 * 而「declare 两个方向都不是证据」（LOG §17.1）。所以两种形状都收，`json()`/`text()` 的结果一样。
 */
function wxResponse(statusCode: number, data: unknown): NetResponse {
  const raw = typeof data === 'string' ? data : null;
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    // 非法 JSON 上抛 —— 与 `Response.json()` 同步（`ApiClientCore.request` 依赖这一点来把
    // 「服务器返回了 HTML 错误页」表现成一次失败，而不是一个 `ok` 为 undefined 的假信封）。
    json: async () => (raw === null ? data : (JSON.parse(raw) as unknown)),
    text: async () => (raw === null ? JSON.stringify(data ?? null) : raw),
  };
}

export class WechatTransport implements NetTransport {
  request(req: NetRequest): Promise<NetResponse> {
    return new Promise<NetResponse>((resolve, reject) => {
      const signal = req.signal;
      if (signal?.aborted) {
        reject(abortError(req)); // 已经过期的 signal：一个包都不发
        return;
      }

      let settled = false;
      let onAbort: (() => void) | undefined;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        return true;
      };

      const task = wx.request({
        url: req.url,
        method: req.method,
        header: req.headers,
        ...(req.body !== undefined ? { data: req.body } : {}),
        // **必须不是 `'json'`**：默认值会让 wx 替我们 parse，parse 失败时静默把字符串原样给回来，
        // 于是 `json()` 拿到一个 string、`json.ok` 是 undefined，一次 502 会被当成一次成功。
        dataType: 'text',
        responseType: 'text',
        success: (res) => {
          if (finish()) resolve(wxResponse(res.statusCode, res.data));
        },
        fail: (err) => {
          if (finish()) reject(new Error(`wx.request failed: ${req.method} ${req.url}: ${err.errMsg ?? 'unknown'}`));
        },
      });

      if (signal && !settled) {
        // 取消时**由我们**立刻 reject，再顺手 `task.abort()`：`abort()` 之后 wx 会不会回调
        // `fail`、errMsg 长什么样，都是运行时细节；先 reject 才能保证语义和 web 上一模一样
        // （`finish()` 会让随后那次 `fail` 变成 no-op）。
        onAbort = () => {
          if (finish()) {
            reject(abortError(req));
            task.abort();
          }
        };
        signal.addEventListener('abort', onAbort);
      }
    });
  }
}

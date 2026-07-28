# 工具桌面壳（desktop-shell）

> 状态：设计中 · 权威：本文 · 更新：2026-07-28
> 关联：[animator/ARCHITECTURE.md](../animator/ARCHITECTURE.md)（编辑器架构，不变）· [animator/WORKSPACE_SYNC.md](../animator/WORKSPACE_SYNC.md)（⚠️ 被本文取代方向，见 §7）· [ADR-055](../../DECISIONS.md)

---

## 0. 背景与目标

**痛点**：
1. animator（以及未来 vfx-editor/level-editor/map-editor）目前只能本地 `npm start` 跑 webpack-dev-server，工程数据锁死在浏览器 IndexedDB / 手动下载文件里，跟仓库脱节；此前 `WORKSPACE_SYNC.md` 想用 Supabase 云工作区 + GitHub Action 同步桥解决协作问题，但这套"云盘中转"违背了"本地文件 + git 记录"的偏好。
2. 后续计划找**外包美术**——非技术人员，不能要求他们装 git/跑 npm/懂分支概念，但仍需要他们编辑的内容能进 git 走 PR review。
3. 计划把多个编辑器工具整合进同一个壳里，未来还会加更多工具页面。

**目标**：
- 一个桌面应用（壳），内部按"页面/工具"切换，每个工具沿用各自现有的独立 webpack 工程，不合并成单体前端。
- 壳负责：本地文件读写、（未来的）git 提交/PR、应用与工具内容的自动更新。
- 对非技术用户完全隐藏 git 术语——"保存"是本地写盘，"提交审核"才是背后的 commit+push+开 PR。
- 跨平台（Win/macOS，未来可能 Linux）渲染表现必须一致——这是选型的硬约束。

---

## 1. 技术选型：Electron

| 候选 | 结论 | 理由 |
|---|---|---|
| **Electron** | ✅ 选定 | 自带固定版本 Chromium，全平台渲染引擎一致（PixiJS/WebGL 表现可控）；Node 主进程可直接跑 `isomorphic-git`，无需系统装 git；生态成熟（`electron-builder`/`electron-updater`） |
| Tauri | ✗ | 各平台用系统原生 WebView（WebView2/WKWebView/webkitgtk），渲染引擎不统一，与"跨平台一致性"硬约束冲突 |
| NW.js | ✗ | 与 Electron 同源（Chromium+Node），但社区/生态明显式微，没有理由选它而不选 Electron |
| PWA + 本地 helper 进程 | ✗ | 仍需要一个本地进程做 git 操作，复杂度不低于 Electron，且渲染引擎跟随用户浏览器版本，一致性更差 |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────┐
│ Electron 主进程                                │
│  - 窗口管理 + 侧边栏工具切换                      │
│  - 自定义 protocol（app://<tool>/...）挂载各工具 dist（本地兜底）│
│  - 或 BrowserView 直接指向各工具的远程托管地址（默认，见 §4）│
│  - GitSyncController（预留接口，见 §5）           │
│  - AutoUpdateController（壳级 + 内容级，见 §4）    │
│  - contextBridge 暴露 window.nwDesktop.* 给各工具页面│
└─────────────────────────────────────────────┘
        │ 侧边栏点击切换 BrowserView
        ▼
┌───────────┬───────────┬──────────────┬─────────────┐
│ animator  │ vfx-editor│ level-editor │ map-editor  │
│ (9091 dev)│ (9094 dev)│ (9092 dev)   │ (9095 dev)  │
│ 各自独立   │           │              │             │
│ webpack 工程，产物/托管地址不变，壳只是新增的宿主       │
└───────────┴───────────┴──────────────┴─────────────┘
```

- **每个工具保持独立 webpack 工程**（现状不变）：本地开发仍是 `npm run start` 起对应端口；壳在生产模式下加载的是各工具的**生产构建**（远程托管或打包进壳，见 §4 的取舍）。
- **侧边栏**：壳的唯一自有 UI，只做工具切换 + 全局菜单（更新提示、关于），不侵入各工具内部 UI。
- **数据/文件读写**：各工具现有的 `.tao`/`.tao.editor`/vfx json 等 IO 逻辑不变；壳新增的是"这些文件存在哪个本地目录、要不要提交"这一层，通过 `contextBridge` 注入的 `window.nwDesktop.fs.*` / `window.nwDesktop.git.*` 暴露给工具页面调用（工具页面现有的 `showSaveFilePicker` 等浏览器 API 调用可保留作为壳外后备，不强制迁移）。

---

## 3. 与各工具页面的接口（`window.nwDesktop`）

主进程通过 `contextBridge.exposeInMainWorld('nwDesktop', {...})` 注入，各工具页面按需调用（可选依赖——脱离壳单独 `npm start` 时 `window.nwDesktop` 为 `undefined`，工具侧要做存在性判断，不强绑定）：

```ts
interface NwDesktopBridge {
  git: GitSyncController;   // 见 §5，当前全部方法返回 not_implemented
  // 壳→工具页面的推送式事件（main 用 webContents.send 发起，preload 转成订阅接口）：
  onRequestSave(cb: () => void | Promise<void>): () => void;   // 取消订阅函数；内容热更新触发的"立即保存"钩子，见 §4.2
  onUpdateAvailable(cb: (info: { kind: 'app' | 'content'; toolId?: string }) => void): () => void;
}
```

- `onRequestSave(cb)`：工具页面在 `App.ts`（或等价组合根）里订阅一次，把 `cb` 映射到各自已有的立即落盘方法（如 animator 的 `AutoSaveController.flushNow()`）。preload 侧收到后台请求后调用 `cb()`，完成/超时都会回发一个 ack（`nw:save-ack`），供壳侧判断是否可以继续往下走"提示刷新"。没有自动保存机制的工具（如尚无 autosave 的 vfx-editor）可以先传空函数，不阻塞。

---

## 4. 自动更新（两层，互不干扰）

### 4.1 壳级更新（安装包）

- 用 `electron-updater` + `electron-builder`，`publish` 指向 GitHub Releases。
- 触发：启动时检查一次 + 后台每隔一段时间（如 4h）再查一次；发现新版本先**后台静默下载**，不打断当前编辑。
- 下载完成后，走跟 §4.2 相同的"合适时机"提示 UX（见下），而非立即强制重启。
- **更新频率预期低**：只有壳自身代码变化（菜单、git 集成、协议/更新逻辑本身）才需要发新安装包；各工具功能迭代走 §4.2，不走这层。

### 4.2 工具内容级热更新（各工具 webpack 产物）

**取舍**：各工具的生产构建**远程托管**（沿用 `WORKSPACE_SYNC.md` 里已经跑通的 Cloudflare Pages/Workers 部署方式，去掉 Supabase 那部分），壳内 `BrowserView` 直接指向托管地址，而不是把工具产物打包进安装包——这样迭代工具功能（加个按钮、修个 bug）不需要发新壳安装包，外包美术也不用重装桌面应用。

**✅ 已接线（2026-07-28）**：四个工具其实早就各自有生产部署（`wrangler/<tool>.jsonc` + `.github/workflows/<tool>-deploy.yml`，实测均 200）：
- animator → `https://animator.tao-wang-go.workers.dev`
- vfx-editor → `https://vfx.gamestao.com`
- level-editor → `https://level.gamestao.com`
- map-editor → `https://slg.gamestao.com`

`tools.ts` 的 `ToolConfig` 加了 `prodUrl` 字段，`resolveToolUrl(tool)` 按 `app.isPackaged` 二选一：装好的正式包直接连生产地址，`electron .` 跑源码开发时仍走本地 dev server——两者用同一套代码，不用改配置切换。`contentUpdatePoller` 的 `version.json` 轮询也走同一个 `resolveToolUrl`，生产/开发模式下检测的是各自实际加载的那个地址。

- 每个工具构建时额外产出 `version.json`（CI 构建阶段写：commit sha 或对 `index.html` 引用到的所有 hashed 文件名做一次组合 hash）。
- 壳加载某工具页面时记下当前 `version.json` 的值；之后定时（如 5 分钟）或页面重新获得焦点时，重新拉取该工具的 `version.json` 比对。
- **检测到变化后的流程**：
  1. 壳通过 `webContents.send('nw:request-save')` 触发工具页面（预先用 `window.nwDesktop.onRequestSave` 订阅过）立即落盘当前工作，回一个 ack（或 3s 超时兜底继续往下走，不因为工具没接这个钩子卡住）。
  2. 壳层弹出非阻断提示（如右上角 toast）："发现新版本，工作已自动保存，点击刷新更新"。
  3. 用户点击刷新，或空闲一段时间（如无操作 2 分钟）后自动刷新——**只重载该工具的 BrowserView**（`webContents.reload()` / 重新 `loadURL`），不影响其他已打开的工具页面、不重启整个壳。
- **离线兜底**：拉取不到 `version.json`（断网）不视为"有更新"，直接跳过本轮检查；首次启动/无网络场景下壳仍打包一份最近构建的本地兜底副本（避免完全离线时打不开工具）。

---

## 5. Git 自动提交接口（预留，当前不实现）

现在用不到，但先把接口定下来，方便未来外包接入时只换主进程里的实现、不改工具页面的调用点。

```ts
// 主进程侧，IPC channel: git:status / git:commitAndPush / git:openOrUpdatePR
interface GitSyncController {
  status(workdir: string): Promise<{ dirty: boolean; branch: string; ahead: number }>;

  commitAndPush(opts: {
    workdir: string;
    message: string;
    branch?: string;        // 缺省按配置生成，如 `anim-artist-<name>-<date>`
    authorName: string;
    authorEmail: string;
  }): Promise<{ ok: boolean; commitSha?: string; error?: string }>;

  openOrUpdatePR(opts: {
    branch: string;
    title: string;
    body: string;
  }): Promise<{ ok: boolean; prUrl?: string; error?: string }>;
}
```

- **当前实现**：全部方法返回 `{ ok: false, error: 'not_implemented' }`（`status` 除外，可以先做真的本地 git 状态查询，因为不涉及凭证、风险低）。工具页面 UI（比如未来 animator 的"提交审核"按钮）现在就可以接这个接口写，点了只会提示"暂未开放"，等真正实现时替换主进程内部逻辑即可，前端零改动。
- **真正实现时**（外包接入前再做）预期用 `isomorphic-git`（纯 JS，不需要用户装系统 git）+ 一个权限收窄的 GitHub token；PR 走 GitHub REST API。届时需要另开一份实现细节文档，这里不展开。
- **仓库范围**：目前拍板**不拆资产仓库**，外包直接用主仓库（或其一个子集分支）；等真正引入外包、需要收窄权限时再建独立资产仓库（工作量小，届时再做，见 `animator/WORKSPACE_SYNC.md` 讨论过的路径映射思路可以复用）。

---

## 6. 已知局限 / 待明确问题

- Electron 安装包对外包美术来说仍是"要下载安装一个桌面程序"，比纯网页高一道门槛，但换来了跨平台一致渲染 + 隐藏 git 复杂度，认为值得。
- `version.json` 比对目前设计为轮询，非 push；工具产物更新到用户看到提示之间有最长一个轮询周期的延迟，可接受。
- 多个工具各自远程托管，意味着多一份"发布到哪"的运维（沿用 Cloudflare Pages/Workers，非新增基础设施）。
- 外包 git 凭证的权限收窄方案未定（细粒度 PAT scope、是否限制只能开 PR 不能直接推 main 等），留到真正实现 §5 时再定。
- **本地打包正式安装包（`electron-builder --win`）需要 Windows 开发者模式打开**（设置 → 搜索"开发者模式" / `ms-settings:developers`）——不开的话，`electron-builder` 内部下载解压 `winCodeSign` 工具包（即使无证书、`win.verifyUpdateCodeSignature: false` 也绕不开这一步）会因为包里两个 macOS 符号链接文件在 Windows 非开发者模式下建不了而反复失败。开发者模式打开后一次成功，无需其它配置改动（2026-07-28 实测：`Notebook Wars 工具箱 Setup 0.1.0.exe`）。

---

## 7. 与 `WORKSPACE_SYNC.md` 的关系

`animator/WORKSPACE_SYNC.md` 设计的 Supabase 云工作区 + GitHub Action 同步桥（P1/P2 代码已完成并合并 main）用来解决"协作者免本地部署"的问题。本文档用桌面壳 + 本地文件 + （未来的）git 直接提交取代这个方向：外包美术改用桌面壳而不是网页版云工作区。

**当前不动 `WORKSPACE_SYNC.md` 已合并的代码**（Supabase/`anim-sync.yml` 等），只是新功能不再往这个方向投入；是否下线现有云工作区代码留待桌面壳落地后再评估，避免过早删除还在用的东西。见 [ADR-055](../../DECISIONS.md)。

---

## 8. 分期

- **P1**（✅ 代码完成，`tools/desktop-shell/`）：Electron 壳骨架——窗口 + 侧边栏（`BrowserView`，工具列表 + 切换 + 高亮）+ 内容 `BrowserView`（默认加载 animator dev server）；`contextBridge` 双桥接口先占位——`window.nwShell`（侧边栏用，`listTools`/`switchTool`/`onActiveChanged`）+ `window.nwDesktop`（工具页面用，`git.*` 全部 `not_implemented`、`onRequestSave`/`onUpdateAvailable` 先跑通订阅链路，不接真实更新源；开发菜单"模拟：请求当前工具保存/内容有新版本"手动触发）。验证：`tsc` 编译通过；真实启动 + CDP (`--remote-debugging-port`) 核对侧边栏渲染 4 个工具按钮、`switchTool` 正确切换内容 `BrowserView` URL 并回传高亮、`window.nwDesktop.git.*` 返回约定的 `not_implemented` 结构。
- **P2**（✅ 代码完成）：壳级自动更新——`src/appUpdater.ts`，`electron-updater` + `package.json` `build.publish`（GitHub Releases，`owner: bigtaoo, repo: funny`）。启动 10s 后查一次 + 每 4h 复查；`update-downloaded` 走 §4 统一的 `showUpdateNotice('app', ...)` 提示，用户点刷新或空闲达阈值后 `quitAndInstall()`。**`app.isPackaged` 为 false（未打包直跑源码）时整体跳过**——本地 `npm start` 开发不受影响；真正生效需要仓库实际发布过 Release（外部动作，未做，留给用户决定何时发布）。
- **P3**（✅ 代码完成，已在 animator 上端到端验证）：
  - `src/updateNotifier.ts`：壳级/内容级共用的"合适时机"提示——发一条到侧边栏（`shell:update-available`），用户点击侧边栏"刷新"按钮（`shell:apply-update` IPC）或 `powerMonitor.getSystemIdleTime() ≥ 120s` 自动应用；同一时间只保留一条待处理通知。侧边栏 UI 见 `renderer/index.html`/`sidebar.js` 的 `#update-banner`。
  - `src/contentUpdatePoller.ts`：每 5 分钟（+ 窗口重新获得焦点时提前查一次）拉当前工具的 `/version.json` 跟基线比对；切换工具时同步清空基线（`setActiveTool`），首次加载/热更新触发的 reload 都在 `did-finish-load` 里重新确认基线（`confirmBaseline`）。检测到 hash 变化 → 发 `nw:request-save`（3s 超时兜底）→ 展示提示 → 应用时 `webContents.reload()`。离线/无 manifest 时 `fetch` 失败直接跳过本轮，不算错误。
  - 四个工具的 `webpack.config.js` 都加了 `VersionManifestPlugin`（`compilation.hooks.processAssets` 阶段，对全部资源文件名+大小求 sha256 产出 `version.json`；4 份互相独立的小类，未抽公共文件，与 animator `interpolate.ts` 的既有"小工具允许重复"惯例一致）——dev server 直接把它当编译产物一并 serve，不需要额外配置。
  - animator 侧接了真实落盘：`AutoSaveController` 新增公开方法 `requestFlush()`（包一层私有 `flushNow()`），`App.ts` 里 `window.nwDesktop?.onRequestSave(() => autoSave.requestFlush())`；其余三个工具目前没有自动保存机制，`onRequestSave` 暂不接（按设计留空）。
  - **端到端验证**（非只读代码）：临时把轮询间隔调到 3s、加调试日志，实际改动 animator 源码触发 webpack 重新编译 → `version.json` hash 真的变了 → 轮询检测到 → 侧边栏弹出"当前工具有新版本，已自动保存工作 · 刷新" → 通过 CDP 调 `window.nwShell.applyUpdate()` 模拟点击 → 内容视图 reload、提示消失、基线刷新到新 hash。验证完成后已还原成正式的 5 分钟轮询间隔并删掉调试日志。
- **P4**（外包真正接入前）：`GitSyncController` 真实实现（`isomorphic-git` + 权限收窄 token + 自动开 PR）——本次未做。
- **生产地址接线 + 品牌化（2026-07-28）**：`tools.ts` 加 `prodUrl` + `resolveToolUrl()`（见 §4.2），装好的正式包默认连生产、开发跑源码默认连本地，验证过两种模式各自正确。品牌名从占位的"Notebook Wars 工具箱"改为 **NW Tool**（`package.json` 根 `productName` + `build.productName` + 窗口标题 + 侧边栏 `<title>`，一并改）；图标用仓库既有游戏品牌 logo（`art/logo/derived/logo-1024.png` → `tools/desktop-shell/build/icon.png`，electron-builder 按约定路径自动转 ico），验证：提取打包出的 exe 图标核对过确实是这个盾形 logo。

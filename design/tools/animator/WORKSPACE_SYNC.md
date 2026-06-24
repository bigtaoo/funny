# Animator 在线工作区 + 云盘→仓库同步桥

> 状态：设计中 · 更新：2026-06-23
> 范围：让 animator 部署到线上（Cloudflare Pages），协作者免本地部署即可做动画；动画存到共享云工作区，再自动同步回 git 仓库（PR 把关）。
> 关联：[ARCHITECTURE.md](ARCHITECTURE.md)（编辑器架构）· [claudedocs/file-formats.md](../../../claudedocs/file-formats.md)（.tao / .tao.editor 格式）· [claudedocs/animator.md](../../../claudedocs/animator.md)（快查）

---

## 0. 背景与目标

**痛点**：animator 现在只能本地 `npm start`（端口 9091）；找人帮做动画要对方本地部署，且动画存在浏览器 IndexedDB / 手动下载 `.tao` 文件里，是**孤岛**，无法在编辑器 / 本地 / 其他人之间同步。

**目标**：
1. animator 作为**纯静态站点**部署到 Cloudflare Pages（`animator.<域名>`），协作者开网页即用、零本地部署。
2. 建一个**共享在线工作区**：协作者在编辑器里登录后，能看到、打开、保存团队的动画（云盘式，**不碰 git**）。
3. **自动桥接回仓库**：工作区里的动画通过 GitHub Action 定时/手动同步，自动开 PR 写回 `art/units/**` 与 `client/src/assets/**`；维护者只需 review + merge（"我桥接"模型）。

**铁律**：git 仓库始终是动画的**唯一权威源**（游戏构建期 import `.tao`，见 `client/src/render/UnitView.ts`）。工作区是协作前台，**不是第二真源**；同步方向单向（云→仓库，PR 把关），避免双向冲突。

---

## 1. 现状事实（实现依据）

- `.tao` 资产在仓库：主版 `art/units/<兵种>/*.tao`，游戏侧 `client/src/assets/*.tao`（`UnitView.ts` 第 9–11 行构建期 import）。**`.tao.editor` 可编辑主文件目前不在仓库**（需纳入，见 §4）。
- animator 纯前端：`tools/animator/package.json` 仅 `start`（webpack-dev-server）+ `build`（production → `dist/`），无后端。
- 现有 IO 层（复用对象）：
  - `io/IOController.ts`：`buildEditorBlob()` 构 `.tao.editor`、`loadEditorBlob()` 还原、`exportTao()` 出 `.tao`、`importTao()` 导入。
  - `io/ProjectStore.ts`：IndexedDB，接口 `listMeta()/getBlob(id)/put(meta,blob)/putMeta/delete`。
  - `io/AutoSaveController.ts`：自动保存。

---

## 2. 架构

```
[animator @ Cloudflare Pages]  ──存/取──▶  [Supabase Storage 桶: animations]
   ▲ 协作者开 animator.<域名> 登录              │
   │ 拖图/做动画/点"保存到工作区"                │ (GitHub Action 用 service key 读取)
                                                ▼
                              [GitHub Action: anim-sync (定时 + 手动 dispatch)]
                                 下载所有 .tao.editor + .tao
                                 → 按 manifest 写入 art/units/** 与 client/src/assets/**
                                 → 用 create-pull-request 自动开 PR
                                                │
                                                ▼
                              [维护者 review + merge → 游戏自动重新构建]
```

### 2.1 选型拍板
| 项 | 选定 | 理由 |
|---|---|---|
| 静态托管 | **Cloudflare Pages** | monorepo 子目录构建友好、自定义域名 + HTTPS 一键、CDN 快、免费额度大 |
| 工作区存储 | **Supabase Storage** | 自带 Auth + 浏览器 JS SDK + RLS，前端代码最少；R2 需额外写 Worker 才能安全鉴权 |
| 协作者登录 | **Supabase 邮箱 magic-link** | 无密码管理，发链接点一下即进 |
| 同步方向 | **单向 云→仓库，PR 把关**（v1） | 维护者是技术枢纽，审核后再进 main；双向同步需处理冲突，过度设计 |
| 冲突处理 | v1 **后写覆盖 + "最后保存者/时间"标签**；按兵种约定各管各的 | 小团队够用，不上锁 |

---

## 3. 工作区数据模型（Supabase）

- **桶**：`animations`（private）。
- **对象布局**（与仓库路径一一对应，让同步确定性）：
  ```
  units/<unitKey>/<name>.tao.editor    ← 可编辑主文件（协作者实际编辑的）
  units/<unitKey>/<name>.tao           ← 导出的运行时包（保存时一并上传）
  ```
- **元数据**：用对象的自定义 metadata 或一张轻表 `workspace_files(path, name, unit_key, updated_at, updated_by)` 记 "最后保存者/时间"，供编辑器列表展示。
- **权限（RLS）**：authenticated 用户可读写 `animations` 桶；匿名禁止。
- **登录**：Supabase Auth magic-link，团队成员邮箱白名单（或开放注册 + 维护者审批）。

---

## 4. 仓库侧：纳入 .tao.editor 主文件 + 映射清单

- **新增**：把 `.tao.editor` 主文件纳入版本库 `art/units/<兵种>/<name>.tao.editor`（当前仓库只有导出的 `.tao`，主文件不可二次编辑——补齐后动画资产完整可追溯）。
- **映射清单** `art/units/manifest.json`（同步桥的唯一映射真源）：
  ```jsonc
  {
    "units": {
      "archer":        { "editor": "art/units/archer/archer.tao.editor",
                         "tao":    "art/units/archer/archer.tao",
                         "gameCopy": "client/src/assets/archer.tao" },
      "infantry":      { ... },
      "shield_bearer": { ... }
    }
  }
  ```
  - `gameCopy`：把运行时 `.tao` 复制进 `client/src/assets/`（`UnitView.ts` 的 import 源）。
  - 工作区对象 `units/<unitKey>/...` 通过 `unitKey` 映射到此清单条目。

---

## 5. 同步桥（GitHub Action）

- 文件：`.github/workflows/anim-sync.yml`
- 触发：`schedule`（如每日一次）+ `workflow_dispatch`（手动按钮）。
- 步骤：
  1. checkout 仓库。
  2. 用 repo secret `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` 列出并下载 `animations` 桶全部对象。
  3. 按 `art/units/manifest.json` 把每个 `unitKey` 的 `.tao.editor` / `.tao` 写入对应仓库路径，并复制 `.tao` → `gameCopy`。**仅内容真变更才写**（见下「ZIP 内容比对」）。
  3b. **自动发现兜底**：再列举 `units/` 全部子目录，凡 **manifest 未登记**的 `unitKey`，把其 `.tao.editor`（源主文件）+ `.tao` 写到默认路径 `art/units/<unitKey>/<name>.tao(.editor)`——保证美术新建的兵种源文件不会因没人手填 manifest 而漏同步、误删即丢。**不写 `gameCopy`**：接入游戏构建仍需人工补 manifest 条目这一明确动作。路径段含 `/ \ ..` 的一律跳过（防越界写）。
  4. 若有 diff：用 `peter-evans/create-pull-request` 开/更新 PR（分支 `anim-sync/auto`，标题 `chore(anim): 从工作区同步动画`，正文列出变更的 unit + 最后保存者）。
- **不直接推 main**：始终 PR，维护者 review 后 merge → 触发 client 重新构建。

**ZIP 内容比对（避免无谓 PR）**：`.tao`/`.tao.editor` 都是 ZIP，浏览器每次保存会写入新的「最后修改时间」到每个条目头，导致同内容不同字节。若按整包字节比对，没人编辑也会判为变更、开空 PR。故 `anim-sync.mjs` 的 `writeIfChanged` 先做字节比对，不等时再解析 ZIP **中央目录**取每个条目的 `名字 + CRC32 + 解压大小` 组成规范签名比对——签名相同（仅时间戳等打包元数据不同）则不写、不计入变更；CRC 不同（真改动）才写并开 PR。纯 Node 内置解析，无依赖；非 ZIP 退回字节比对。

---

## 6. animator 侧改动

- 新建 `io/WorkspaceStore.ts`：**镜像 `ProjectStore` 接口**（`listMeta/getBlob/put`），后端换成 Supabase Storage（`@supabase/supabase-js`）。
- 新建 `io/WorkspaceController.ts`（或并入 IOController）：
  - 登录/登出（magic-link）UI。
  - 列表面板：列出工作区动画 + "最后保存者/时间"。
  - 打开：从工作区拉 `.tao.editor` → 复用 `IOController.loadEditorBlob()`。
  - 保存到工作区：复用 `buildEditorBlob()` + `exportTao()` 产物 → 上传 `.tao.editor` + `.tao` 到 `units/<unitKey>/`。
  - **云端自动同步**：手动存过 / 从工作区打开过某动画后即「绑定」该 `unitKey/name` 槽位；勾选「自动同步到工作区」后，监听与本地自动存同一组 `DIRTY_EVENTS`，防抖 4s 把 editor+tao 上传到绑定槽位（晚于本地 1.5s 自动存，批量减少云写）。未绑定（新建未命名）不上传；登出即停。
- 配置注入：Supabase URL + anon key 走 webpack `DefinePlugin`（构建期注入，参照 client 的 `__NW_API_BASE__` 范式）。
- 本地/离线不受影响：IndexedDB 自动保存 + 手动下载保留为后备；云端自动同步是其上的跨设备/共享安全网，非替代。

---

## 7. 部署（Cloudflare Pages）

- 连接 git 仓库 → 构建命令 `cd tools/animator && npm install && npm run build`，输出目录 `tools/animator/dist`，根目录 monorepo 根。
- 环境变量：`SUPABASE_URL`、`SUPABASE_ANON_KEY`（注入构建）。
- 绑定 `animator.<域名>`，自动 HTTPS。push 即自动重新部署。

---

## 8. 分期

- **P1**：Supabase 项目（桶 + Auth + RLS）；animator `WorkspaceStore` + 工作区面板（登录/列表/打开/保存）；Cloudflare Pages 部署。→ 协作者可共享在线工作区。
- **P2**：仓库纳入 `.tao.editor` 主文件 + `art/units/manifest.json`；`anim-sync.yml` 同步桥 + 自动 PR。→ 维护者"只点合并"。
- **P3**（可选）：把仓库现有 `.tao`/`.tao.editor` 回灌进工作区作初始种子。

### 8.1 实现记录

- **P1 前端切片（2026-06-23，feat/animator-workspace）✅ 代码完成**：
  - `io/workspaceConfig.ts` + `globals.d.ts`：Supabase 连接走 webpack DefinePlugin 注入（`NW_SUPABASE_URL` / `NW_SUPABASE_ANON_KEY`），未配置则空串、工作区静默禁用，离线编辑不受影响。
  - `io/WorkspaceStore.ts`：`@supabase/supabase-js` 封装——magic-link 登录（`signInWithOtp`）+ Storage 读写；对象布局 `units/<unitKey>/<name>.tao.editor` + `.tao`；`list()` 遍历 unit 文件夹列出 `.tao.editor` 主文件。
  - `io/IOController.ts`：抽出 `buildTaoBlob()`（不触发下载），供工作区上传浏览器构建好的 `.tao`（CI 桥无法重建 spritesheet）。
  - `ui/WorkspacePanel.ts`：底栏 `☁ Workspace` 按钮 → 自建模态：登录 / 列表 / 打开（载入 `.tao.editor`）/ 保存当前（上传 `.tao.editor`+`.tao`）。
  - 接线 `App.ts`，按钮入 `index.html`。验证：`tsc --noEmit` 通过 + `webpack --mode production` 构建通过。
  - **待用户提供方能端到端跑通**：①创建 Supabase 项目（桶 `animations` + Auth + RLS 仅 authenticated 可读写）；②Cloudflare Pages 连仓库（构建 `cd tools/animator && npm i && npm run build`，输出 `tools/animator/dist`，环境变量 `NW_SUPABASE_URL` / `NW_SUPABASE_ANON_KEY`）。
- **P2 同步桥（2026-06-23，feat/animator-workspace）✅ 代码完成**：
  - `art/units/manifest.json`：unitKey → `{name, editor, tao, gameCopy}` 映射真源（archer / infantry / shield_bearer）。workspace 对象 `units/<unitKey>/<name>.tao(.editor)` 据此写回仓库。
  - `tools/animator/scripts/anim-sync.mjs`：Node 20 原生 fetch（无 npm 依赖），直连 Supabase Storage REST 下载每个 unit 的 `.tao.editor`+`.tao`，按 manifest 写入 `editor`/`tao`/`gameCopy`（仅内容变更才写）；单向、永不删仓库文件；缺对象则跳过。验证：`node --check` 通过、manifest 可解析、缺环境变量守卫 exit 1。
  - `.github/workflows/anim-sync.yml`：每日 cron + 手动 dispatch；跑脚本 → 有变更则 `peter-evans/create-pull-request` 开/更新 PR（分支 `anim-sync/auto` → main）。
  - **待用户提供**：repo secrets `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`（service role key）；并设 repo variable `ANIM_SYNC_ENABLED=true` 启用同步 job（未设时 job 干净跳过，避免配好前每日 cron 报红）。
  - **已知历史 cruft（非本任务范围）**：`art/units/archer/archer.tao.editor.tao.editor`、`.../shield_bearer/shieldbearer.tao.editor.tao.editor` 是早先保存 bug 留下的双扩展名文件；manifest 用规范单扩展名，首次同步会写正确文件，双扩展名残件待单独清理。
- P3（种子回灌）未开始。
- **上线 + 云端自动同步（2026-06-23，已合 main）✅**：
  - **部署实况**：Cloudflare 实际建成的是 **Workers 构建（非 Pages）**——build=`cd tools/animator && npm install && npm run build`，deploy=`npx wrangler versions upload`。故仓库根加 `wrangler.jsonc`（assets-only：`directory ./tools/animator/dist` + SPA 回退；`name: animator` 对齐 Worker 名）。站点 `https://animator.tao-wang-go.workers.dev`。Build variables `NW_SUPABASE_URL` / `NW_SUPABASE_ANON_KEY`（实测线上 bundle 已注入）。
  - **命名统一**：同步桥 `anim-sync.mjs`/`.yml` 改读 `NW_SUPABASE_URL`（与前端同名，省去用户再建无前缀 secret）+ `SUPABASE_SERVICE_KEY`；启用开关是 **repo variable `ANIM_SYNC_ENABLED=true`**（非 secret）。
  - **云端自动同步**：`ui/WorkspacePanel.ts` 新增——绑定槽位（手动存 / 打开时 `bindTo`）、勾选框（偏好存 `localStorage` key `nw-animator:workspaceAutoSync`）、防抖 4s 上传、`visibilitychange` 隐藏时抢存；`io/AutoSaveController.ts` 导出 `DIRTY_EVENTS` 供复用。`tsc` + `webpack` 通过。
  - **v1 限制**：绑定为会话级（刷新后需重新打开/保存才再绑定；开关偏好持久），避免刷新后把内容错写到旧槽位；本地 IndexedDB 自动存仍兜底内容不丢。
- 历史双扩展名残件已清理（commit 3e78fb7d）。
- **GitHub Action 自动部署（2026-06-24）✅**：`.github/workflows/animator-deploy.yml`——push 到 main 命中 `tools/animator/**` / `wrangler.jsonc` / 该工作流文件，或手动 dispatch 触发；`npm ci` → `npm run build`（build env 注入 `NW_SUPABASE_URL` / `NW_SUPABASE_ANON_KEY`，与 CF Build variables 同名）→ 从仓库根 `npx wrangler@4.104.0 deploy`（默认读 `wrangler.jsonc`，assets-only）。复用 ops/client 的 repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（同账号全 Worker 适用）。启用开关 repo variable `ANIMATOR_DEPLOY_ENABLED=true`（未设则 job 干净跳过，避免配好前每次 push 报红）。与 CF git-connected 构建并存，谁先到谁部署，结果一致。
- **登录会话持久化（2026-06-23）**：此前 `currentEmail()` 用 `getUser()`（拿 token 去服务器 revalidate），access token 默认 1h 过期后即判登出、被打回 magic-link。改为 `getSession()`（读本地持久会话 + 用 refresh token 自动续签）；并在 `createClient` 显式开 `persistSession / autoRefreshToken / detectSessionInUrl` + 固定 `storageKey: 'nw-animator-auth'`。登录后长期免重登（除非主动登出或 refresh token 失效）。
- **保存反馈进弹窗 + 自动发现兜底（2026-06-23）**：
  - `ui/WorkspacePanel.ts`：「保存到工作区」按钮在 unitKey/name 未填 / 保存失败时，原本只 emit 底栏 `status`（一闪即逝、易漏），看着像按钮无效。新增模态内联提示行 `setSaveHint(msg, kind)`——未填字段时提示「请先填 unitKey 和 name」并聚焦缺失输入框；保存失败时在弹窗内显示错误 + 「若未登录请重发登录链接」。
  - `tools/animator/scripts/anim-sync.mjs`：新增 `listChildren(prefix)`（Storage REST `object/list`）做**自动发现**——manifest 未登记的 unitKey 也把 `.tao.editor`+`.tao` 写到 `art/units/<unitKey>/<name>`，杜绝新建兵种源文件因漏填 manifest 而丢失；不写 `gameCopy`（接入游戏构建仍需人工补 manifest）；路径段含 `/ \ ..` 跳过。列举失败时 graceful 降级（manifest 单元照常同步）。`tsc --noEmit` + `node --check` 通过。

---

## 9. 开放问题（实现期定）
- magic-link 邮箱是白名单还是开放注册 + 审批？
- 同步桥定时频率（每日 / 每 6h / 仅手动）？目前定每日 03:00 UTC + 手动。
- 是否需要"工作区软锁"（标记某 unit 正被谁编辑）以降低后写覆盖概率——v1 先不做，观察是否真冲突。
- `.tao.editor` 含 PNG，体积偏大；Supabase 免费层 1GB 存储是否够，超了再上 R2。

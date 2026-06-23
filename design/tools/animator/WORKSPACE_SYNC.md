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
  3. 按 `art/units/manifest.json` 把每个 `unitKey` 的 `.tao.editor` / `.tao` 写入对应仓库路径，并复制 `.tao` → `gameCopy`。
  4. 若有 diff：用 `peter-evans/create-pull-request` 开/更新 PR（分支 `anim-sync/auto`，标题 `chore(anim): 从工作区同步动画`，正文列出变更的 unit + 最后保存者）。
- **不直接推 main**：始终 PR，维护者 review 后 merge → 触发 client 重新构建。

---

## 6. animator 侧改动

- 新建 `io/WorkspaceStore.ts`：**镜像 `ProjectStore` 接口**（`listMeta/getBlob/put`），后端换成 Supabase Storage（`@supabase/supabase-js`）。
- 新建 `io/WorkspaceController.ts`（或并入 IOController）：
  - 登录/登出（magic-link）UI。
  - 列表面板：列出工作区动画 + "最后保存者/时间"。
  - 打开：从工作区拉 `.tao.editor` → 复用 `IOController.loadEditorBlob()`。
  - 保存到工作区：复用 `buildEditorBlob()` + `exportTao()` 产物 → 上传 `.tao.editor` + `.tao` 到 `units/<unitKey>/`。
- 配置注入：Supabase URL + anon key 走 webpack `DefinePlugin`（构建期注入，参照 client 的 `__NW_API_BASE__` 范式）。
- 本地/离线不受影响：IndexedDB 自动保存 + 手动下载保留为后备。

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

---

## 9. 开放问题（实现期定）
- magic-link 邮箱是白名单还是开放注册 + 审批？
- 同步桥定时频率（每日 / 每 6h / 仅手动）？
- 是否需要"工作区软锁"（标记某 unit 正被谁编辑）以降低后写覆盖概率——v1 先不做，观察是否真冲突。
- `.tao.editor` 含 PNG，体积偏大；Supabase 免费层 1GB 存储是否够，超了再上 R2。

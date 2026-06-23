# 上线收口 Track 2 — 服务端闭环补全

> 创建：2026-06-23。源自全系统上线核查。
> **纯服务端轨道**：全部改动在 `server/` 内，**不依赖 Track 1/3**（Track 1 调用的端点本就已存在）。
> worktree 建议：`git worktree add ../funny-launch-server launch-server`
> 约定：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。每项标 **主要文件** / **验收**。

---

## 背景

上线核查中服务端 8 条核心链路有 7 条完全接通，唯一断点是「赛季收束自动颁奖闭环」；另有称号端点形态偏离设计、IAP 生产凭据机制需核对与文档化。本轨道补这三块（中国区合规字段作为可选预留）。

---

## L2-1  赛季自动结算闭环（⚠️ 唯一断裂链路）

**现状**：称号授予/读取/展示完整、赛季 `roll`（admin 手动推进，`internal.ts` ~580 `rollSeason`）已有；**缺**「赛季收束 → 按峰值段位自动发奖励邮件 + 自动授予段位首达/赛季称号」的闭环。

**范围**：
- `POST /internal/season/close`（或扩展现有 `rollSeason`）：生成 `ladderSeasons` 快照 `{accountId, seasonId, peakElo, rank, rewards}` → 按段位档位生成奖励 → 走已有邮件 fan-out 路径（admin `mail.send` / meta `/internal/mail/send`）发段位奖励 → 对达标段位调 `grantTitleToPlayer`（`titles.ts` 已有）授予赛季称号。
- 惰性软重置已有则复用（`elo = 1200 + (elo-1200)*0.5`）；确认 open/close 与软重置不重复执行（幂等 by seasonId）。

**主要文件**：`server/metaserver/src/internal.ts`、`server/metaserver/src/titles.ts`、`server/shared/src/ladder.ts`（段位奖励档位表，若无则新增）、`server/shared/src/mongo.ts`（`ladderSeasons` 集合若缺则补）。

**验收**：close 触发后达标账号收到段位奖励邮件 + 段位称号；重复 close 同 seasonId 不双发（幂等单测）；快照 `peakElo/rank` 与赛季内最高分一致。

---

## L2-2  称号端点形态补齐（设计对齐）

**现状**：玩家侧靠 SaveData 回推展示称号（能用），但缺设计文档列的独立端点。`TitlesScene` 客户端已接 SettingsScene。

**范围**：
- `GET /titles`：返回当前账号全量已授予称号（含 source/seasonId/grantedAt）。
- `PUT /title/equip`：选用当前显示称号 → 写 `save.equipped.title` → 回推。
- 复用已有 `titles.ts` 存储；openapi.yml 登记两端点。

**主要文件**：`server/metaserver/src/service.ts`、`server/metaserver/src/titles.ts`、`server/contracts/openapi.yml`、客户端 `client/scripts/gen-openapi.mjs` 重生（产物提交）。

**验收**：`GET /titles` 与 `save.titles[]` 一致；`PUT /title/equip` 仅允许已授予称号（未授予返错）；回推后 ProfilePopup/排行榜行展示正确。

**注**：若评估认为现有回推机制已足够、不愿增端点，可改为「在文档中明确记录称号走 SaveData 回推、不另设端点」并关闭本项——任选其一，避免悬而未决。

---

## L2-3  IAP 生产凭据机制核对 + 文档化（P0 配套）

**现状**：Apple/Google/微信/Stripe 验签代码全真，无凭据自动降级 dev 桩。

**范围**（**不写新验签逻辑，只核对+文档化+加固**）：
- 核对 `commercial/src/iap.ts` 各平台环境变量读取路径与降级分支正确（无凭据 → `{ok:false}` 或 dev 桩，按 `NW_IAP_DEV` 区分，确保**生产环境缺凭据不会误命中 dev 桩**）。
- 在 `server/.env.example` 补齐并注释所有 IAP/广告所需环境变量（`NW_APPLE_PASSWORD` / `NW_GOOGLE_SERVICE_ACCOUNT_JSON` / `NW_GOOGLE_PACKAGE_NAME` / `NW_WX_PAY_*` / `NW_STRIPE_SECRET_KEY` / `NW_ADMOB_*` / `NW_WECHAT_ADS_KEY`）。
- 新增/更新 `claudedocs/server.md` 或 `design/game/` 对应文档：每个凭据从哪里申请、配置位置、上线前 checklist。
- 加固：生产环境（`NODE_ENV=production`）若 `NW_IAP_DEV` 为真则启动期告警/拒启（防误开 dev 桩）。

**主要文件**：`server/commercial/src/iap.ts`、`server/commercial/src/index.ts`、`server/.env.example`、文档。

**验收**：dev 桩在 production 下默认关闭且无凭据时验签返失败（单测）；`.env.example` 覆盖全部凭据并附申请说明。

---

## L2-4（可选，仅中国区）中国区合规字段预留

> 仅当确定上中国区才做；海外发布不阻断。可单独留到版号申报前。

**范围**：`accounts` schema 预留 `realNameVerified` / `ageBand` / `birthYear` 字段；实名认证接口、防沉迷时长检测、分龄充值限额按 `COMPLIANCE_CN.md` 实现。本项工作量大，建议拆为独立计划，不在本轨道强制完成。

**验收**：见 `COMPLIANCE_CN.md`。

---

## 通用验收（全轨道结束前）

- `cd server && npx tsc -b`（或对应包）全绿 + 各包 vitest 全绿。
- 新增端点经 openapi.yml 装配、客户端 codegen 重生不漂移。

## 交接点

- L2-1 复用已有邮件 fan-out（admin/meta）与 `grantTitleToPlayer`，无需新基建。
- L2-2 若新增端点，客户端可在 Track 1 之外择机接入（非阻塞，现有回推已可展示）。

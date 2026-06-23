# 上线收口 Track 1 — 客户端合规 UI + 孤儿场景接线

> 创建：2026-06-23。源自全系统上线核查（见 `PARALLEL_DEV_PLAN.md` 发布门 + 本轮分析）。
> **纯客户端轨道**：全部改动在 `client/src` 内，调用的服务端端点均已就绪，**不依赖 Track 2/3**。
> worktree 建议：`git worktree add ../funny-launch-client launch-client`
> 约定：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。每项标 **主要文件** / **验收**。

---

## 背景

服务端合规底座已就绪（`recordGdprConsent` / `DELETE /account` / 抽卡 `probability` 回推都已实现），缺的是客户端入口与弹层；另有两个已完整实现的留存场景（DailyScene/EventScene）没接进导航，等于白做。本轨道把这些收口。

---

## L1-1  GDPR 首次启动同意弹层（P0 发布阻断）

**范围**：
- 首次启动（intro 后、进大厅前，或登录成功后）弹「隐私政策 + Cookie 同意」弹层；用户接受后调 `ApiClient` 写 `flags.gdprConsent: true`，本地也落 `flags` 立即生效。
- 已同意（`flags.gdprConsent === true`）则不再弹。
- 弹层含隐私政策/用户协议链接占位（真实文本由 Track 3 提供，先用 i18n key 占位）。
- 匿名/离线用户也要能看到并接受（埋点门控对已登录用户生效）。

**主要文件**：`client/src/app/createAppCore.ts`（启动门控 `resolveEntry` 附近插入同意检查）、新增 `client/src/render/ConsentDialog.ts`（参照 `ProfilePopup.ts` 自绘弹窗风格）、`client/src/net/ApiClient.ts`（加 `recordGdprConsent(consent)` 调 `POST /account/gdpr-consent`）、i18n `consent.*`（zh/en/de 全翻）。

**验收**：未同意账号不进大厅且 analyticsvc 收不到其埋点；同意后写 `flags.gdprConsent` 跨设备同步（经 SaveManager push）；二次启动不再弹。

---

## L1-2  账号删除入口（P0 发布阻断，Apple 5.1.1(v)）

**范围**：
- `SettingsScene` 资料页加「删除账号」入口（红色危险样式，位于登出下方）。
- 点击 → 二次确认弹层（输入确认或长按确认）→ 调 `ApiClient.deleteAccount()`（`DELETE /account`，已实现软删 `deletedAt`）→ 清本地 token/存档 → 回登录页并提示「7 天宽限期内可重新登录恢复」。

**主要文件**：`client/src/scenes/SettingsScene.ts`（`drawAccount()` ~347 行附近）、`client/src/net/ApiClient.ts`（加 `deleteAccount()`）、i18n `settings.deleteAccount.*`。

**验收**：删除后 auth 返 `ACCOUNT_DELETED`（410）走登录页；二次确认避免误触；离线模式隐藏入口（无账号可删）。

---

## L1-3  抽卡概率详情弹层（P0 发布阻断，Apple 3.1.1）

**范围**：
- `GachaScene` 在现有稀有度图例（~196 行）旁加「概率详情」按钮 → 弹层逐条列出 `entries[]`（itemId / rarity / probability 百分比）+ 保底规则说明。
- 数据已由服务端回推（`getGachaPools()` 的 `entries[].probability` 字段就绪），客户端只渲染，不计算。

**主要文件**：`client/src/scenes/GachaScene.ts`、i18n `gacha.oddsDetail.*`。

**验收**：弹层概率之和显示为 100%（或贴近，含保底说明）；皮肤名占位用 itemId（待美术）；离线无 pool 数据时按钮置灰。

---

## L1-4  DailyScene 导航接线（高优先级，留存钩子）

**范围**：
- `DailyScene`（311 行已完整实现，签到月历 + 日常任务 + 领取红点）当前是孤儿——`LobbyScene` 声明了 `onOpenDaily?()`（~L79）但 `createAppCore.ts` 未绑定、`AppViews` 无 `showDaily`。
- 补齐：`AppViews` 加 `showDaily`、`createAppCore.ts` 实现 `onOpenDaily` 回调（接 retention 接口 `POST /retention/checkin` + `POST /retention/daily/claim`，均已实现）、`LobbyScene` 加「每日」入口按钮 + 红点（有可领奖励时亮）。

**主要文件**：`client/src/app/AppViews.ts`、`client/src/app/createAppCore.ts`、`client/src/scenes/LobbyScene.ts`、`client/src/scenes/DailyScene.ts`（按需补 props 接线）。

**验收**：大厅可点进每日界面；签到/日常领取走服务器权威回推；红点逻辑正确（领完消失）。

---

## L1-5  EventScene 导航接线（中优先级）

**范围**：
- `EventScene`（344 行已完整实现，活动列表 + 任务进度 + 积分商店）当前完全无入口。
- 补齐：`AppViews` 加 `showEvents`、`createAppCore.ts` 实现回调（接 `GET /events` + `POST /events/claim`，已实现）、大厅加「活动」入口（建议仅在 `GET /events` 返回非空窗口时显示，避免空界面）。

**主要文件**：`client/src/app/AppViews.ts`、`client/src/app/createAppCore.ts`、`client/src/scenes/LobbyScene.ts`、`client/src/scenes/EventScene.ts`。

**验收**：有活动窗口时大厅显入口、可进；活动期外 claim 被服务端拒（已实现）；无活动时入口隐藏。

---

## 通用验收（全轨道结束前）

- `cd client && npx tsc --noEmit` 干净 + `npm test` 全绿 + webpack 构建通过。
- 新增 i18n key zh/en/de 三语齐全（缺翻译会触发 i18n 校验）。

## 交接点

- L1-1/L1-2/L1-3 调用的服务端端点（`recordGdprConsent`/`deleteAccount`/`getGachaPools`）**已就绪，无需等 Track 2**。
- 隐私政策/用户协议**真实文本**由 Track 3 产出；本轨道先用 i18n 占位 key，文本到位后替换即可（不阻塞）。

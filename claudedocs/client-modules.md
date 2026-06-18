# client/ 关键约束与核心模块

## 关键约束

- **渲染**：`pixi.js-legacy`，兼容微信小游戏 WebGL
- **游戏逻辑**：纯 TS，固定点数（`game/math/fixed.ts`），与渲染解耦
- **平台适配**：Web / 微信小游戏 / CrazyGames，多入口 webpack 构建
- **骨骼动画 Runtime**：`StickmanRuntime`（`src/render/stickman/`），加载 `.tao` ZIP，驱动 PIXI Sprite
- **确定性约束**：游戏逻辑（`client/src/game/`）内严禁 `Math.random()`，必须用 `Prng`（`game/math/prng.ts`）
- **多语言（i18n）**：`zh.ts` 为键唯一来源（`TranslationKey`），`en`/`de` 声明为 `Record<TranslationKey, string>` 漏翻报错；`t(key, params?)` 取词，支持 `{param}` 插值
- **网络协议 codegen**：`transport.proto`/`game.proto` → ts-proto via buf → `src/net/proto/`；`openapi.yml` → openapi-typescript → `src/net/openapi.ts`；改契约须重跑 `npm run proto:gen` / `npm run rest:gen`
- **统一输入管线（M13）**：`InputSource` 接口，`LocalInputSource`（单机）/ `NetInputSource`（联机锁步）/ `RecordingInputSource`（录制）/ `ReplayInputSource`（回放）

## 核心模块

| 文件 | 职责 |
|---|---|
| `game/GameEngine.ts` | 主循环、系统编排、命令处理；每 tick 从 `InputSource` 消费指令；tick 顺序：resource→production→**trait**→combat→escort→hazard→movement→spell |
| `game/net/InputSource.ts` | 统一输入管线接口 + `LocalInputSource` |
| `game/net/ReplayInputSource.ts` | `RecordingInputSource`（捕获确认帧，`snapshot()→Replay`）+ `ReplayInputSource`（喂 Replay，永不停步） |
| `game/net/NetInputSource.ts` | 联机锁步：`submit`→opaque `cmd_submit`；`frame_batch`→解码→`take(frame)`；未确认返 `null` 停步 |
| `game/meta/ReplayStore.ts` | 本地录像：key `nw_replays_v1`，最近 12 局 ring |
| `game/GameState.ts` | 纯数据状态，持有 Board / Player / PRNG |
| `game/systems/AISystem.ts` | AI 决策（威胁驱动三段式；注入 Prng + 难度档） |
| `game/systems/TraitSystem.ts` | 被动 trait tick：regen / aura_heal（fp 累加→整数 HP）；slow 倒计时到期 resetSpeed；summonOnTimer 倒计时到期出兵；在 combat 前执行 |
| `game/math/prng.ts` | LCG 确定性随机数生成器 |
| `game/math/fixed.ts` | 定点数运算（`TICK_RATE = 30`） |
| `i18n/index.ts` | `t()` 取词 + 插值；`initI18n`/`setLocale`/`onLocaleChange` |
| `game/meta/SaveData.ts` | 元系统单一权威根；`makeNewSave`/`SyncPatch`/`SAVE_VERSION` |
| `game/meta/migrate.ts` | `migrate(raw)→SaveData`：顺序升级 + fillDefaults；改字段必加迁移步 |
| `game/meta/SaveManager.ts` | 云同步：离线优先→bootstrap→防抖 push→409 reconcile；PvE 通关/升级走 `/pve/*` API |
| `net/ApiClient.ts` | metaserver REST 客户端（fetch + ApiResp 包络） |
| `net/NetClient.ts` | WS 连接/重连（退避+代次）/ts-proto 编解码 |
| `net/NetSession.ts` | 联机会话：gateway(控制面 `/gw`) + game(数据面 `?ticket=`) 双连接；跨场景存活 |
| `net/proto/{transport,game}.ts` | ts-proto 生成（勿手改） |
| `scenes/RoomScene.ts` | 好友房 UI：idle→codeEntry→connecting→inRoom |
| `render/sketch.ts` | `SketchPen`：确定性 Prng 抖动的手绘笔触 |
| `render/sketchUi.ts` | 共享手绘 UI 原语（纸底/手绘按钮/面板/色板单一来源） |

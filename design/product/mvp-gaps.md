# MVP 缺口清单（CrazyGames 上架版）

版本：v0.2  
日期：2026-06-01  
状态：**已归档**（早期 CrazyGames 最小上架盘点；游戏已远超 MVP 范畴——盲盒、SLG、赛季、社交均已落地。仅留作历史参考）

---

## 背景

目标：发布一个可在 CrazyGames 上架的最小版本，用于小范围真实玩家测试，获取反馈后再推广到其他平台。

---

## ✅ 已完成

### 1. 场景管理器 + 完整游戏流程
`SceneManager` 已实现，流程：大厅 → 匹配(1.8s) → VS画面(2.5s) → 游戏 → 结算 → 大厅。

### 2. 大厅界面（LobbyScene）
Logo、匹配按钮动效、VS 覆层、AI 随机名字均已实现。

### 3. 结算界面（ResultScene）
VICTORY / DEFEAT / DRAW + 最多3枚徽章 + PLAY AGAIN，由 `game_stats` 事件驱动。

### 4. CrazyGames SDK 接入
`CrazyGamesPlatform` 已集成 SDK v3：`init()`、`gameplayStart/Stop()`、midgame 广告。各平台使用独立 HTML 模板（`public/<platform>/index.html`）。

### 5. 设置按钮（退出到大厅）
暂停覆层已实现，含 RESUME + EXIT TO LOBBY 两个按钮，EXIT 触发 `onExitToLobby` 回调。

### 6. 升级基地交互（拖拽）
`HUDView.onUpgradeDragStart` → 拖到基地区域松手触发，与出牌手势一致。

### AI 系统验证
`Hand.cards` getter 已添加，AI 可正常访问手牌。

---

## 🔴 必须做（无此功能无法上架）

### 7. 布局与缩放系统

当前渲染层硬编码设计尺寸，无缩放支持，在非设计分辨率屏幕上布局错乱。

**目标**：
- 双设计空间：竖屏 1080×1920，横屏 1920×1080
- 游戏层 Contain 缩放 + 背景层 Cover 缩放
- 大厅内实时响应方向变化；游戏中锁定方向

**新增文件**：
- `src/layout/ILayout.ts` — 接口（坐标转换 + 布局矩形）
- `src/layout/PortraitLayout.ts`
- `src/layout/LandscapeLayout.ts`
- `src/layout/ScalingManager.ts` — PIXI 两层容器缩放

**改动文件**：`BoardView`、`UnitView`、`BuildingView`、`HandView`、`HUDView`、`GameRenderer`、`GameScene`、`LobbyScene`、`app.ts`

---

## 🟡 强烈建议（影响审核通过率）

### 8. 基础音效

最低需要：出牌、攻击/受击、基地受击、胜/负。可用 freesound.org 免费素材占位。

### 9. 美术资源（最低限度）

单位/建筑/基地图形（当前为圆圈/矩形占位）+ 地图背景（笔记本纸张纹理）。

---

## 🟢 已确认 MVP 外（暂不做）

- 真实联机（帧同步接口已预留）
- 背景音乐
- 粒子特效
- 徽章图标美术（文字版先行）
- 段位/排行榜
- 卡牌收集养成

---

## 实现顺序（剩余）

1. **布局与缩放系统**（当前优先级最高）
2. 音效接入（占位素材）
3. 美术资源

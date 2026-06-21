# Notebook Wars — 音频系统设计

> 状态：设计中 · 权威：本文（音频**系统**的单一入口）· 更新：2026-06-21
>
> **权威边界**：音频**美学方向**（音色取向、禁用清单）仍归 [`../product/art-direction.md`](../product/art-direction.md) §声音；本文拥有**系统实现**——资产清单与命名、触发表、播放层抽象、混音、设置项、平台约束。两者不重述对方。

---

## 1. 美学基线（引自 art-direction，不在此复述）

一句话锚点：**轻巧、卡通、非写实的"文具拟音"**——铅笔沙沙、橡皮擦、翻笔记本页、笔帽咔哒；**禁止**金属碰撞、爆炸轰鸣等写实战争音效。所有音效服从「我蓝敌红 / 手绘笔记本」的整体调性。细节见 art-direction §声音。

---

## 2. 资产清单（最低可上线集 = MVP）

> 对齐 [`../product/mvp-gaps.md`](../product/mvp-gaps.md) §8「基础音效」。占位素材用 **freesound.org（CC0）** 或自录文具声，正式资产后补。

### 2.1 战斗内 SFX（一次性短音）
| 事件 id | 触发 | 拟音建议 | 优先级 |
|---|---|---|---|
| `sfx.card.play` | 出牌/落子 | 笔尖落纸"唰" | P0 |
| `sfx.card.invalid` | 费不够/非法出牌 | 橡皮擦短"吱" | P0 |
| `sfx.unit.attack` | 单位攻击 | 铅笔短戳 | P0 |
| `sfx.unit.hit` | 单位受击 | 软"噗"/揉纸 | P0 |
| `sfx.base.hit` | 基地受击 | 厚本子闷响 | P0 |
| `sfx.spell.cast` | 法术（陨石等） | 翻页+落石涂抹 | P1 |
| `sfx.unit.death` | 单位阵亡 | 纸团揉碎 | P1 |
| `sfx.ink.tick` | 墨滴回涨节点 | 水滴"嘀" | P2 |

### 2.2 UI SFX
| 事件 id | 触发 | 优先级 |
|---|---|---|
| `sfx.ui.tap` | 按钮/格子点击 | P0 |
| `sfx.ui.back` | 返回/关闭 | P1 |
| `sfx.ui.reward` | 领奖/获得物品 | P1 |
| `sfx.ui.gacha.reveal` | 盲盒揭示（按稀有度分层：普通/稀有/史诗+） | P1 |
| `sfx.ui.error` | 失败/余额不足 toast | P2 |

### 2.3 BGM（循环长音）
| 轨 id | 场景 | 备注 |
|---|---|---|
| `bgm.lobby` | 大厅 / 菜单 / 商店 | 轻松、低存在感 | 
| `bgm.battle` | 对战 / 战役关卡内 | 节奏稍快、不喧宾夺主 |
| `bgm.intro` | 首启故事（IntroScene） | 叙事氛围，可与 BGM_lobby 共用 |
| `bgm.victory` / `bgm.defeat` | 结算短乐句（stinger，非循环） | 接 ResultScene |

> 胜负 stinger 走 SFX 管线（一次性），不占 BGM 槽。

---

## 3. 播放层抽象（`IPlatform.audio`）

> 与现有平台抽象一致（`IPlatform.storage` / `connectSocket` 等）。音频能力封进 `IPlatform`，Web / 微信各自实现，游戏逻辑不直接碰平台 API。

```
interface IAudio {
  preload(ids: string[]): Promise<void>;
  playSfx(id: string, opts?: { volume?: number }): void;   // 一次性，可并发
  playBgm(id: string, opts?: { fadeMs?: number }): void;    // 单实例，切轨淡入淡出
  stopBgm(opts?: { fadeMs?: number }): void;
  setMix(mix: AudioMix): void;                              // 主/BGM/SFX 音量 + 静音
  unlock(): void;                                           // 用户手势后解锁（见 §5）
}
```

- **Web / CrazyGames**：`WebAudio`（`AudioContext` + 解码缓冲，低延迟、可并发、好做混音/淡入），SFX 用 buffer source、BGM 用 gain 节点淡入淡出。降级回退 `HTMLAudioElement`。
- **微信小游戏**：`wx.createInnerAudioContext()`；SFX 实例**对象池**复用（小游戏同时音频实例数受限，见 §5）。BGM 单实例 `loop=true`。
- 资产路径走平台资源约定（Web 打包 / 微信分包按需加载，大 BGM 文件考虑分包以压首包）。

---

## 4. 混音与设置

- **三档音量**：`master` / `bgm` / `sfx`（0–1）+ 各自 `muted`。实际增益 = `master × 通道`。
- **持久化**：存进 `SaveData.flags`/设置段（与 `nw_locale` 同级的本地设置），`SettingsScene` 提供滑杆/开关。**不上云权威**（纯本地体验设置，无防作弊价值）。
- **默认**：首次进入 BGM 默认**开**但音量适中（如 0.5），SFX 0.8。可在设置一键静音。
- **Ducking（可选 P2）**：盲盒揭示 / 结算 stinger 播放时，BGM 短暂压低再恢复。
- **失焦自动暂停**：页面/小游戏切后台（`visibilitychange` / `wx.onHide`）暂停 BGM，回前台恢复。

---

## 5. 平台约束（必须处理，否则"没声音"）

| 约束 | 平台 | 处理 |
|---|---|---|
| **autoplay 限制**：首次音频必须在用户手势后才能响 | Web（所有现代浏览器）/ iOS Safari | 首个 tap（IntroScene/LoginScene 任意首次交互）调 `audio.unlock()` 解锁 `AudioContext`；解锁前的 BGM 请求排队，解锁后补播 |
| **iOS WebAudio 需手势解锁** | iOS 网页 | 同上，`AudioContext.resume()` 必须在手势回调内 |
| **同时音频实例数有限** | 微信小游戏 | SFX 走对象池（如 8 个 InnerAudioContext 轮转）；超量丢弃最旧 |
| **首包体积** | 微信小游戏 | BGM 放分包/CDN 按需拉，首包只带 P0 SFX |
| **解码开销** | 全平台 | 进场景前 `preload` 该场景所需 id；SFX 解码缓冲常驻，BGM 流式 |

---

## 6. 实现挂钩与缺口

| 项 | 现状 |
|---|---|
| 平台音频抽象 `IPlatform.audio` | ❌ 待建（仿 storage/socket 接缝） |
| 资产文件 + 命名约定 | ❌ 待定目录（建议 `client/assets/audio/{sfx,bgm}/`） |
| 触发埋点：游戏事件 → `playSfx` | ❌ 待接（引擎事件/场景回调处调用，**不在纯引擎层**——音频是表现层，保持 `game/` 无副作用） |
| 设置页音量项 | 🟡 `SettingsScene` 已有，加滑杆/开关 |
| 首启解锁手势 | 🟡 IntroScene 首 tap 已有，挂 `unlock()` |
| 盲盒/结算 stinger | 🟡 GachaScene/ResultScene 已有揭示/结算时机，挂音 |

> **架构红线**：音频是**表现层**，触发点放在 render/scene 层订阅引擎事件，**不污染 `client/src/game`（纯 TS 确定性引擎）**——与 PIXI 渲染同级处理，保证引擎/回放/裁判确定性不受音频影响。

---

## 7. 待办（开发顺序）

1. `IPlatform.audio` 抽象 + Web(WebAudio) 实现 + 首手势解锁。
2. P0 SFX 占位素材（CC0）接入：出牌/受击/基地/UI tap + 胜负 stinger。
3. `bgm.lobby` + `bgm.battle` 两轨 + 切场景淡入淡出 + 失焦暂停。
4. `SettingsScene` 三档音量 + 静音持久化。
5. 微信 `InnerAudioContext` 实现 + 对象池 + 分包。
6. P1/P2 补全（法术/阵亡/ducking/盲盒分层揭示）。
7. 正式音频资产替换占位。

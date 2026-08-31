# Notebook Wars — 音频系统设计

> 状态：**SFX 播放管线已落地，触发点未接、资产为零 → 游戏目前仍是静音的**（2026-08-31）· 权威：本文（音频**系统**的单一入口）· 更新：2026-08-31
>
> **权威边界**：音频**美学方向**（音色取向、禁用清单）仍归 [`../product/art-direction.md`](../product/art-direction.md) §声音；本文拥有**系统实现**——资产清单与命名、触发表、播放层抽象、混音、设置项、平台约束。两者不重述对方。

---

## 0. 落地状态（2026-08-31）

§7 待办的第 1 步全部、第 2 步的代码半边已完成：**平台接缝 + cue 目录 + 程序化合成音 + 样本加载/解码/并发上限/混音器**。

**已存在的模块**（`client/src/audio/`，平台中立，无 PIXI 依赖）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `AudioCue` 词汇表（17 个）+ `AudioBus` 接口 |
| `cueCatalogue.ts` | 每个 cue 的 gain / priority（混音的单一来源） |
| `cueAssets.ts` | cue → 已发货文件 URL。**全仓库唯一持有音频 `import` 的文件**，目前为空 |
| `audioSynth.ts` | 每个 cue 一把程序化合成音（文具拟音，见 §1）+ `tone`/`noise` 两个原语 |
| `decodeAudio.ts` | 归一 `decodeAudioData` 的 promise / callback 两种形状 |
| `SampleBank.ts` | 走 `assets/assetIO.ts` 拉字节 + 解码，逐文件尽力而为 |
| `VoiceBudget.ts` | 并发上限，按优先级抢占（对 §5 的一处改判，见那一节） |
| `CueMixer.ts` | 两级阶梯：有样本用样本，没有用合成音；合并增益、variant 不重复、±3% 音高抖动 |
| `audioBus.ts` | 模块级接缝（`setAudioBus`/`audioBus`/`playSfx`）+ `NullAudioBus` |

**后端**：`client/src/platform/web/WebAudioBus.ts`（`AudioContext` + SFX 总线 GainNode）。装在 `entries/{web,crazygames,mobile,web-e2e}.ts`；**微信保持 `NullAudioBus`（静音）**，理由见 §3。

**还没有的东西——这条最重要**：`client/src/render/GameRenderer/events.ts` 和任何场景**都还没有调用 `playSfx`**，所以整个游戏目前一声不响。管线是可测、可构建、已装好的，但§7 的第 3/4 步（战斗触发点、UI 触发点）才是让它出声的那一步。

**验证过的**：
- `test/audio/**` **79 个用例**，`src/audio/**` 行覆盖 **99.4%**；该目录已加进 `vitest.config.ts` 的覆盖率门禁（客户端整体 94.8% → **95.77%**，scope 变大而百分比上升）。
- `tsc --noEmit`（`tsconfig.test.json`）、`eslint src`、500 行门禁、`web` + `wechat` 两个 production 构建全通。
- **微信主包为此多付 0 字节**：`entries/wechat.ts` 不 import `WebAudioBus`，整条管线被 tree-shake 掉——实测 `grep 'sfx.card.play' wechatgame/pixigame.js` 命中 0 次，而 web bundle 命中 1 次。
- **真浏览器实测，不是推断**（Chrome，`entries/web-e2e.ts` 的 `window.__nwAudio` + 在 SFX 总线上挂一个 `AnalyserNode` 读 PCM 峰值）：`AudioContext` 在第一次真实点击后 `running`（48 kHz），总线增益 0.8（§4 的 SFX 默认值），**17 个 cue 全部出声**，`loaded()` 诚实地报 `{cues:0, variants:0}`。游戏本身跑着时**连续 2 秒静默量到 0.000**——既确认总线没有本底噪声/直流偏移，也确认目前确实没有任何代码在触发 cue。交付峰值：

  | cue | 峰值 | | cue | 峰值 |
  |---|---|---|---|---|
  | `sfx.base.hit` | 0.151 | | `sfx.ui.gacha.reveal.epic` | 0.101 |
  | `sfx.card.play` | 0.146 | | `sfx.unit.death` | 0.099 |
  | `sfx.result.victory` | 0.132 | | `sfx.unit.hit` | 0.098 |
  | `sfx.spell.cast` | 0.129 | | `sfx.ui.tap` | 0.090 |
  | `sfx.result.defeat` | 0.117 | | `sfx.ui.reward` | 0.089 |
  | `sfx.card.invalid` | 0.105 | | `sfx.ui.error` | 0.078 |
  | | | | `sfx.unit.attack` | 0.058 |
  | | | | `sfx.ink.tick` | 0.028 |

  UI 那一族（0.067–0.101）整体坐在响的战斗音之下、`sfx.ink.tick` 是全表最轻——正是 §4 要的"安静的底、有冲击力的战斗"。

- **⚠️ 实测抓出一条用例看不见的规律：授权峰值 ≠ 交付峰值。** `tone`/`noise` 的 `gain` 是**滤波器之前**的振幅，而白噪声过一道低通之后损失的能量取决于截止频率。`sfx.unit.hit` 最初写成 `gain 0.15 / cutoff 1400`，授权峰值排第二，**交付到总线只有 0.063**，与本该全表最轻的 `sfx.unit.attack`（0.065，只过 900 Hz 高通 + 4500 低通，损失小得多）齐平，正好和 catalogue 里"受击(0.9/60) 明显高于攻击(0.7/20)"的意图相反。改成 `gain 0.17 / cutoff 2400` 后交付 0.098 vs 0.058，意图恢复。**单元测试量的是节点图上的 gain，永远看不到这一层**；只有真 `AudioContext` + AnalyserNode 量得出来。以后新增/调整任何以噪声为主体的 cue，都要按这条重新实测一次，不能只看 `gain` 排序。

- **没有人听过任何一个合成音。** 上面那张表能排除缺陷、能证明混音的相对关系符合意图，**不能判断一个声音是否好听**——那个签收要等触发点接上之后由人来做。

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
| `sfx.ui.gacha.reveal.common` / `.rare` / `.epic` | 盲盒揭示，按稀有度分层。实现成**三个独立 cue** 而不是一个 cue 的三个 variant：variant 是抗重复疲劳的随机取样，语义分层必须可寻址，否则调用方无法表达"这一抽是史诗" | P1 |
| `sfx.ui.error` | 失败/余额不足 toast | P2 |

### 2.3 BGM（循环长音）
| 轨 id | 场景 | 备注 |
|---|---|---|
| `bgm.lobby` | 大厅 / 菜单 / 商店 | 轻松、低存在感 | 
| `bgm.battle` | 对战 / 战役关卡内 | 节奏稍快、不喧宾夺主 |
| `bgm.intro` | 首启故事（IntroScene） | 叙事氛围，可与 BGM_lobby 共用 |
| `bgm.victory` / `bgm.defeat` | 结算短乐句（stinger，非循环） | 接 ResultScene |

> 胜负 stinger 走 SFX 管线（一次性），不占 BGM 槽 —— 已实现为 `sfx.result.victory` / `sfx.result.defeat`，是 catalogue 里优先级最高（120）的两个 cue，谁都不许抢。

---

## 3. 播放层抽象（`audio/audioBus.ts`）

> **订正（2026-08-31）：不挂在 `IPlatform` 上。** 本节原先写的是 `IPlatform.audio`，实现时改判了，理由：
>
> - `IPlatform` 已经承载 20 余个成员（画布/屏幕/安全区/存储/网络类型/语言/输入/SDK 生命周期/广告/鉴权/socket/IAP/分享）。音频跟它们一个都不耦合：不需要 canvas，不需要 layout，不参与鉴权。塞进去只是让那个接口再长一截，并强迫**四个**平台实现各自给出一个音频成员，而其中三个只想要同一个 web 实现。
> - 本仓库已经有一个正好合用的先例：**`assets/assetIO.ts`**——同样是"平台可替换、但与 `IPlatform` 其余部分无关"的能力，做法就是模块级单例 + 入口 `setAssetIO(...)` 安装一次。音频照抄这个形状，两处接缝于是共享同一个心智模型。
>
> 落地形态：`audio/audioBus.ts` 导出 `setAudioBus(bus)` / `audioBus()` / `playSfx(cue, count?)`，默认值是 `NullAudioBus`。**未安装就是安全状态**，也是测试里的常态——场景测试、UI 冒烟、headless E2E 都不需要打桩音频。

```ts
// client/src/audio/types.ts（已实现）
interface AudioBus {
  preload(): Promise<void>;                 // 拉取+解码已发货样本；启动不 await
  play(cue: AudioCue, count?: number): void; // 一次性；count = 本帧合并的事件数，抬增益不重播
  setSfxVolume(v: number): void;             // 0..1
  setMusicVolume(v: number): void;           // BGM 尚未实现，接受并忽略
  resume(): void;                            // 越过 autoplay 闸门（见 §5）
}
```

与本节原稿的另外三处差异，都是实现时发现原稿的形状不对：

- **`preload(ids)` → `preload()`。** 原稿设想"进场景前预载该场景所需 id"。SFX 全集是 ~100 KB 量级（daydayup 的同类集合实测 101.9 KB / 50 个文件），按场景切分省不下有意义的字节，却要求每个场景维护一份 id 清单——那是一份会腐烂的重复。BGM 是另一回事（单文件就可能几 MB），它落地时会有自己的按需接口。
- **`playSfx(id, {volume})` → `play(cue, count)`。** 单次播放不接受调用方传音量：混音权重是内容决策，住在 `cueCatalogue.ts` 一张表里（§4），否则"为什么攻击音把结算盖住了"要翻十个触发点。`count` 是本帧合并进来的事件数（§4 的合并规则）。
- **`unlock()` → `resume()`，且不需要调用方接。** `WebAudioBus` 自己在 `window` 上挂 `pointerdown`/`keydown`/`touchstart`。比走 `InputManager` 严格更宽：后者会在场景淡入淡出和模态框期间闸掉指针事件，而 autoplay 闸门只要"用户碰过页面"，被游戏逻辑丢弃的那次点击同样能解锁。§6 里"IntroScene 首 tap 挂 unlock()"这条因此不需要了。

- **Web / CrazyGames / Capacitor iOS 壳**：`platform/web/WebAudioBus.ts`（`AudioContext` + 解码缓冲，低延迟、可并发、好做混音/淡入），SFX 走 buffer source。**没有 `HTMLAudioElement` 降级**：没有 `AudioContext` 的环境（SSR、node 测试、极老 WebView）直接静音，因为那条降级路径无法承载合成音，等于要维护第二套永远测不到的播放实现。
- **微信小游戏**：**尚未实现，当前是 `NullAudioBus`（静音）。** `client/src/wx.d.ts` 只声明了 `wx.createInnerAudioContext`——那是一个按 URL 播放的播放器，**没有振荡器、没有 GainNode**，所以合成音、`AudioBuffer` 样本、总线增益这三样在那个运行时上一行都跑不起来。微信侧要的是本节原稿说的 `InnerAudioContext` 对象池（SFX 实例池复用，BGM 单实例 `loop=true`），是形状不同的一套后端，属于独立一步（§7 第 5 步）。在它落地之前微信静音，而不是装一个吞掉所有 cue 的假设备。
  > 备选：若目标基础库确认提供 `wx.createWebAudioContext()`（WebAudio 形状），现有整条管线可以原样复用，只换上下文来源——但本仓库没有设备可验证，所以没有先把这个 API 声明写进 `wx.d.ts`。
- 资产路径**不用平台资源约定之外的任何东西**：见 §5 的首包体积那一行的订正。

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
| **同时音频实例数有限** | 微信小游戏 | SFX 走对象池（如 8 个 InnerAudioContext 轮转）。**订正：丢弃规则不是"最旧"而是"按优先级抢占"**——最旧那个很可能正是一局一次的结算 stinger，而新来的是第 40 个攻击音；丢最旧会砍掉唯一那次胜利音，换来一个听不出区别的攻击音。已实现于 `audio/VoiceBudget.ts`（同优先级判输，被抢占者 12ms 淡出而非硬切；按**时间**退休而不靠 `ended` 事件，因为一个"悄悄停止清扫"的上限会失效于静默——前 N 个 cue 之后混音直接变哑，看起来就是"音频坏了"） |
| ~~**首包体积**~~ | ~~微信小游戏~~ | **订正（2026-08-31）：这条约束对本项目不存在。** 原稿写"BGM 放分包/CDN 按需拉，首包只带 P0 SFX"，那是通用建议；而本项目按 ASSET_PACKAGING §4 的**方案 A** 早已把**全部**美术资源托管在 CDN（`asset/resource` 的 `publicPath = NW_ASSET_CDN`，产物进 `wechatgame/cdn/`，由 `project.private.config.json` 的 `packOptions.ignore` 排除出主包），主包是**纯代码 ~1.5 MB**。音频文件走同一条规则、同一个 `assetIO`，天然落在 CDN 上，**一个字节都不进主包**——所以"首包只带 P0 SFX"这个取舍不需要做，BGM 也不需要为体积单独分包。真正要留意的是**下载量与缓存**（同 §16 的资源预算口径），不是包体红线。<br>实测（2026-08-31）：微信主包为音频管线多付 **0 字节**，因为 `entries/wechat.ts` 不 import `WebAudioBus`，整条管线被 tree-shake 掉（`grep 'sfx.card.play' wechatgame/pixigame.js` 命中 0 次，web bundle 命中 1 次） |
| **解码开销** | 全平台 | **启动时 `preload()` 全量**（`app.ts` 在 L0 闸门之后 fire-and-forget，不 await）。订正原稿的"进场景前 preload 该场景所需 id"：SFX 全集是 ~100 KB 量级，按场景切分省不下有意义的字节，却要每个场景维护一份会腐烂的 id 清单。suspended 的 `AudioContext` 照样能解码，所以这一步既不需要网络闸门也不需要 autoplay 手势。BGM 落地时按轨流式，另说 |

---

## 6. 实现挂钩与缺口

| 项 | 现状 |
|---|---|
| 平台音频抽象 | ✅ `audio/audioBus.ts`（模块级接缝，**不是** `IPlatform` 成员——见 §3 订正）+ `platform/web/WebAudioBus.ts` |
| cue 词汇表 + 混音表 | ✅ `audio/types.ts`（17 个 cue）+ `audio/cueCatalogue.ts`（gain/priority）。往 union 里加 cue，在 catalogue 里给它决策之前**编译不过** |
| 程序化合成音（占位声源 + 永久兜底） | ✅ `audio/audioSynth.ts`，每个 cue 一把，文具拟音方向。**没有人听过** |
| 样本加载 / 解码 / 并发上限 / 混音器 | ✅ `SampleBank` + `decodeAudio` + `VoiceBudget` + `CueMixer`，79 个用例 / 99.4% 行覆盖 |
| 资产文件 + 命名约定 | 🟡 目录与命名已定（`client/src/assets/audio/`，`<cue id 的 '.' 换成 '-'>_NN.mp3`，webpack 的 `asset/resource` 规则已涵盖 `mp3\|wav\|ogg`，无需改配置），`custom.d.ts` 已声明 `*.mp3`。**但一个文件都还没有**：`cueAssets.ts` 是空的，全部 cue 走合成音。素材是独立一步——见 §7 第 6 步为什么现成的 CC0 游戏音效包用不了 |
| 触发埋点：游戏事件 → `playSfx` | ❌ **待接，且这是游戏目前静音的唯一原因。** 单一漏斗已经存在：`render/GameRenderer/core.ts` 的 `for (const event of state.events) this.events.handleEvent(event, state)`，全部战斗 cue 挂在 `render/GameRenderer/events.ts` 的 `EventsPanel.handleEvent` 一处即可（**不在纯引擎层**——音频是表现层，保持 `@nw/engine` 无副作用）。<br>⚠️ **一个已知的坑**：game over 后引擎 `step()` 提前返回、**不排空事件队列**，于是 `game_over`/`game_draw` 每帧被重复消费（`GameRenderer/core.ts` 的 `gameEnded` 一次性门就是为此加的，历史上吃过一次 double-fire bug）。胜负 stinger 天真地挂上去会 60fps 连发 |
| UI 触发埋点 | ❌ 待接。funny **没有统一的按钮基类**：40 个场景各自维护 `hits: Hit[]` 矩形命中表（其中 22 处各自重复声明 `interface Hit`），各自做命中检测。正确做法不是逐场景挂音，而是先抽一个**共享 hit 表 + 派发器**（顺手消掉那 22 份重复），音效只挂在那一处、`fn` 旁边加一个可选 `sound` 字段 |
| 设置页音量项 | 🟡 `SettingsScene` 已有，加滑杆/开关；`AudioBus` 的 `setSfxVolume`/`setMusicVolume` 已就绪（BGM 那个接受并忽略，滑杆可以先接） |
| 首启解锁手势 | ✅ 不需要调用方接：`WebAudioBus` 自己在 `window` 上挂 `pointerdown`/`keydown`/`touchstart`（见 §3） |
| 盲盒/结算 stinger | 🟡 cue 已在词汇表里（`sfx.ui.gacha.reveal.{common,rare,epic}` / `sfx.result.{victory,defeat}`），GachaScene/ResultScene 的时机也已有，待挂 |
| 浏览器冒烟入口 | ✅ `entries/web-e2e.ts` 暴露 `window.__nwAudio`（`play(cue)` / `resume()` / `cues` / `loaded()`）。音频没有别的可观测面——截不了图，而且触发点接上之前游戏里根本没有 cue 会响 |

> **架构红线**：音频是**表现层**，触发点放在 render/scene 层订阅引擎事件，**不污染 `client/src/game`（纯 TS 确定性引擎）**——与 PIXI 渲染同级处理，保证引擎/回放/裁判确定性不受音频影响。

---

## 7. 待办（开发顺序）

1. ~~平台音频抽象 + Web(WebAudio) 实现 + 首手势解锁。~~ ✅ 2026-08-31（形态改判为模块级接缝，见 §3）
2. ~~cue 词汇表 + 混音表 + 程序化合成音 + 样本加载/解码/并发上限/混音器。~~ ✅ 2026-08-31
3. **战斗触发点**：`render/GameRenderer/events.ts` 的 `EventsPanel.handleEvent` 一处挂全部战斗 cue，含同帧合并（`Map<AudioCue, number>` 而不是 `Set`，把计数传给 `play` 的 `count`）。⚠️ 注意 §6 表里那个 game-over 事件队列不排空的坑。
4. **UI 触发点**：先抽共享 hit 表 + 派发器（消掉 22 份重复的 `interface Hit`），再在那一处挂 `sfx.ui.*`；`SettingsScene` 三档音量 + 静音持久化（本地设置，与 `nw_locale` 同级，不上云）。
5. 微信 `InnerAudioContext` 后端 + 对象池（**不需要为体积分包**，见 §5 订正）。
6. **音频素材**。这一步的成本比它看起来高，原因是我们的美学方向：
   - art-direction §声音 明令**禁止**金属碰撞与爆炸轰鸣，而现成的 CC0 游戏音效包（如 Kenney 的 Impact / Sci-Fi / Digital 那几个：激光、金属撞击、玻璃碎、爆炸）**整个落在禁用清单里**。能直接复用的只有 Interface Sounds 那一包里的 UI 音（tap/back/toggle/error 形状），战斗音必须另找纸质 foley（freesound.org 的 CC0 拟音）或自录。
   - 素材到位后**按合成音峰值对齐**再进仓（`tone`/`noise` 两个原语的峰值就是它们的 `gain` 参数，`audioSynth.ts` 里 UI 那几个刻意各自只用一个原语，正是为了让这一步不需要重新渲染测量）。这样换样本不改变混音权重，`cueCatalogue.ts` 那张表不用跟着调。
   - 值得整套移植 daydayup 的 `tools/audio-pipeline/`（audit → 剔除削波/双声道假立体声 → 裁前后静音 → 按各文件自己的 rolloff 搜最小采样率 → 峰值对齐）——那部分与素材来源无关。
   - 接入方式：在 `audio/cueAssets.ts` 加一行 `import` + 一个条目，其余代码一行不用改。一个写错的文件名是**构建失败**而不是静默退回合成音。
7. BGM（`bgm.lobby` / `bgm.battle` / `bgm.intro` 两到三轨）+ 切场景淡入淡出 + 失焦暂停 + 可选 ducking。这半边**没有可参照的先例**，接口形状也与 SFX 不同（单实例 + 淡入淡出 + 流式），需要单独设计。

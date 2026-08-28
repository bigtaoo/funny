# 客户端 UI — 变更记录 2026-08

> 从 [`UI_DESIGN.md`](UI_DESIGN.md) 拆出（2026-08-17）。**小节编号沿用原文**，源码里的 `UI_DESIGN.md §N` 引用仍然有效。
> 当前状态的规格看 [`UI_DESIGN.md`](UI_DESIGN.md) 和 [`UI_DESIGN_SCENES.md`](UI_DESIGN_SCENES.md)。
> 在先记录见 [`UI_DESIGN_LOG_2026-06_07.md`](UI_DESIGN_LOG_2026-06_07.md)。**新增小节请追加到本文末尾。**

---

## 26. 回放 transport 覆盖层收窄 + 半透明 + 结局红光清空（2026-08-01）

**问题（用户截图反馈，横屏）**：`ReplayScene` 的顶部 transport 覆盖层（进度条 + Pause/2×/Share/Exit 四按钮）三个毛病——① 按钮行宽度按 `layout.designWidth`（横屏下含左右留白，可能远大于棋盘）算，超宽屏幕上整排按钮会溢出到棋盘左右边界之外；② 按钮行 y 坐标比棋盘顶边（`boardRect.y`）还低，天然会压住棋盘最上面一整行的单位；③ 若观看视角所在的一方在录像结尾落败，`GameRenderer` 的战损红色暗角特效（`base_hp_changed` 事件在本方基地掉血时把 `vignetteAlpha` 打到 1.0，靠后续帧里 `update()` 每帧衰减淡出）会永久卡在满值——因为 `ReplayScene.update()` 一旦 `ended=true` 就不再调用 `renderer.update()`，衰减动画没有下一帧可跑，回放结束画面就定格在一片红。

**修复**（`client/src/scenes/ReplayScene.ts`）：
1. **收窄到棋盘宽度**：进度条 `barW`/`barX` 与四按钮行的 `gap`/`playW`/`speedW`/`exitW`/`shareW`/居中 `x` 全部改吃 `layout.boardRect.w`/`.x`（此前是 `layout.designWidth`），横屏宽屏下不再溢出棋盘左右边界。
2. **按钮加透明**：`makeButton()` 的面板 `fillAlpha` 从 0.9 降到 0.55——评估过「整行下移到不压棋盘」需要多出约 60px 高度而顶部 HUD 条（`HUD_TOP_H`）已经没有余量，代价比「半透明压一行」更大，因此按用户提示的方向选择半透明：被压住的那一行单位仍隐约可见，不是被死死盖住。
3. **结局红光清空**：`ReplayScene.update()` 里 `ended` 刚置真时，顺带 `renderer.vignetteAlpha = 0; renderer.drawVignette();` 强制清空一次，不再等吃不到的后续帧衰减。

**验证**：`tsc --noEmit`（client）全绿；`vitest --config vitest.ui.config.ts test/ui/gameScenes.ui.ts`（14 用例，含 ReplayScene 播放/结束/视角切换）全通过。真实浏览器验证：Browser 面板截图工具在本次会话里持续报「pane 未显示、无法合成帧」（与 §23 验证记录中同一限制），改用临时 `?replaydemo` 单体入口（`app/matchEngine.createLocalMatch` 跑一局主动方 AFK 输给 AI 的本地对局，直接灌进 `ReplayScene`，验证后已删除，未合入）+ 场景图内省核对：① 在 2400×900（designWidth 放大到 2880）宽屏下量得新 `barX/barW`＝1125/630（右边界 1755）、按钮行跨度 1100–1783，均落在 `boardRect`（810–2070）以内；按旧公式反推同条件下 `barX/barW`＝720/1440（右边界 2160），两侧都会溢出棋盘边界，坐实了修复前的溢出。② 临时注释掉红光清空那两行重跑同一局，`ended=true` 时 `vignetteAlpha` 定格在 0.94（复现卡红 bug）；恢复两行后同一局跑到底 `vignetteAlpha`＝0（确认修复生效）。

## 27. Hero Roster「Skins」页签立绘不跟随已装备皮肤（2026-08-01）

**问题（用户截图反馈）**：Hero Roster → Skins 页签，每张角色卡左侧的大立绘图，无论 tile 行里哪个皮肤被标为「Equipped」，图都不变——一直显示该角色的默认立绘。

**根因**：立绘图从 `UNIT_ART_URLS[unitType]`（`client/src/render/cardArt.ts`）取，这张表只按 `unitType` 建索引，完全没有皮肤维度；`renderSkinCard()`（`client/src/scenes/CardScene/skins.ts:123`）在同一作用域里其实已经算出了 `equipped`（上一行 `getEquippedSkin(unitType)`，且已经传给 `renderSkinTile` 用来判定哪个 tile 显示「Equipped」），只是从未拿它来选立绘图。不是重绘没触发（`equipSkin()` 后紧跟着 `this.render()`，页签确实同步重画），是「画什么」这一步压根没看已装备状态。卡片详情弹层的立绘（`client/src/scenes/CardScene/detail.ts:122`）是同一份代码模式，同样的漏洞。

**修复**：
1. `cardArt.ts` 新增 `SKIN_PORTRAIT_ART`（皮肤 id → 专属立绘，目前 3 个有美术的皮肤 `skin_shop_c1/r1/e1` 复用 Shop 页签早已导入的 `skin_infantry/archer/shieldbearer.png`）+ `unitPortraitUrl(unitType, equippedSkinId)`：已装备皮肤有专属立绘就用它，否则（含 `skin_e1/e2/l1`——Lena/Mara/Max 这三个皮肤目前只有战斗用的 `.tao` 骨骼包，没有静态立绘美术）落回原 `UNIT_ART_URLS[unitType]`。
2. `skins.ts` / `detail.ts` 的立绘取值都改走 `unitPortraitUrl(unitType, equipped)`，不再直接查 `UNIT_ART_URLS`。

**后续扩展（同日，用户确认"全部修复"）**：同一个 `UNIT_ART_URLS[unitType]` 直查模式（无视已装备皮肤）还散落在另外 10 处——凡是展示「玩家自己拥有的卡牌实例」画像的界面，理论上都该跟随该角色当前装备的皮肤（皮肤装备是按 `UnitType` 全局生效的一个槽位，不挂在具体卡实例上，见 `skinDefs.ts`），逐一排查后按"数据是否已在作用域内"分两类处理：

1. **零新增回调**（`save`/`this.cb.getSave?.()` 本来就在作用域里，直接换查法）：`CardScene/list.ts`（Hero Roster 主页签网格）、`CardScene/feed.ts`（合成環 + 候选素材列表，两处）、`CityScene/render.ts`（出征队伍卡槽队长）、`EquipmentScene/assign.ts`（装备穿戴选卡界面）、`DefenseEditorScene/render.ts`（防守编辑器兵营列表 + 网格已放置单位）、`DefenseEditorScene/input.ts`（拖拽幽灵图）、`AuctionScene/list.ts`（拍卖行列表）、`AuctionScene/picker.ts`（拍卖选品器）。
2. **需要新增可选回调**（原本拿不到 `SaveData.equipped`）：`GachaScene.ts`（抽卡揭示 + 赔率表复用同一个 `drawEntryPicture`）新增 `getEquippedSkins?(): Record<string, string>`，`FriendsScene`（`mail.ts` 邮件卡牌附件预览）在 `FriendsSceneCallbacks` 同名新增。两处均为可选字段（`?`），不破坏现有 headless 测试里构造的回调对象；真实实现在 `app/nav/shop.ts`（`goGacha`）/ `app/nav/social.ts`（`goFriends`）里补一行 `() => saveManager.get().equipped`。

`cardArt.ts` 同步收敛：`cardInstanceArtUrl(card, equipped?)` 现在内部就是 `unitPortraitUrl(unitType, equippedSkinIdFor(unitType, equipped))`，新增的 `equippedSkinIdFor(unitType, equipped?)` 做 `SaveData.equipped["skin:"+unitType]` 的查表，是本次新增的两个导出，两个「只有 unitType、没有具体卡实例」的调用点（`DefenseEditorScene` 的已放置单位格 / 拖拽幽灵图）直接调 `unitPortraitUrl` + `equippedSkinIdFor`。

未纳入本次范围：`avatar.ts` 的头像选择器（`hero:<unit>`/`skin:<id>` 两种头像类型）——这是玩家显式选择头像的独立功能，`skin:<id>` 类型本来就允许单独选一张皮肤当头像，跟着"当前装备的皮肤"走反而会跟这个独立选项打架，故意不动。

**验证**：`npm run typecheck` 全绿；扩充 `client/test/cardArt.test.ts`（新增 `equippedSkinIdFor`/`cardInstanceArtUrl` 用例，共 9 个）；扩充 `client/test/ui/gachaResultCard.ui.ts`/`client/test/ui/mailAttachmentIcons.ui.ts`，验证新增的可选回调确实被调用到（headless PIXI 下所有二进制资产桩成同一张 1×1 PNG data URI，没法按最终贴图 URL 区分"选中了哪张图"，所以这两个新测试断言的是"回调有没有被调用"而非图片本身，逻辑正确性由 `cardInstanceArtUrl` 的纯函数单测兜底）；`npm test`（915 用例）+ `npm run test:ui`（854 用例）全通过。真实浏览器验证：Browser 面板截图工具本次同样报「pane 未显示、无法合成帧」（§23/§26/§27 首段同一限制），且本地 `game` 开发服无后端（`/bootstrap` 网络失败），走不到登录后的这些界面，故未能截图肉眼确认；已通过上述单测 + 既有 UI 冒烟覆盖根因逻辑。

## 28. Home City 建筑格子/次要文字对比度修复（2026-08-02）

**问题（用户截图反馈）**：主城界面（[HOME_CITY 截图]）看起来"字、按钮都和背景融合在一起"——建筑格子（Desk/Ink Pot/…）看不出边界，等级/产量等说明文字发虚。

**根因（WCAG 对比度公式核实）**：
1. `CityScene/render.ts` 的资源条面板、Build Queue 面板、建筑格子背板三处 `sketchPanel(...)` 都把 `border` 设成 `C.line`（即 `palette.ruleLine`，专为"仿真笔记本印刷横线"设计的极浅蓝，本意就是要淡到几乎看不见）。当同一色号被挪去当**功能性卡片边框**用，边框对 `C.paper` 卡片底色的对比度只有 ~1.5:1，格子自然没有可辨的轮廓。同款误用还存在于 `AchievementScene`/`DailyScene`/`EventScene`/`StatsScene`/`ResultScene`/`LevelPrepScene`/`FriendsScene worldChat.ts` 等至少 7 个文件（本次未动，见下）。
2. 共享次要文字色 `ui.mid`（0x888888，"Lv.N"/"/200k"/"Heroes N" 这类说明文字在用）对 `C.paper` 卡片底色对比度只有 ~3.6:1，低于 WCAG AA 正文 4.5:1 的门槛——`design/game/UI_DESIGN.md` §14（FamilyScene，2026-07-14）早就在个别场景遇到过同一根因，当时是给 FamilyScene 单独换了本地 `MUTED=0x5a574f` 绕过，没有回头修共享 token。

**修复**：
- `client/src/render/sketchUi.ts`：`ui.mid` 从 `0x888888` 深化到 `0x686868`（对 `ui.paper` 对比度提到 ~5.7:1），这是共享 token，全游戏用到它的次要文字同步变清晰。
- `client/src/scenes/CityScene/render.ts`：资源条面板、Build Queue 面板、建筑格子背板（非排队态）的 `border` 从 `C.line` 改成 `C.mid`，格子边界现在清晰可辨；排队中/激活态边框仍是 `C.gold`，不受影响。
- **范围内未动**：其余 7 个文件同样把 `C.line` 当功能性边框用，本次只修用户报的主城界面；`ruleLine` 本身作为装饰性细横线的原意保留不变，未改该 token 的值。

**验证**：`npm run typecheck` 全绿；新增 `client/test/uiContrast.test.ts`（5 个用例，纯 WCAG 对比度公式，锁定 `ui.mid` 对 `ui.paper`/`palette.paper` 均 ≥4.5:1、当边框用 ≥3:1，并反向断言 `palette.ruleLine` 对比度确实偏低——记录它为何不该被当功能性边框复用）；`npm test`（130 文件/949 用例）+ `test/ui/cityScene.ui.ts`/`cityFillAllTeams.ui.ts`/`cityTrainTroops.ui.ts`（58 用例）全通过。真实浏览器验证：Browser 面板截图工具本次同样报「pane 未显示、无法合成帧」（同 §23/§26/§27 的限制），未能截图肉眼确认；已通过上述对比度单测锁定根因数值。

**收窄（同日，用户看到抽卡揭示图后逐一拍板）**：上面「另外 10 处」一刀切改成跟随已装备皮肤，用户复核后发现抽卡揭示卡显示皮肤图会让人误以为「抽到了皮肤」（实际抽到的只是普通角色卡）——按场景语义逐个重新拍板，而不是全跟或全不跟：

| 场景 | 定稿 | 理由 |
|---|---|---|
| `GachaScene.ts`（抽卡揭示 + 赔率表） | **原始图片** | 这里回答的是「刚抽到了什么」，用户拍板：角色卡抽到就该显示角色卡原图，混入已装备皮肤会让人误判抽奖结果 |
| `AuctionScene/list.ts`（拍卖行列表） | **原始图片** | 同上，回答的是「这一条拍卖是什么物品」，不该受本账号的装备状态影响 |
| `AuctionScene/picker.ts`（拍卖选品器） | **原始图片** | 同上 |
| `CardScene/list.ts`（Hero Roster 主页签网格） | **原始图片** | 用户拍板 |
| `CardScene/feed.ts`（合成环 + 候选素材列表） | **原始图片** | 用户拍板 |
| `EquipmentScene/assign.ts`（装备穿戴选卡界面） | **原始图片** | 用户拍板 |
| `FriendsScene/mail.ts`（邮件卡牌附件预览） | **原始图片** | 用户拍板 |
| `CityScene/render.ts`（出征队伍卡槽队长） | 跟随已装备皮肤（不变） | 用户拍板保留——这里展示的是「我的队伍长什么样」，理应反映当前装备 |
| `DefenseEditorScene/render.ts` + `input.ts`（兵营列表/网格已放置单位/拖拽幽灵图） | 跟随已装备皮肤（不变） | 同上，防守布局展示的是玩家自己的部队外观 |
| `CardScene/skins.ts` + `detail.ts`（Skins 页签 + 卡片详情） | 跟随已装备皮肤（不变） | §27 最初的修复目标，本来就该显示装备效果 |

**改动**：`GachaScene.ts`/`AuctionScene/list.ts`/`AuctionScene/picker.ts`/`CardScene/list.ts`/`CardScene/feed.ts`（两处）/`EquipmentScene/assign.ts`/`FriendsScene/mail.ts` 的 `cardInstanceArtUrl(...)` 调用去掉 `equipped` 实参，回落到 `unitPortraitUrl` 内部 `equippedSkinId` 为空的默认分支（即 `UNIT_ART_URLS[unitType]`）。`GachaScene.ts`/`FriendsScene` 新增的可选回调 `getEquippedSkins?()` 因此不再有调用点，整体删除（含 `GachaSceneCallbacks`/`FriendsSceneCallbacks` 的字段声明 + `app/nav/shop.ts`/`app/nav/social.ts` 的实现行）；对应两个「回调被调用」的 UI 回归测试一并删除。`CityScene`/`DefenseEditorScene`/`CardScene/skins.ts`/`detail.ts` 未改动，仍走 §27 原逻辑。

**验证**：`npx tsc --noEmit`（client）全绿；`npm test`（923 用例）+ `npm run test:ui`（860 用例）全通过。

## 29. ResultScene 竖屏次要徽章行压字修复（2026-08-09）

**问题（用户截图反馈，竖屏）**：结算页竖屏下"VICTORY"标题下方信息全挤在一起——次要徽章（`[Best Damage]`/`[Efficient]` 两枚小圆形图标）的图标直接压在了主徽章详情句「Base only took 0 damage」的文字尾部上。横屏下完全正常。

**根因**：`ResultScene.ts` 次要徽章行的纵向定位公式是 `heroDetail.y + heroDetail.height - h * 0.041`——一个针对横屏微调的"回吸"值：横屏 `LandscapeLayout` 的 `designHeight`（即这里的 `h`）固定 1080，回吸量约 44px，贴着上一行文字，视觉正常。但竖屏 `PortraitLayout`（[PortraitLayout.ts](../../client/src/layout/PortraitLayout.ts)）的设计坐标系是**轴互换**的：`designWidth` 固定 1080，`designHeight`（这里的 `h`）反而是长边，通常 ≥1920。同一个 `h*0.041` 公式在竖屏下回吸量涨到 ≥79px，直接把徽章图标拽进了上一行文字所在的位置，造成截图里的挤压——这不是"元素太多"，是同一个公式被两种轴互换的设计坐标系共用，横屏调好的回吸量在竖屏被放大了近一倍。

**修复**（[ResultScene.ts:401](../../client/src/scenes/ResultScene.ts:401)）：加 `isPortrait = h > w` 分支，竖屏改成正向下移一点间距（`+ h * 0.02`），横屏原公式不动：

```ts
const rowY  = isPortrait
  ? heroDetail.y + heroDetail.height + h * 0.02
  : heroDetail.y + heroDetail.height - h * 0.041;  // 横屏原公式，未改动
```

**验证**：`npm run typecheck` 全绿；新增 `client/test/ui/resultScenePortraitBadgeRow.ui.ts`（用真实 `PortraitLayout`/`LandscapeLayout` 设计尺寸 1080×1920 / 1920×1080 构造场景，校准 stats 让 `computeBadges()` 稳定产出「主徽章+2 次要徽章」布局）：竖屏用例断言每个次要徽章顶部 y ≥ 主徽章详情文字底部 y（不重叠）；横屏用例断言 `rowY` 精确等于原公式（锁死横屏不受影响）。临时把公式改回旧版重跑，竖屏用例确实报错（徽章顶部 534.84 < 应为 ≥613.56 的文字底部，即截图里的挤压量），横屏用例仍通过——证明测试不是空断言，改回修复后复查全绿。`ResultScene` 既有 UI 冒烟测试（back-chip/outro tap-through 等）8/8 通过。真实浏览器验证：Browser 面板截图工具本次同样报「pane 未显示、无法合成帧」（同 §23/§26/§27/§28 的限制），且尝试用 `entries/web-e2e.ts` 的 `window.__nwE2E.views.showResult(...)` 直接灌数据绕过登录/对局后，WebGL canvas 的 `toDataURL()` 读出的是全黑帧（`preserveDrawingBuffer` 默认 false + 该会话里 Chromium 标签页始终处于"隐藏"状态导致合成帧被提前清空/rAF 被节流），未能截图肉眼确认；已通过上述单测锁定根因数值 + 手工按两种屏幕真实设计尺寸复核公式两侧的具体像素量。

## 30. BattlePassScene 竖屏 XP 进度条左右文字重叠修复（2026-08-10）

**问题（用户截图反馈，竖屏）**：战令界面顶部蓝色进度条里，左侧等级徽章「Lv.17」和右侧状态文字「9600 XP · 600 XP to next level」叠在了一起，糊成一团数字（截图里能看出「9600」和「17」的笔画互相压着）。

**根因**：`BattlePassScene.ts` 的 `levelLbl`（左，锚点 0）和 `xpLbl`（右，锚点 1）都用固定的 `barW` 百分比定位（`pad + barW*0.03` / `pad + barW - barW*0.03`），字号却都是按 `barH`（进度条高度）的比例算的（`barH*0.55` / `barH*0.42`）。`barH = h*0.07`——`h` 是设计高度，竖屏下（[PortraitLayout.ts](../../client/src/layout/PortraitLayout.ts)）设计宽度固定 1080 不变，但设计高度随屏幕高宽比走、可以远超 1920，越窄长的手机 `barH`（从而两个字号）越大，而横向可用的 `barW` 并不会同步变宽——`xpStatus` 那句「{xp} XP · {n} XP to next level」本来就比「Lv.{n}」长得多，字号一放大，右边这句从右锚点往左量出的文字框直接越过了左边徽章的右边缘，两段文字画到了同一片像素上。这跟同一天 `DailyScene.ts` Daily Tasks 页签 Claim 按钮的压字修复（[client/test/ui/dailySceneTasksClaimButtonWidth.ui.ts](../../client/test/ui/dailySceneTasksClaimButtonWidth.ui.ts) 的文件头注释有记录，尚待补进本文档）是同一类根因（高度驱动字号 vs 固定宽度容器），换了个场景又踩了一遍。

**修复**（[BattlePassScene.ts:342](../../client/src/scenes/BattlePassScene.ts:342)）：`xpLbl` 定位后，量一下它左侧实际剩余的空间（`xpLbl.x - (levelLbl.x + levelLbl.width) - 2%barW` 的留白），文字实际宽度超过这个空间就整体缩小 `xpLbl`（`.scale.set`，下限 0.55 防止极端场景缩成看不清），跟这份代码里其它「文字量出来比容器还宽就 `.scale.set` 缩」的写法保持一致（`CardCodexScene`/`AuctionScene`/`TitlesScene`/`LobbyScene` 等一大批场景都是这个套路）。只缩右边的状态文字，左边的等级徽章保持原尺寸不受影响。

**验证**：`npm run typecheck` 全绿（仅本文件的改动范围）。真实浏览器验证：Browser 面板截图工具同样报「pane 未显示、无法合成帧」（同 §23/§26/§27/§28/§29 的限制），改用真实浏览器 + 真实 Canvas2D 字体度量的替代验证——临时在 `entries/web.ts` 加了一个 `?bpdebug` 调试分支（跟 §27 当天已经清理掉的 `?dailydebug` 同一手法，不经登录直接起 `BattlePassScene` 灌 `{xp:9600, level:17}` 复现截图数值），把两段文字的真实渲染坐标 `console.log` 出来核对：**修复前**，`xpLbl` 左边缘落在 x=7（比 `levelLbl` 自己的左边缘 x=83 还靠左），`levelLbl` 右边缘 x=248，两者严重重叠——数值上完全对应截图看到的糊字；**修复后**，`xpLbl` 左边缘退到 x=267，`levelLbl` 右边缘仍是 248，中间留出 19px 干净间隔，不再重叠。核对完当场删除了 `?bpdebug` 分支，未进最终提交（`git diff` 确认 `entries/web.ts` 无残留改动，只有 `BattlePassScene.ts` 一处 diff）。headless `test:ui` 未新增回归——该层的 `measureText` 桩固定按字符数算宽度、不随字号缩放（[client-testing.md](../../claudedocs/client-testing.md) §"UI 冒烟层"有记录这个已知局限），无法在不造假数据的情况下重现"字号变大导致的重叠"这个根因，所以选择了上面的真实浏览器路径而非补一条形同摆设的 headless 断言。

**补测**（同日）：上面「改动」只删了旧的「回调被调用」测试，没有为新的「原始图片」7 处调用点补回归覆盖——为防止日后有人无意中把 `equipped` 参数传回去、悄悄复发本节最初要修的误读问题，逐场景新增用例：`GachaScene.ts`（`gachaResultCard.ui.ts`）、`AuctionScene/list.ts` + `picker.ts`（`auctionScene.ui.ts`）、`CardScene/list.ts`（`cardSceneLevelStars.ui.ts`）、`CardScene/feed.ts` 两处调用点（`cardFusePanel.ui.ts`）、`EquipmentScene/assign.ts`（`equipmentAssignGrid.ui.ts`）、`FriendsScene/mail.ts`（`mailAttachmentIcons.ui.ts`）。手法：`vi.mock('.../cardArt', importOriginal)` 只把 `cardInstanceArtUrl` 包一层 `vi.fn`（保留真实实现），断言调用参数长度 ≤1（即未传 `equipped`）——而非比对渲染出的贴图，因为 headless PIXI 下所有二进制资产桩成同一张 1×1 PNG data URI，贴图身份判别不出「画的是哪张图」。

## 31. ShopScene 商品卡标题换行把价格顶到 Buy 按钮上（2026-08-11）

**问题**：竖屏 2 列商品网格（`gridMetrics()` 800×1280 下 `cols=2`，比 §"横屏商品卡由 4 列改 3 列"（2026-07-17）修的横屏 4 列更窄）下，`starter_draw` 卡片标题「Starter First-Draw Pack」在 `drawCard()` 默认标题字号下换成 3 行，价格行（当时是「¥6」，同日晚些时候的 CNY→USD 改价后是「$0.99」）被顶到了下方 Buy 按钮上，字压字。真实 Playwright 截图确认。

**根因**：`drawCard()`（[card.ts](../../client/src/scenes/ShopScene/card.ts:21)（当时叫 `base.ts:559`，ShopScene 改组合式后 `drawCard()` 迁至此））里价格行（`coinAmount`/`usdCents` 两个分支）的起始 `ty` 只取决于标题实际换行后的高度，**没有像紧接其后的状态/加成行（`lines`）那样做 `bandBottom` 钳制**（那段有 `if (lines.length > 0 && ty < bandBottom)` + 逐行 `ty + l.height > bandBottom` 检查）。§"横屏商品卡由 4 列改 3 列"当时是靠"横屏也统一改宽到 3 列，标题基本不再换行"侧面绕开了这个缺口，没有真正给价格行补上跟状态行一致的钳制——列更窄、标题更长时（本例的竖屏 2 列 + 起始包名）缺口就重新暴露。

**修复**：`drawCard()` 双管齐下——① 标题在绘制前先量好后面价格行的真实高度（`coinAmount`/`usdCents` 的图形/文字对象先建出来但先不定位），如果"标题高度 + 价格行高度"会超出 `bandBottom` 就一步步调小标题字号重新换行（下限 `ch*0.05`），跟"有状态行时缩小图标 `imgSize`"是同一套"预留空间不够就主动让步"的思路；② 价格行自己的起始 y 额外做 `Math.min(ty, bandBottom - 行高)` 钳制，即使标题缩到下限仍不够，价格也不会被推过 `bandBottom`——跟状态行的钳制补齐成同一套保障，价格再也不会被推到按钮上。

**验证**：`npx tsc --noEmit`（client）全绿；`client/test/ui/shopScene.ui.ts` 原有 43 例全绿（几何在正常情况下与改前逐像素一致，因为不缩不夹时 `Math.min` 取的就是原值）+ 新增 2 例（`ShopScene.drawCard — a long title never pushes the price row onto the Buy button`）：直接调用 `drawCard()`（不经真实网格，因为 headless 文本测量桩[client/test/harness/pixiHeadless.ts]按字符数算宽度、不随字号缩放，短标题在真实网格宽度下量不出换行）灌一个刻意很长的标题 + 窄 `cw/ch`，断言价格/金币行底边 ≤ Buy 按钮顶边——临时改回旧代码复跑，两个新例都如预期报错（价格压到按钮上），改回修复后复绿，确认测试不是空断言。真实浏览器验证：`npm run start:e2e`（端口 9096）+ `window.__nwE2E.views.showShop(...)` 直接灌数据，Playwright 截图对比：改前标题真换成 3 行、价格压在「Buy」上；改后标题回落 2 行、价格清楚留在按钮上方，与截图描述完全对应。

**补测**（同日）：原先 2 例只覆盖了 `coinAmount` 和无删除线的 `usdCents` 分支，`usdStrikeCents`（划线原价，如年卡的"原价 $3.60 划线 现价 $2.98"）走的是另一段布局代码（划线价横排在现价左边而非叠在下面），同一个 `py` 钳制理论上两边都用了，但没有专门测过——补一例 `usdStrikeCents` 场景，断言现价和划线价底边都 ≤ Buy 顶边；临时改回旧代码复跑确认这例也如预期报错。另补一例"标题一行就放得下"的常规场景，断言价格行 y 精确等于"标题底边 + `rowGap`"（即钳制在有富余空间时是纯粹的 no-op，不会误伤正常卡片的原有布局）——这条锁定的是修复"不该动的地方一个像素都不该动"，防止日后有人改坏 `Math.min` 的判断条件而在正常场景里悄悄挪位置却没人发现。

## 32. 竖屏顶部标题栏返回按钮/标题字号跟随栏高缩放（2026-08-11）

**问题（用户截图反馈，"卡背包"页竖屏）**：顶部标题栏（返回按钮、标题、右上角金币）看着偏小，用户当时判断是"栏高度不够"。

**根因（跟直觉相反——栏其实不矮，是内容没跟着栏高长）**：`sceneHeaderHeight(h) = h*0.12`（[SceneHeader.ts:74](../../client/src/ui/widgets/SceneHeader.ts:74)）里的 `h` 是 `PortraitLayout` 动态拉伸过的设计高度——为了不在修长竖屏（notch 机型）上留黑边，`designHeight` 会随屏幕宽高比一路涨到远超参考值 1920。实测 375×812 手机：`headerH` 换算回真实屏幕约 **98px**（占屏幕高度稳定 12%，一点不小）。但返回按钮/标题字号一直用固定语义 token `FS.headline`（42 设计 px），这个 token 是按设备**短边**（竖屏下=屏幕宽度）换算的，完全不随 `headerH` 变化——同一台设备换算下来只有 **≈15px**，横屏（栏仅 ≈45px 高）也是这同一个 15px。栏越高，字号原地不动，视觉上就是四周空出一圈，显得"内容小"。右上角金币簇更极端：`CardScene`/`EquipmentScene` 当初（[topbar-sizing-unified-2026-07-12](../../claudedocs/client-modules.md)）特意把它钉死成"headerH=100 等效"大小，本次未动，留作后续单独评估。

**修复**（[SceneHeader.ts:86-101](../../client/src/ui/widgets/SceneHeader.ts:86)）：`backSize(headerH)` 从"返回固定 `FS.headline`"改成 `Math.max(FS.headline, Math.round(headerH * 0.30))`——比例系数按"横屏默认栏高（design ≈130）算出来低于 42 这个下限"反推，保证横屏/紧凑栏完全不变，只有比这更高的栏才会真正放大。标题默认字号（[SceneHeader.ts:264](../../client/src/ui/widgets/SceneHeader.ts:264)）复用同一个 `size`，跟返回按钮保持一致（原来两者本就是同一个 `FS.headline`）。`drawFloatingBackButton`（全出血场景如 WorldMapScene 的独立返回按钮）没有真实栏，改用 `backSize(sceneHeaderHeight(h))` 算一个"假想栏高"，保证跟同屏幕高度下 `drawSceneHeader` 的返回按钮大小一致。

**效果（Node 脚本按真实缩放公式算的换算值）**：

| 场景 | headerH 真实 px | 返回/标题字号 修复前 | 修复后 |
|---|---|---|---|
| 横屏（任意机型） | ≈45px | 14.6px | 14.6px（不变） |
| 竖屏 375×812 | ≈98px | 14.6px | ≈29.2px |
| 竖屏 iPhone 13 类 390×844 | ≈101px | 14.6px | ≈30.3px |
| 竖屏 iPad 类 834×1194 | ≈143px | 14.6px | ≈42.9px |

**验证**：`npx tsc --noEmit` 全绿；`npm run test:ui`（156 文件/1422 例）+ `npx vitest run`（主单测 160 文件/1275 例）全绿，无回归；`npm run build:web` 生产构建通过。新增 `client/test/ui/sceneHeaderPortraitContentScale.ui.ts`（5 例）：横屏/紧凑栏字号不变、竖屏高栏字号按 `Math.round(headerH*0.30)` 精确放大、`titleSize` 覆写仍优先、返回按钮字号同步放大（不只是标题）、`drawFloatingBackButton` 与 `drawSceneHeader` 在同一屏幕高度下返回按钮大小一致——`git stash` 临时回退 `SceneHeader.ts` 复跑，5 例里 2 例如预期报错（`expected 42 to be greater than 42`），确认不是空断言。真实浏览器截图：本次会话 Browser 面板同样报"pane 未显示、无法合成帧"（同 §23/§26/§27/§28/§29/§30/§31 的环境限制，非本次改动引入），改用上表的真实缩放公式算值替代像素级截图核对。金币簇（右上角）的"钉死绝对大小"例外本次未动，如需一并放大需先确认竖屏下跟标题是否会挤在一起。

## 33. i18n 死 key 审计：删掉 139 个（1595 → 1456），补一条防回归的 spec（2026-08-16）

**背景**：2026-08-15 删皮肤"卖给系统"功能（`f258e27b`）时顺手扫了一遍 `zh.ts`，发现 1595 个 key 里有一大批全仓库搜不到引用。当时的扫描很粗（只匹配字面量、靠前缀排除模板拼接），~295 个候选里混了大量误报，没有当场删。本次做完整审计。

**为什么这类垃圾会攒下来**：三个 locale 的 **key 集合**是编译期强制的（`en.ts`/`de.ts` 是 `Record<TranslationKey, string>`），15.08 又补了 `i18n-placeholder-parity.test.ts` 锁住字符串**里面**的 `{param}`；但"这个 key 还有没有人用"没有任何机制管——没人引用的 key 照样 `tsc` 全绿、照样三语齐全，可以活到天荒地老。删掉的多半是**场景重做后留下的整块**：`prep.*`（12 个）和 `progression.*`（10 个）是 `LevelPrepScene` 早已不再绘制的单位升级/合成面板；~28 个 `world.*` 是世界地图重做前的行军/占领弹窗文案；十几个各场景私有的 `*.back`，是返回按钮统一到 `SceneHeader`（§7 / 上文 2026-07-05 那条）共用 `common.back` 之后剩下的。

**审计方法（两轮，第二轮才是关键）**：

1. **第一轮·扫字面量**：把 `client/` + `server/` + `tools/` 全部 `.ts/.js/.json` 里的引号字符串抽成一个集合，逐 key 查在不在。两个坑：① 模板串内部的 `${t('roster.capacity')}` 必须算引用（按整串 backtick 取会把里面的 `'...'` 吞掉，导致 `roster.*` 等一批被误判成死 key）；② 反过来，`t(\`card.${defId}.name\`)` 这类动态拼 key 的调用点，必须把能拼出来的 key 也算活的。得到 125 个候选。
2. **第二轮·给每个"洞"定值域**：第一轮对动态模板的处理是"前缀放行"，而这正是漏网的原因——`client/test/ui/auctionMaterialNames.ui.ts` 里有个 `t(\`auction.${mat}\`)`（而且它是条**反向断言**，专门断言这些 key 不存在），按前缀放行就等于替 `auction.back`/`auction.seller`/`auction.tax` 全体作保，而 `mat` 只可能是 `scrap|lead|binding`。把每个动态调用点的洞对上真实值域（card/equip defId、`BUILDING_KEYS`、`ACHIEVEMENTS` 的 id、成员角色枚举…）逐个核，又多挖出 14 个：`achievement.back`/`reward`、`family.back`/`myFamily`/`sendMsg`/`changeEmblem`/`err.leaderCannotLeave`、`auction.back`/`seller`/`expires`/`tax`/`auctionTag`/`noBid`/`err.selfBuy`。

**留下没删的**（116 个只靠动态拼接引用，扫描器看不见）：`card.<defId>.{name,desc,lore}`、`equip.<defId>.name`、`affix.<id>`、`rank.*`、`rarity.*`、`city.bld.*`、`achievement.ach.*`、`tutorial.o<n>/beat<i>.*`、`title.slg.*` 等。两个特例值得单记：
- **`achievement.category.collection`**：`AchievementScene.CATEGORY_ORDER` 里有 `'collection'`，但服务端 `ACHIEVEMENTS` 目前没有一条属于该分类，而空分类会被自动隐藏——**今天确实到不了**。仍然保留：分类是 `AchCategory` 类型的正式成员，链路整条通着，服务端加一条成就页签当场就出来。
- **`slg.settle.body` / `family.mail.rejected.body`**：服务端发系统邮件时写成 `key|rank=1|nations=2` 这种带参形式（`FriendsScene/mail.ts` 的 `mailText()` 先按 `|` 切开再 `t()`），所以两边都搜不到裸字面量。

**防回归 spec**：新增 [`client/test/i18n-no-dead-keys.test.ts`](../../client/test/i18n-no-dead-keys.test.ts)——扫 `client/src` + `client/test` + `server`，断言 `zh.ts` 每个 key 要么有字面量引用，要么被 `DYNAMIC_FAMILIES` 表里某一条**声明过的动态族**生成。刻意**不做**成"允许的前缀列表"：上面第二轮挖出来的那 14 个就是被前缀放行盖住的，前缀白名单等于把这次审计的主要发现重新埋回去。每条族记的是**形状 + 值域**，值域能从真常量拿的就直接 import（`CARD_DEFS`/`EQUIPMENT_DEFS`/`ACHIEVEMENTS`/`BUILDING_KEYS`/`AFFIX_FIELD_MAP`/`RANK_TIERS`——加张卡、加栋建筑不用动这个文件），只有槽位/稀有度/成员角色这类闭合小枚举是手写的，而且新增成员时这条 spec 报错正是想要的效果：说明少了一份翻译。扫描刻意宽松（注释里提到 key 也算引用），偏向"少删"而不是"敢删"。

**验证**：`npx tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json` 全绿；`npx vitest run`（160 文件 / 1339 例）+ `npm run test:ui`（186 文件 / 1651 例）全绿；`npm run build:web` 生产构建通过。新 spec 有效性用真失败验证过：往三个 locale 塞一个 `zzz.unused.probe` 后如期报 `expected [ 'zzz.unused.probe' ] to deeply equal []`，删掉后恢复绿。无可见改动（纯删无引用文案），未起 dev server 截图。

### 33.1 反向补漏：服务端选 key、客户端没翻译（2026-08-16 同日追加）

§33 那条 spec 管的是"key 没人用"，反过来"有人用、字典里没有"当时没管。补了两条，各抓到一处真问题。

**① 系统邮件的 key 是服务端选的，两边没人对账**——`sendSystemMail(..., { subject: 'card.mail.rosterFull.subject' })`。服务端编译过、e2e 过（断言的就是 key 字符串本身）、客户端也编译过，错配只在玩家收件箱里显形：`mailText()` 发现 `t()` 原样吐回 key 就退回显示原串，所以不崩，只是**标题直接写着 `slg.city.durabilityBreached.subject`**。新 spec [`client/test/i18n-server-mail-keys.test.ts`](../../client/test/i18n-server-mail-keys.test.ts) 扫 `server/**/src` 里 `subject:`/`body:` 的字面量（单引号和反引号两种写法都收，`|param=` 先切掉），断言三语都有。当场抓到两对从没翻译过的：

- `slg.city.durabilityBreached.{subject,body}`（`worldsvc/src/combatSiege/helpers.ts` 两处，配套 e2e 两条）——就是 §D-CITY-8 里那封"此前玩家对该结果**没有任何通知**"专门补的信，结果通知本身发出去是生 key。两个分支（找得到落点强制迁城 / 找不到连主城一起没）共用同一对 key，所以正文不写死迁去哪了。
- `mail.season.settle.{subject,body}`（`metaserver/src/ladderSeason.ts`，PvP 天梯赛季结算，金币走附件）——写成**反引号**无洞模板串，只匹配单引号的临时 grep 会漏，spec 的正则两种都收才抓到。注意跟大区 SLG 赛季的 `slg.settle.*` 是两套。

**② 动态族的正向覆盖**——§33 的 `DYNAMIC_FAMILIES` 原本只用来解释"这个 key 谁在拼"，现在同一张表加一维 `coverage` 跑第二个方向：`'complete'` 的族，其值域能拼出的每个 key 都必须有翻译（加卡/加建筑/加成就忘了写文案 → 当场红，即 `s_siege` 那个 bug 的反向）。18 个族标 complete，2 个标 partial 且都写了理由：`affix.*`（`AFFIX_FIELD_MAP` 里 6 个前向兼容 id 没有 roll 表能产出，可产出的子集由 `i18n.test.ts` 按 `MAIN_AFFIX_BY_SLOT`+`SUB_AFFIX_POOL` 单独钉死）、`tutorial.*`（`.landscape`/`.done` 变体由字典决定走多远，TutorialDirector 探测不到就回退）。

顺带记一个**跨文件的巧合不变量**：`card.<id>.desc` 只有 `CardScene/detail.ts` 的技能行会读，条件是 `faction === 'anna' && skillGrowth 有非零值`。三个涛方角色是 `NO_SKILL`，所以它们没有 `.desc` 不是遗漏——但这条"够用"是 `cardDefs.ts` 和 `zh.ts` 两个文件各存一半凑出来的，给涛方角色配上技能曲线的那天就会碎。该族的 key 集合现在按渲染器的原条件生成，那天会直接报错要 desc。`card.<id>.lore` 反过来是**必需**的：`detail.ts` 把它直接喂给卡背翻面，没有兜底（`CardCodexScene` 的 `storyText()` 有兜底，容易看岔）。

**验证**：两个新断言都用真删除验过——摘掉 `card.max.desc` 和 `slg.city.durabilityBreached.body` 后如期报错，且消息带上了发信文件路径（`(sent by worldsvc/src/combatSiege/helpers.ts)`）。`tsc --noEmit` 双 config + `vitest run`（163 文件 / 1363 例）+ `test:ui`（188 文件 / 1665 例）全绿。另外量过但**今天没抓到东西**、故未加的：en/de 混入 CJK（0 处）、空字符串值（0 处）。

## 34. LeaderboardScene 竖屏行改两行 + 列宽钳制（2026-08-16）

**问题（i18n 审计顺带发现，非用户报障）**：榜单行竖屏下**必然**把称号标签压进段位列。默认名 `Player1234` + 任意称号即可复现，**与语言无关**——zh `「天梯」` 压过 58px，de `「Rangliste」` 压过 182px；修长机型（1080×2160）为 76px / 200px。横屏完全正常（富余 500+px），所以一直没被发现。

**根因：一行里混用了两套标尺。** 字号从 `rowH` 推（`rowH = h*0.065`，跟屏幕**高**走），列位置从 `listW` 推（`0.18w` / `0.68w`，跟屏幕**宽**走）。横屏 16:9 两者比例接近，看不出问题；竖屏 ≈1:2，高度驱动的字号相对宽度驱动的列格严重超宽。`designWidth` 竖屏恒为 1080 而 `designHeight ≥1920` 且随机型变高，所以**屏幕越修长越糟**。称号长度只是放大系数，不是原因（name 余量 zh 8 字符 / de 4 字符，而默认名就 10 字符）。

**修复**（用户在两行 / 字号改跟宽度 / 只记录 三个方案里拍板选两行）：

- 竖屏行改**两行**：第一行 name（独占整行宽度），第二行 称号 / 段位 / ELO。`rowH` 竖屏 `h*0.065 → h*0.095`；滚动、命中矩形、`scrollMax` 全部由 `this.rowH` 推导，自动跟随，无需另改。横屏保持单行不变。
- 行几何抽成纯函数 `leaderboardRowGeom(w, rowH, twoLine)` + `fitNameAndTitle(nameW, titleW, avail, gap)`，导出供测试（同 `badgeYBelowContent` 的做法）。两条路径都给 name+称号块一个硬右边界 `contentRight` 并钳进去——**超长玩家名再也压不进段位列**。这层防御值得有：服务端没找到 `displayName` 的长度校验。常见情形（放得下时）`scale` 恒为 1，像素级不变。
- 称号短标签 en/de 改短到 ≤4 字符（见 `TITLE_DESIGN.md` §6：`Conqueror→Conq`、`Rangliste→Rang`、`Champ/Top 3→Top1/Top3` 等），从源头符合预算。选**改文案**而非运行时 `slice(0,4)`，因为 `Rangliste→Rang` 是人挑的，硬切出来的观感差。

**修复后余量**（listW=972）：竖屏 name 到边界富余 169px（17 字符才开始钳制，原先 8）、称号富余 268–288px、段位（`Grandmaster` 最宽 ±97）右边缘 700 < ELO 左边缘 851。横屏 name 富余 660px。

**验证**：`npx tsc --noEmit` 双 config 全绿；`npx vitest run`（164 文件 / 1398 例）+ `npm run test:ui`（188 文件 / 1665 例，含既有 `leaderboardScroll.ui.ts`）全绿；`build:web` 通过。新增 [`client/test/leaderboardRowGeometry.test.ts`](../../client/test/leaderboardRowGeometry.test.ts)（35 例），含一条**旧几何见证测试**——用修复前的公式重算并断言它确实会撞，保证这条 spec 不是空断言。

> ⚠️ **未做像素级截图核对**：Browser pane 在本环境仍不合成帧（同 §23/§26–§32 的环境限制）。替代做法是把两个字体假设换成**真实测量值**——起 dev server 后在真 Chromium 里用 canvas `measureText` 量 `monospace`（ASCII advance **0.5498em**，`「」`/CJK 各 **1.0em**；PIXI 的 TextMetrics 底层就是这个 API），代回从源码读到的精确布局常数，同 §32 用真实缩放公式替代截图的处理。**两行版式的观感（行高、两行的疏密、榜单一屏行数由 11 降到约 8）需要你在真机竖屏上看一眼再定档**——算术只能保证不重叠，保证不了好看。

## 35. 竖屏三处溢出（大世界头部行 / 兵力卡 / 大厅副标题）（2026-08-18）

**发现方式**：不是用户报障，是跑商店截图管线（[`store-assets-checklist.md` §0.4](../product/release/store-assets-checklist.md)）时，第一次在 **1290×2796（iPhone 15 Pro Max 原生分辨率）** 这类极修长竖屏上逐屏看画面，三处溢出一起现形。全部是同一个病根，跟 §34 榜单行、[[ilayout-landscape-design-width-stretches]] 记的两次是**同一族**：竖屏 `designWidth` 恒为 1080（钉住），`designHeight` 随机型变长，于是任何从**高**推出来的尺寸（字号、按钮高、`sceneHeaderHeight`）在竖屏会越长越大，而它要塞进去的宽度一直是 1080。

**① 大世界头部一行塞不下四组东西**（`WorldMapPanels/headerHud.ts` + `WorldMapRenderer/build.ts`）

实测 1080×2341：`sceneHeaderHeight = 281`，按钮高 `281*0.7 = 197`、标签字号 `197*0.34 = 67`，于是 Home/Shop/Auction 三个「图标+文字」按钮各约 240–338px 宽；返回键命中区本身 396px 宽。三按钮从右往左排，`Home.x = 192 < 396` —— **压在返回键上**；资源读数（5 种资源 × 产量/存量两行）的可用宽被算成负数，而它的 shrink-to-fit 有个 **0.55 下限、注释里明写"下限以下宁可溢出"**，于是读数横跨按钮、右端还冲出屏幕（`resClusterRect` 右边缘 1149 > 1080）。

修法（竖屏专用，横屏逐像素不变）：
- `build.ts` 新算 `ctx.resStripH = h > w ? round(headerH*0.46) : 0`，`ctx.topInset = headerBarH + resStripH`。因为全场（地图裁剪 mask、`viewport.ts` 的可视区/居中、输入命中、右列 HUD 起点）都只读 `topInset` 这一个值，加一条带子不需要改其它任何地方。
- 竖屏三按钮**去掉文字、改正方形图标键**，并把边长钳到 `(可用宽-16)/3` —— 保证永远排在返回键右侧、不出右边界。
- 资源读数移到带子里，占近满宽（左右各 16 边距），图标/字号改按**带子高**推（原来按 bar 高推会竖向撑爆带子），shrink-to-fit 的 0.55 下限**取消**（带子够宽，实测只需缩到 ~0.8）。
- 左上角缩放键原本挂在"返回键正下方"，正好是新带子的位置 → 改挂 `max(topInset, backRect 底边)`。

**② 兵力/领地卡的数字串出半栏**（`WorldMapPanels/hud.ts`）：卡宽 320、两栏各 160，兵力值满兵时是 `10000/10000`，`FS.heading` 下宽度超过半栏，直接压在右栏「Territory」上。改为按栏宽 shrink-to-fit（数字本身是重点，缩放而不截断）。同一处顺带修一个存在已久的低级错误：栏间竖分隔线的 y 用的是卡内相对值（`10 → cardH-10`）却没加卡片自身的 `ry`，所以它一直画在**屏幕最上方、被头部盖住**——卡里看起来"从来没有分隔线"。

**③ 大厅 START MATCH 副标题左右出血**（`LobbyScene/mainContent.ts`）：字号 `heroH*0.15` 跟着竖屏拉长的高度轴变大，字符串长度却是固定的，`Ranked · 5-10 min per game`（德语更长）超出卡宽、两侧被裁。加一条 `contentW*0.92` 的 fit 钳制。

**验证**：`tsc --noEmit` 双 config 绿；新增 [`client/test/ui/worldMapPortraitHeaderFit.ui.ts`](../../client/test/ui/worldMapPortraitHeaderFit.ui.ts)（9 例：三按钮不压返回键/互不重叠/不出右界、读数在带子内且完全在屏内、缩放键让开带子、横屏读数仍在 bar 内且保留文字标签、满兵值不出半栏、短值不被缩放）——用的是上面实测的真几何（1080×2341/281/129），不是编的数字；`test/ui/worldMap*` + `lobby*`（39 文件 / 358 例）全绿。**这次有像素核对**：三处都在 1290×2796 真实渲染上截图前后对比过（截图管线本身就是 §0.4 那套），头部行不再重叠、资源带完整、副标题落回卡内。

## 36. iPad 留白改成"纸页摊在桌面上"（2026-08-18）

**起因**：商店截图跑到 iPad 12.9"（2048×2732）时看清的——竖屏设计高有 1920 下限（硬下限，见下），比 9:16 更**方**的屏幕按 Contain 缩放后左右各留 256px 空白，占面板 25%。上下恒为 0。iPhone 全部 0（2026-07-21 动态设计高修掉的是"更修长"那一侧，没管"更方"这一侧）。

**为什么不能直接降下限**：`70`(顶 HUD) + `18×84 = 1512`(棋盘) + `70`(底 HUD) + `268`(手牌) = **正好 1920**。再低一点棋盘就压进手牌，必须把 `CELL` 变成动态值，那会动到 `gridToScreen`/`screenToGrid` 输入映射和一大批战斗测试。留白量、四个备选方案的代价对比、以及为什么没选"竖屏设计宽跟着拉伸"（281 处 `w * 0.x` 全变疑点，正是 §35/§34 那个 bug 类）都记在 [`store-assets-checklist.md` §0.6](../product/release/store-assets-checklist.md)。

**采用的做法（设计矩形内零改动）**：`ScalingManager` 新增最底层 `deskLayer`，把留白带画成书页下面的桌面——kraft 底 + 极淡斜纹 + 页边软阴影（7 层递减 alpha 的嵌套矩形，不用 blur filter，因为这层每次 resize 都重画）+ 一道墨线页缘。抽成导出的纯函数 `drawDeskSurround(g, screenW, screenH, pageX, pageY, pageW, pageH)` 便于测试。

**必须是屏幕空间**（这是唯一有点绕的地方）：它要框住 `gameLayer` **缩放后**的矩形；`bgLayer` 是 Cover、`gameLayer` 是 Contain，有留白时两者缩放比例天然不同，所以任何设计空间图层都对不齐那个边框。手机路径（`pageX < 2`）一个图元都不画且 `visible=false`，零开销。

**验证**：`tsc --noEmit` 双 config 绿；新增 [`client/test/ui/deskSurround.ui.ts`](../../client/test/ui/deskSurround.ui.ts) 5 例；`test:ui` 200 文件 / 1768 例全绿。**像素核对**：iPad 12.9" 重拍大厅/大世界两屏确认——带内取样 `rgb(222,211,189)`（桌面 kraft）、页内 `rgb(245,240,232)`（纸白），页缘阴影与墨线可见，`art/store/en/*__ipad_12.9.png` 已更新。

## 37. 头像/图标框的双层背景改成单层+描边（2026-08-21）

**起因**：用户看融合弹窗（[`CardScene/feed.ts`](../../client/src/scenes/CardScene/feed.ts) 的环形材料选择）截图，问"头像背后为什么又叠了一张方形底图，是不是重复渲染了"。查证后发现：`feedList.ts` 的候选行确实是**外层行背景 + 内层头像框**两个 `sketchPanel` 紧贴叠放——行背景已经铺了一层米白色 `sketchPanel`，头像框又在贴身位置铺一层几乎同色的 `0xf0eee7` 填充，行高矮（`thumbBox = rowH - 8*S`）时两层边距只剩 4px，读出来就是"重复画了一个方块"而不是"卡框"。

进一步排查发现这**不是孤立 bug**，是整个卡牌模块统一沿用的"格子背景 + 内嵌头像/图标框"两层结构——[`CardScene/list.ts`](../../client/src/scenes/CardScene/list.ts)（花名册网格）、[`CardScene/detail.ts`](../../client/src/scenes/CardScene/detail.ts)（详情弹窗立绘）、[`CardScene/skins.ts`](../../client/src/scenes/CardScene/skins.ts)（皮肤列表）都是同样的写法，此外沿着 `sketchPanel(` 全仓排查又找到 [`EquipmentScene/assign.ts`](../../client/src/scenes/EquipmentScene/assign.ts)、[`EquipmentScene/cells.ts`](../../client/src/scenes/EquipmentScene/cells.ts)、[`EquipmentScene/craft.ts`](../../client/src/scenes/EquipmentScene/craft.ts)、[`DefenseEditorScene/roster.ts`](../../client/src/scenes/DefenseEditorScene/roster.ts)、[`worldmap/WorldMapPanels/shop.ts`](../../client/src/scenes/worldmap/WorldMapPanels/shop.ts)、[`CityScene/teamRow.ts`](../../client/src/scenes/CityScene/teamRow.ts)、[`AuctionScene/list.ts`](../../client/src/scenes/AuctionScene/list.ts) 共 7 处同款。内层 frame 的 `fill` 有的纯装饰（跟外层同一个 `C.mid`/同色，如 list.ts、skins.ts、shop.ts、AuctionScene/list.ts），有的 border 传达真实信息（阵营色/稀有度色，如 feedList.ts、detail.ts、EquipmentScene/cells.ts、craft.ts）——但**填充本身在所有 7+5 处都是多余的**：外层背景已经是唯一需要的那一层。

**修法**：给全部 12 处内层 frame 的 `sketchPanel` 调用加 `fillAlpha: 0`（`sketchPanel` 本就支持这个参数，见 [`render/sketchUi.ts`](../../client/src/render/sketchUi.ts) 的 `PanelOpts`），让外层背景透出来，只留手绘描边——传达阵营/稀有度信息的边框颜色原样保留，纯装饰性的边框也保留（仍是"卡框"视觉，只是不再重复填色）。融合弹窗环形图（`feedRing.ts`）本身没有这个问题，一直是单层圆形（填充+描边一次画成），不用改。

**验证**：`tsc --noEmit` 全绿；受影响场景的既有 `test:ui` 用例（`cardFusePanel`/`cardFusePanelPrep`/`cardSceneSkins`/`cardDetailFlipAndSkin`/`cardArtLoadingSpinner`/`auctionScene`/`equipmentEnhanceIncrementalRedraw`/`equipmentEquippedTagOverflow`/`worldMapShopPanel`，9 文件 / 179 例）全绿。**像素核对**：用 `#fusedemo` 临时 hash 路由（仿 §"Screenshotting a panel that needs a FABRICATED save state" 的记忆写法，构造好目标卡+材料池的 `cardInv` 后直接 `feed.openFuseSelect(target)`，跳过登录/后端）截了融合弹窗改前改后两张图对比——两层填色本来就是几乎同色（这正是它读起来"像是重复"而不是"明显叠色"的原因），像素级差异不大，但结构上从两层裁成了一层，且跟环形图的单层画法统一。

## 38. 回放：「Replay」标签移到纸页边、视角文字标签换成血条名字牌（2026-08-26）

**起因（用户截图反馈，横屏回放）**：① 左上「● 回放」标签钉在设计空间最左边（`designWidth * 0.04`），而横屏下棋盘两侧各有 ≥330px 的纸页留白（见 [`LandscapeLayout`](../../client/src/layout/LandscapeLayout.ts) 的 `boardX` 注释），标签离它所标注的东西隔了一整个留白宽；② 左下角 `视角：玩家1` 这行独立文字标签（`replay.viewpoint`）——用户要求去掉，改成「己方名字挂在己方血条上、敌方名字挂在敌方血条左侧」，也就是 PvP 里对手昵称的那套呈现。

评估结论：用户给的两种方案其实是同一种——PvP 的对手昵称本来就是「血条左侧的名字牌」（[`labels.ts`](../../client/src/render/GameRenderer/labels.ts) 的 `drawOpponentLabel`），所以回放两侧统一复用这套名字牌，不再自己发明第二种呈现。

**改动**：
- **共用名字牌**：`labels.ts` 抽出 `drawNameChip(core, name, fill, bh, place)`——按标签实测宽度撑出 `drawHudButton('secondary')` 底板，落点由调用方的 `place(bw, bh)` 决定（好右对齐/按实测宽度回退）。`drawOpponentLabel`（PvP）改为它的一个调用点，几何一像素不变。
- **回放两块名字牌**（替换 `replay.viewpoint` 文字标签，i18n key 已从 zh/en/de 删除）：敌方牌在顶部血条左侧 12px（同 PvP）；视角方牌挂自己的血条。两块统一 34px 高（PvP 那块仍是投降键的 44px）。**为什么敌方牌比 PvP 矮、且以血条而非顶栏居中**：回放隐藏投降键（`getSurrenderRect()` 全零，没有可借的按钮带），而 `ReplayScene` 的进度条正好压在顶栏下沿——顶栏居中的 44px 牌会被它切掉底边（实测过），所以改成「以血条居中、再钳进顶栏上 72%」。
- **视角方牌的落点**：优先放血条左侧（竖屏——血条居中于棋盘，左边有富余）；横屏的左信息栏（`hudBottomLeftRect`，300 宽）只比血条（`HP_BAR_W = 237`）宽 50px 放不下，退回栏顶、右对齐到血条右边缘，即老 `视角：` 标签原来的位置。判据是实测宽度够不够，不写 `orientation` 分支。
- **`HUDView` 新增 `getPlayerHpRect()`**（对称于既有的 `getEnemyHpRect()`）——名字牌需要己方血条的矩形。
- **「● 回放」标签**：横屏右对齐进棋盘左侧留白（离棋盘边 40px）并上移到顶栏自己的带子上、与计时器同一行（计时器在棋盘边内 14px，两者之间因此留出约 54px，不会读成一行）。竖屏留白只有 36px，放不下 → 保持原样（`w*0.04` + 进度条上方那行），判据同样是实测宽度而非 orientation。

**验证**：`tsc --noEmit` 绿；`test:ui` 229 文件 / 2161 例 + `vitest run` 195 文件 / 2036 例全绿；webpack production 构建通过。既有的 siege 名字用例改为**钉住新规则**：每个名字恰好出现 2 次（基地牌 + 血条名字牌），且不再出现 `View:` 前缀串。**像素核对**：Browser 面板仍报「pane 未显示、无法合成帧」（同 §26 记录的限制），改用 `start:e2e` 入口 + Playwright 直接 `__nwE2E.views.showReplay(合成的 Replay)` 截图——横屏 1700×850 与竖屏 480×900 各一张，确认：横屏「● Replay」落在留白里与计时器同排、敌方牌完整位于进度条上方（3× 放大核对过没被切）、视角方牌右对齐在自己的墨量/血条之上；竖屏两块名字牌都在血条左侧、「● Replay」回到老位置不压计时器。

**追加（同日，用户确认后）**：**基地上方的两块名牌一并删掉**，回放的名字呈现收敛成「每条血条一块名字牌」——和 PvP 完全同构（PvP 也没有基地名牌，只有顶部对手昵称牌）。唯一多出来的是视角方那块牌：真打时你不需要被告知自己是谁，回放需要。

**顺带核实了「基地方位/视角与真实 PvP 一致」**（用户要求确认）：一致，而且是**结构性**的而非巧合——回放切视角走的是 `layout.mirrored()`，也就是联机 joiner（`localSide = Side.Top`）真打时用的那套 layout；`playerBaseRect()` 对两个 `localSide` 都返回近侧（横屏最左）、`enemyBaseRect()` 都返回远侧，`localOwner = sideToOwner(layout.localSide)` 又驱动 HUD「己方在下条、敌方在上条」。实测（1700×850，横屏，`__nwE2E` 取 live scene）：默认视角 `side=bottom / owner=0`，翻转后 `side=top / owner=1`，两次 `playerBaseRect().x` 都是 450、`enemyBaseRect().x` 都是 1570 —— 只有「这座城是谁的」变了，城的位置没动；名字牌与手牌同步换成另一方。新增用例 `either viewpoint puts the viewed side where a live match puts it`（`test/ui/gameScenes.ui.ts`）把这条钉住，比的是 `createLayout(..., Side.Top)` 真造出来的 joiner layout，不是硬编码像素。既有 siege 名字用例相应改成每个名字**恰好出现 1 次**。

**验证**：`tsc --noEmit` + `tsc -p tsconfig.test.json` 绿；`test:ui` 229 文件 / 2162 例 + `vitest run` 195 文件 / 2036 例全绿；webpack production 通过；横屏两个视角各截一张确认名牌消失、其余不变。

**追加二（同日）：transport 行加「切换视角」按钮**。删掉基地名牌后，「点基地翻视角」变成一个零提示的手势（名牌本来也不是按钮提示，但至少标出了两座城），所以把它提成显式控件：`Pause | 1× | 切换视角 | Share | Exit`（`replay.flipView`，zh 切换视角 / en Flip View / de Ansicht），点基地的老手势保留，两条路走同一个 `switchViewpoint()`。**故意不受 `ended` 门控**——播放结束后从败方视角回看最后一帧，正是最想翻的时候（播放/暂停键那条 `if (this.ended) return;` 不适用于它）。

顺带两处连带修复，都是「加了第五个按钮」暴露出来的：
- **按钮标签 shrink-to-fit**（`fitLabel()`）：这排按钮的**字号按按钮高**推、而**宽按棋盘**推，竖屏设计高一拉长字号就跟着变大，宽度却没变——德语 `Abspielen`/`Beenden` 早就在竖屏溢出了（这次截图才第一次看到）。play/pause 标签每帧换词，所以 `fitLabel` 每次先复位 `scale=1` 再算，不然长词缩过之后短词会一直保持缩放。
- **「● 回放」标签竖屏改挂顶栏右端**：行变宽后左边缘从 x=177 挪到 x=86，正好压到标签原来那个「顶栏下方」的位置（英/中文标题短看不出来，德语 `Wiederholung` 一眼就压穿整排按钮）。竖屏没有横屏那种纸页留白，但**顶栏右端是空的**（回放隐藏投降键），于是右对齐进去、宽度钳在设计宽的 30% 以内（竖屏设计宽恒为 1080，敌方血条居中占 421–658，30% 钳位保证起点 ≥742 不相撞）。两个朝向现在都在顶栏带子上，不再有「掉到纸面上」这种落点。

**验证**：`tsc --noEmit` 绿；`test:ui` 230 文件 / 2177 例 + `vitest run` 2042 例全绿；webpack production 通过。新增 3 例（`test/ui/gameScenes.ui.ts`）：翻转按钮走**真 `EventBoundary.hitTest`**（不是裸 `emit`，见 scenes.ui.ts 里 ResultScene 那条注释的理由）+ 整排 5 个按钮仍在棋盘内、结束后仍能翻、竖屏德语下标签留在顶栏内且在敌方血条右侧。三个变异（删按钮 / 空 handler / flipW 撑到 0.6 / 标签退回老 y）逐个跑过确认用例真的会红。**headless 专属坑**：`containsPoint` 走 `worldTransform` 反变换，测试里没人渲染 stage，PIXI 没碰过的节点还是单位矩阵、任何 hitTest 都打空——hit 前先 `scene.container.getBounds()` 强制刷一遍变换（`updateTransform()` 不行：根节点没有 parent 会 NPE）。**像素核对**：横屏/竖屏 × zh/de 四张截图确认整排按钮不溢出、德语标签自动缩放、标签与按钮不再重叠。

**追加三（同日）：把名字牌的落点规则钉成测试**。上面那两轮里，名字牌的位置全是靠截图 3× 放大量出来的（敌方牌底边被进度条切掉 3px 就是这么发现的），一次都没进测试——补上 [`client/test/ui/replayNameChips.ui.ts`](../../client/test/ui/replayNameChips.ui.ts)（5 例）：

- **敌方牌**（横竖屏各一遍）：右边缘正好在敌方血条前 12px（与 PvP 同一常量）、整块落在顶栏内、**底边不超过 `ReplayScene.barY`**（进度条画在渲染器之上，重叠就是「牌上拉了一条红线」），且纵向仍与血条相交（还读得出是在标注这条血条）。
- **视角方牌**：与血条**矩形不相交**、不出屏、留在底部条自己的带子里；然后按实际落点分支断言——左置分支（竖屏）离血条 12px 且与之居中对齐，栈上分支（横屏）底边不超过血条顶边、右边缘与血条右边缘对齐且整块在左信息栏内（竖屏血条本身就在那个 rect 之外、居中于棋盘，所以这条只在栈上分支断言）。
- **PvP 那块牌**（`drawNameChip` 是从它里面抽出来的）：仍取**投降键**的纵向带（不是顶栏带）、离血条 12px、profile 命中区收窄到牌本身——这条是防「为了回放的改动顺手把真打的 UI 挪了」。

牌的矩形取法：`drawNameChip` 是 `addChild(bg, label)` 成对加的，所以背景就是文字节点的前一个兄弟；规则本来也是写在背景矩形上的，不是文字上。四个变异逐个跑过确认会红：44px+顶栏居中的旧几何（复现「底边 52.5 > 进度条 49」这条原始 bug）、去掉视角方牌的回退分支（横屏被推到 x=-17.5 出屏）、PvP 牌改吃顶栏带、「● 回放」标签退回设计空间左边缘。另外补了一例钉横屏标签落点（在顶栏带子上、在棋盘左侧留白里、与计时器至少隔 20px）。

**一个没能测的东西，如实记一下**：按钮标签的 shrink-to-fit **只有像素核对，没有测试**。headless 用的是假字体度量（实测约 7px/字符，与字号无关——德语 `Abspielen` 量出来 63px，真实渲染下是 227px），所以任何「标签宽 ≤ 按钮宽」的断言在 headless 里恒真、缩放分支永远走不到，写了也只是安慰剂。这类「取决于真实字体度量」的规则只能留在截图核对里（同 §35 的判断）。

## 39. 像素级核对补做：真实 Chrome 终于能截图，§29/§32/§34 补完 + 查出装饰层 alpha 与自己的注释不符（2026-08-27）

**背景**：§23、§26–§32 每一条的「验证」段都写着同一句——Browser 面板报「pane 未显示、无法合成帧」，所以没做像素级截图，改用算术/单测替代。本轮换成**用户本机真实 Chrome**（`mcp__claude-in-chrome__*`）+ `npm run start:e2e`（9096）+ `window.__nwE2E.views.*` 直接灌数据，**截图成功**，把这串积压能做的都做了。

**强制横竖屏的办法**（本环境 `resize_window` 对已最大化的标签页无效，`outerWidth` 读出来是 160×28 这种垃圾值）：直接打 `PixiAppViews` 自己的 resize 通路——
```js
V.platform.getScreenSize = () => ({ width: w, height: h });
V.onResize();          // 重建 layout + renderer.resize
```
然后重新 `showXxx()`（场景是按构造时尺寸建的，不会自己跟着变）。竖屏用 400×850 而不是更高，是为了让 canvas 整个落在 1920×855 的视口里，截图不被裁。

**核对结果**

| 条目 | 结论 |
|---|---|
| §29 ResultScene 竖屏次要徽章行 | ✅ **修复确认**。竖屏（400×850→design 1080×2295）下 `[Best Damage] 102 dmg` / `[Efficient] 8 kills` 整行清楚落在主徽章详情句「Base only took 0 damage」下方，无重叠；横屏（1400×800）同样正常，回归守卫成立 |
| §32 竖屏标题栏返回/标题字号跟栏高缩放 | ✅ **修复确认**。同一个 `drawSceneHeader`，竖屏下「Back」与标题明显大于横屏，与 §32 那张换算表的方向一致 |
| §34 LeaderboardScene 竖屏两行行版式 | ✅ **不重叠确认**，一屏约 8 行（与预估的 11→8 一致）；名字在第一行、`「title」`+段位+分数在第二行右侧成簇。**观感仍需用户在真机竖屏定档**（算术只能保证不重叠） |
| §31 ShopScene 标题换行顶价格 | 已于 2026-08-11 用 Playwright 截图核对过，本轮不需重做（§31 自己的验证段已写明） |
| §33 i18n 死 key | 无可见改动，N/A |
| §27 Hero Roster「Skins」立绘 / §28 Home City 对比度 | ❌ **仍未截图，但失败原因换了**：不再是「不合成帧」——`CardScene` 一挂上，`Page.captureScreenshot` 就 30s 超时（换新标签页、`app.ticker.stop()` 冻帧都不行；同一标签页此前截 Leaderboard/ResultScene 都成功）。推测是大量卡面美术解码/纹理上传把渲染进程卡住。要么后续用 Playwright（§31/§38 走的就是这条），要么先减少首帧纹理上传量 |

**顺带查出的问题（本轮真正的收获）：`decorCLayer.ts` 的 alpha 与它自己的注释不符，且确实压前景**

- 文件头写着「faint alpha (**0.06–0.15**) never competes with foreground」，实际常量是 `ALPHA_MIN = 0.25` / `ALPHA_RANGE = 0.13`，即 **0.25–0.38**。
- 溯源：`7317c960`（2026-06-28，「大厅背景装饰数量翻倍，alpha 调整为 0.25-0.38」）为**大厅**观感调高的，注释没跟着改；而且**在那之前注释就已经过时**——那次 commit 说原值是 0.10–0.22，注释却写 0.06–0.15。
- 影响面不是大厅一个场景：`buildDecorCLayer` 被 **27 个场景**调用。
- 真实 Chrome 下的可见后果：LeaderboardScene 右上「My rank: #42 **1830**」两个朝向都正好压在一团墨点上；ResultScene 横屏「102 dmg」压在一颗金色星星下，竖屏星星横跨次要徽章行和「FIGHT AGAIN」按钮。
- 还有个结构性错配：`EDGE_SKIP=0.20` / `CENTER_SKIP=0.80` 是按「主内容在中央竖带、装饰推到边缘」设计的——这对大厅成立，对列表页不成立：列表页的标题栏、赛季标签、my-rank 读数全在**顶边**，正是装饰最密的地方。
- **本轮只改注释（把真实数值和后果写进去），没动 alpha**：调低 alpha 或给场景 chrome 加 keep-out 矩形属于美术方向拍板，且一改就影响 27 个场景，留给用户定。
- **✅ 已拍板并落地（2026-08-27 当日，见 §40）**：全局退回 0.10–0.22，密度不动。

## 40. decorCLayer alpha 拍板：全局退回 0.10–0.22，密度不动（2026-08-27）

§39 查出的问题在同日拍板。三个候选是 **(a) 调低 alpha** / **(b) 给场景 chrome 加 keep-out 矩形** / **(c) 只在列表类场景降透明度**，选 **(a)**。

**决定性的证据是 `git show 7317c960`——那次 commit 做了两件事，标题只承认一件：**

```
feat(lobby): 大厅背景装饰数量翻倍，alpha 调整为 0.25-0.38
- GRID_COLS/ROWS 4×6 → 6×9，EDGE_SKIP 0.28→0.20，装饰数量约 2×
- ALPHA_MIN/RANGE 调整为 0.25–0.38（原 0.10–0.22）
```

「大厅装饰太少」是**密度**回答的；alpha 抬高是搭车改的，标题里没写，而且它作用于全部 27 个调用场景而不是被调音的那一个大厅。所以 (a) 不是「调低一点试试」，是**退回一个当年按同一条判据挑过的值**——被替换掉的那行注释原文就是 `// → 0.10–0.22，明显可见但不抢前景`，而它本身又是从 0.06–0.15（「原来几乎不可见」）刻意抬上来的一档。

而且 (a) 几乎没有观感代价：大厅在 06-28 之前是「0.10–0.22 + 一半密度」，改完是「0.10–0.22 + 双倍密度」，**严格比历史上任何时候都更热闹**。密度那半边的改动完整保留。

**为什么不选 (b)/(c)：`bake()` 的缓存按尺寸做键。**

[`bake.ts`](../../client/src/render/bake.ts) 的缓存是 `Map<string, RenderTexture>`，键完全由调用方给，而 `decorCLayer` 传的是 `decorc:${w}x${h}`——**只有尺寸**。于是任何按场景变化的参数（keep-out 矩形 / 分档 alpha）都有两笔代价：

1. **必须进 bake 键**，否则同一尺寸下第一个 bake 的场景会把自己那张图静默发给其余 26 个。这是会真发生的 bug，不是理论风险。
2. **一进键就多一张整页纹理常驻**。整页 bake 正是 ADR-073 差点撞死的那一类（大厅三层整页 = 334 MB 一次性申请），而缓存目前**还没有字节预算淘汰**（2026-08-25 留下的未决项）。为一个装饰层去恶化一个已知未决的内存问题，性价比不对。

(b) 另有一条独立的反对理由：它要 27 个场景各自申报自己的 chrome 几何，而那套几何随朝向和机型变（§34/§35 的病根）。那等于把布局数据抄第二份——**正是产出本 bug 的那个失效模式**（一句关于真实数值的注释放了两个月没人发现）。它一定会再过时。

(c) 的方向是对的，但数字反对它的**表述**：27 个调用点里约 21 个是列表/读数场景（Achievement / Auction / BattlePass / CardCodex / Card / Chat / Daily / DeckBuilder / DefenseEditor / Equipment / Event / Family / Friends / Leaderboard / LevelPrep / Recharge / Result / Sect / Shop / Stats / Titles），真正「主内容在中央」的只有大厅 / 登录 / 房间 / 战役地图 / 城市 / 抽卡 6 个左右。安静值适配 21 个、吵闹值适配 6 个——**那默认就该是安静的，吵闹的才是 opt-in**。所以 (c) 正确的形态是「(a) + 大厅显式 opt-in」，而 (a) 是它的第一步；第二步只有在大厅确实显淡时才做，且届时 bake 键必须带上预设名。

**`EDGE_SKIP`/`CENTER_SKIP` 对列表页的结构性错配没有修**，是有意的：它决定涂鸦在哪，而 0.10–0.22 下顶边的涂鸦是氛围而不是竞争。修 placement 模型又要回到「按场景申报」，即 (b) 的代价。这条结论写进了文件头，避免下一个人重新发现「列表页顶边最密」时又去改 skip。

**改动**：`ALPHA_MIN` 0.25 → 0.10、`ALPHA_RANGE` 0.13 → 0.12（[`decorCLayer.ts`](../../client/src/render/decorCLayer.ts)），两行。文件头 `@alpha-range` 标记同步改成 `0.10-0.22`，并把 §39 那段「实际是 0.25–0.38」的散文整段重写——它描述的已经是历史，留着就会变成第三代过时注释。新头部另记两条判据供后人查：**密度而非透明度才是「装饰太少」的旋钮**，以及**为什么 alpha 是一个全局数字而不是按场景分档**（bake 键那两笔代价）。

**验证**：`decorCLayerContract.test.ts` 7 例全绿；双向变异各判红一次（改常量不改标记 → `@alpha-range says 0.10-0.22 but ALPHA_MIN/ALPHA_RANGE produce 0.3-0.42`；改标记不改常量 → 反向同一条），备份用 `cp` 不用 `git checkout`。`tsc --noEmit` 双 config 绿。

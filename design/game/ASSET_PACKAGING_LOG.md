# Notebook Wars — 资源打包补测/复核/重打包记录（spec 见 [`ASSET_PACKAGING.md`](ASSET_PACKAGING.md)）

> 从 `ASSET_PACKAGING.md` 拆出（2026-08-29，ADR-067 单册形态：hub 原位留同号 stub + 箭头，不建索引表）。§1–§13（当前架构：三层分级/各平台打包方案/首屏加载策略）仍在 hub；本册是 §14 起的逐条记录——§14 预取裁剪+省流开关、§15 补测、§16 icons_atlas 重打包、§17 微信黑屏、§18 微信 REST 接缝、§19 隐藏 `<input>` → `IPlatform.openTextInput`——小节编号与正文一字未改。

## 14. 预取按使用面裁剪 + 省流开关（2026-08-25）

§13.6 留的那条尾巴。起点是一句判断：**这不是「省流判据不准」的问题，是「预取得太多」的问题**——换个更准的网络探测最多让一部分玩家少下 5 MB，而按使用信号裁剪对**所有平台、所有网络**都生效，还顺带解决了内存那一半（wifi 上照样白解码 13.7 MB，跟计费与否无关）。所以顺序是 ①裁剪 → ②补探测 → ④给玩家开关，网络探测是次要的。

新增 `client/src/assets/prefetchPolicy.ts`，把 `idlePrefetch` 需要但够不着的三件事收在一处：玩家设置、平台网络 API、场景写下的使用标记。

### 14.1 ① 两个大波次按「用过才预热」裁剪

`slg:world`（2.0 MB）+ `gacha`（1.2 MB）占 ~5 MB 预取量的 3.2 MB，而且是仅有的两个**玩家可能一次都不进**的界面。`WAVES` 表新增可选 `when`：

| 波次 | 门控 | 理由 |
|---|---|---|
| `boot:background` / `icons:reward` / `battle` | 无 | 每个账号都会走到（第一局是所有人都做的事） |
| `slg:world` | `hasUsedFeature('world')` | 全游戏最大单文件，1960×1827 RGBA ≈ **13.7 MB 解码内存** |
| `gacha` | `hasUsedFeature('gacha')` | 且它自 §13.2 起本来就有进场闸门 |

**标记是提示，不是权限**，所以刻意做得便宜、本地：写 `platform.storage`，**不走服务端 `flags`**——后者要一次 `PUT /flags` 往返，去记一件「猜错零成本」的事。猜错确实零成本：每个场景闸门都会重新 await 同一批幂等 loader，没预热的界面就是照旧付自己的闸门，跟本节存在之前一模一样。

**标记写在场景自己的资源需求点**（`WorldMapRenderer/lifecycle.ts` 的 `bootstrap()`、`PixiAppViews.showGacha` 的闸门），**不写在 loader 里**——预取调用的正是那些 loader，写在那儿会让每个波次跑一次之后就自我论证。

跳过的波次会 `console.info` 报出来（`[prefetch] not warming (never opened): …`），不静默瘦身。

### 14.2 ② 微信改用 `wx.getNetworkType()`

`navigator.connection` 是 Chromium 独有，微信运行时里**根本不存在**，所以此前微信构建一律读成「未知链路」、任何网络下都全量预取。`wx.getNetworkType` 是一等 API，仓库里**从来没被调用过**，`wx.d.ts` 里连声明都没有。

`IPlatform` 新增可选 `getNetworkKind?(): Promise<NetworkKind>`；不实现的平台回落到 `navigatorNetworkKind()`（web/CrazyGames/mobile 本来就该用这个）。映射：`wifi`→wifi、`2g`→slow、`3g/4g/5g`→cellular、`none`→none、其余→unknown（这个列表加过 `5g`，所以按开集处理，不穷举 switch）。探测**永不 reject**，失败即 `unknown`＝当普通链路。

> ⚠ **`cellular` 不跳过预取**，这条边界是承重的：要拦的是「投机字节真的伤人」的链路，不是「凡不是 wifi」——放宽会把大多数手机的预取直接关掉。让 4G 保持诚实的不是更严的网络判据，而是更小的投机集合（即 ①），而后者在 iOS Safari 这种**完全没有可用网络 API** 的地方同样成立。web 路径和平台探测两边各有一条测试钉住这个边界。

### 14.3 ④ 设置里的「省流量」开关

自动判据的补集：`navigator.connection` 在 iOS Safari / Firefox / 所有 iOS 内嵌浏览器里都不存在。**这里不要猜链路**——测吞吐会答错问题（快的 LTE 既快又计费），干脆让玩家自己说。全平台生效、不依赖任何 API、不可能猜错。开关写 `nw_data_saver`，`shouldSkipPrefetch()` 里优先级最高（marks 也压不过它）。

**次日生效**：本次会话的预取链在玩家走到设置界面时早已决定甚至跑完，字节已经花掉了；这个开关管的是**之后的会话**，不做中途取消。

布局上它是**标签 + 开关同一行**（不同于周围的分区），因为它挤在语言按钮和 Help/Account（0.73h）之间的空档里，堆叠式放不下。该场景**每个分区的 y 都是 h 的手调分数、无滚动无流式布局**，所以碰撞不会被推开、只会**默默画在邻居身上**——`test/ui/settingsDataSaverRow.ui.ts` 因此断言的是几何关系（4 种视口 × 3 种语言），而不是「标签在不在」。

### 14.4 实测

新档（从没开过世界地图/抽卡）：控制台 `[prefetch] not warming (never opened): slg:world, gacha`，`static/` 请求里**没有** 2002 KB 的 `world_atlas.png`、也没有 gacha 那批图。写入两个标记后重载：world atlas 恢复预取。两个方向都在真实运行的客户端里验过。

> ⚠ **设置界面没有截图核对**：本轮 Browser pane 不显示（`screenshot` 一直超时）。改用几何断言覆盖，见 14.3 —— 对「不同宽高比下会不会重叠」这个具体风险，几何断言反而比一张截图更强，也每次 CI 都在跑。反向验证过（把行挪到 0.72h 制造重叠，4 个视口全红）。

### 14.5 遗留

- §13.6 第一条（world atlas 无条件预取）由本节 ① 解决；**编码仍然不能动**（§13.5）。若哪天世界地图必须对所有人预热，剩下的路仍是按 §6.12 的原话砍帧/砍尺寸。
- 使用标记只有「用过 / 没用过」，没有时效。一个玩了一次 SLG 就再不碰的账号会一直预热那 2.0 MB。加个「最近 N 天」窗口是显然的下一步，但在有数据说明这值得之前不做——现在这版已经把最坏情况（从没进过的人）解决了。

## 15. 补测试：把三处约定变成被检查的不变量（2026-08-25）

§13/§14 落地后复核覆盖，发现四处缺口。共同点是**都不是"逻辑没测"，而是"约定只写在注释和文档里"**——而本文档记的两次事故（§13.1 缓存头、§13.5 误判中间产物）恰恰都是「文档说了、代码没做」或「约定存在、无人检查」造成的。

### 15.1 `client/src/assets/` 无孤儿（`test/assetsAreShipped.test.ts`）

§13.5 的根因修复（把 `res_atlas` 挪进 `art/`）让「没人 import ⇒ 没用」重新成立，但**没有任何东西阻止下一个中间产物再放回来**。现在每个 `client/src/assets/` 下的资源文件逐个断言「至少被某个模块引用」。

失败时**不是 lint 错误而是设计问题**，且只有两个正确答案：这文件属于 `art/`（它是管线产物），或者应该有人 import 它（它是被重构孤立掉的真美术，现在正静默地没出现在游戏里）。

顺带覆盖了 `.hires` 约定的另一半：`foo.hires.png` 是靠 webpack `NormalModuleReplacementPlugin` 按约定解析的、**没有字面 import**（所以要豁免），但一个 `foo.png` 已经不存在的 `.hires` 文件就是真孤儿——静默、且读代码看不出来。

### 15.2 缓存策略门禁（`scripts/checkCachePolicy.mjs` + `test/cachePolicyGate.test.ts`）

§13.1 修好了 `_headers`，但**修好之后同样没有东西防止它再退化**。新增门禁读**产物** `dist/`（不是意图），CI 里跟体积门禁并排跑，断言四件事：

1. 每个 contenthash 文件都被某条规则以 `immutable` + `max-age≥1y` 覆盖；
2. `index.html` / `version.json` 仍然回源校验，且**绝不** immutable；
3. **没有任何文件被两条 `Cache-Control` 规则同时命中**——这是核心不变量，因为 CF 是**逗号拼接而非覆盖**；
4. contenthash 产物确实在 `static/` 下（`output.filename` 被改回根目录就会红）。

### 15.3 两个门禁自己的变异测试

`claudedocs` 里已经记过这条教训（「gate 脚本自己要做变异测试」），而 §13.4 加体积门禁时我没照做。现在两个脚本都加了 `--dist=` / `--budget=` 参数，纯粹为了让测试能拿 fixture 目录喂它们，**逐条断言"该红的时候真的会红"**：

- `cachePolicyGate.test.ts`（11 例）：`_headers` 整个缺失（**production 当时的真实状态**）、hash 文件没规则、规则不是 immutable、`/*` + `/index.html` 重叠、index.html 被 immutable、产物跑出 `static/`、多 splat 图案、注释/空行、以及 favicon 这类固定名文件**不该**被要求有规则。
- `bundleSizeGate.test.ts`（9 例）：三个预算各自超标、背景层 preload **不**计入 L0 闸门、**没有构建时必须响亮失败**（"什么都没量到"绝不能读成"没有超标"）、preload 插件没跑、指标缺预算条目、index.html 引用了不存在的文件。

> 写这批测试时踩到一个值得记的坑：「超预算」那条 fixture 最初用 `i * k % 256` 生成"不可压缩"的字节，**周期只有 256，brotli 直接压没了**，于是 200 KB 的包压回预算内、测试因为错误的原因变绿。换成带种子的 LCG 才真正不可压缩。**给压缩相关的门禁造 fixture 时，"看起来随机"和"熵足够"是两回事。**

### 15.4 另外两处（§14 的）

- `test/ui/wechatNetworkKind.ui.ts`：`wx.getNetworkType` 的字符串映射逐值断言。这个列表**已经长过一次**（`5g` 是后加的），而映射把新值悄悄放错桶不会报错、只会做出更差的决定。另测两条失败路径（`fail` 回调、API 直接抛）都必须 resolve 成 `unknown`——`shouldSkipPrefetch()` 会 await 它，reject 会把整条预取链带下水。
- `test/ui/settingsDataSaverRow.ui.ts` 新增点击路径：此前只证明了这行**画得出**当前状态，没有任何东西证明**点了有用**——而一个 hit rect 没注册、或注册在错坐标的开关，在截图里完全正确。改为走场景真实的 `hits` 列表触发，位置也一并被断言。

四条新守卫全部反向验证过（放一个假中间产物进 `assets/`、删 `_headers` 那条规则、把 `host.hits.push` 摘掉、把行挪到 0.72h——各自对应的用例都变红）。

---

## 16. `icons_atlas` 重打包：最后一张调色板合并页 + 8 帧死重量（2026-08-27）

三张合并页（§8）都是 `mergeAtlasPages.js` 用 `png({ compressionLevel: 9, effort: 10 })` 写出来的，而 sharp 0.32 里 **`effort` 单独一个就会把 pngsave 切到 8-bit 调色板量化**。`world_atlas` 2026-08-19 修掉、`decor_merged_atlas` 2026-08-20 修掉，`icons_atlas` 一直留着——理由是它被 30+ 场景文件引用，blast radius 最大，留给专项。本节是那个专项。

### 16.1 量化到底损了多少（先量再改）

把三个源子图集（equipment 12 帧 / material 3 帧 / factions 2 帧）重新无损生成一遍，逐像素跟线上那张 `icons_atlas.png` 比：

| | 数值 |
|---|---|
| 与真源不同的像素 | **368,647 / 376,832（97.8%）** |
| 其中 alpha>0（真正会显示的） | **119,859** |
| 最坏单通道偏差 | **254 / 255** |
| 最坏 **alpha** 偏差 | **63 / 255** |

比 decor 那页记录的 12–38 更狠（那页内容少、色域窄）。**这不是"肉眼看不出所以无所谓"**：alpha 偏 63 就是抗锯齿边缘的实体崩坏，只是没有基准图就没人能指着它说话——所以本轮的验收标准写成「合并页里每一帧必须与其无损中间产物**逐字节相等**」，做完确认 17/17 全等。

### 16.2 顺带清掉 8 帧死重量

页里原有 25 帧，第四组是 `avatarAtlas.ts` 读的 8 张白线图（`book`/`trophy`/`swords`/`castle`/`pencils`/`globe`/`coin`/`home`）。`presetAvatarArt.ts` 用 20 张独立胸像 PNG 取代它们、`avatarAtlas.ts` 已删——但**帧还在页里躺了几周**。

为什么没人发现：这张图集没有任何消费者枚举帧名（`createAtlasLoader.frameNames()` 全仓库只有 decor 那页在调用），三个活着的消费者都是显式 key 查找。**不可达的帧不报错、不渲染、只花启动字节和纹理内存**——静默得连"退化成程序化 glyph"这种可观测症状都没有。

新的守卫因此断言的是**缺席**（`RETIRED_AVATAR_FRAMES` 不在页里）+ **帧集合恰好等于三组活帧**，而不是只断言活帧存在——只断言存在的话，未来一次 re-merge 把死帧塞回来照样全绿。

### 16.3 打包宽度：字节涨了，纹理内存降了 74%

`patchMergedAtlas.js` 的 reflow 原来钉死 `MAX_WIDTH = 2048`（抄的 `world` 组）。shelf packer 只在"下一块放不进去"时才换行，所以**上限远宽于内容时会摊成一长条**：17 帧在 2048 下packs 成 `1946×388`，利用率 49.9%。本轮给它加了 `--max-width=<n>`，扫了一遍取最优：

| | 旧（线上） | reflow @2048 | reflow @520（采用） |
|---|---|---|---|
| 画布 | 2048×768 | 1946×388 | **520×778** |
| 利用率 | — | 49.9% | **93.1%** |
| PNG 字节 | 166 KB | 240 KB | **294 KB** |
| 解码后纹理 | 6.00 MB | 2.88 MB | **1.54 MB** |

**字节涨了 128 KB，纹理内存降了 74%。** 这个取舍对这一页尤其成立：它是 §11.2 阻塞层里唯一的 atlas，而 ADR-073 之后纹理字节才是被预算管着的那个量；手机上 6 MB 一张常驻纹理正是那份 OOM 账单里的条目。测试里因此钉的是**面积预算**（`w*h*4 < 2.2 MB`）而不是字节预算——字节这次是**变大**的，钉字节会把这次改动本身钉红。

`--max-width` 的教训写进了脚本头注释：**上限不是目标值，reflow 一页时要扫一遍**，最优值跟这一组当初 merge 用的宽度没有关系。

### 16.4 连带修的四处

- **`mergeAtlasPages.js` 的 `effort: 10` 根因还在**（三页都是靠 `patchMergedAtlas.js` 事后逐页转正的，产生它们的那行从没改）。已改成只留 `compressionLevel: 9`——否则复活 `mergeAssetAtlases.js` 或新加一组就会再造第四张调色板页。
- **`pack_faction_atlas.js` 写的是量化 PNG**，注释还写着「trivially safe，全是白线只有 alpha 变化」。实测不成立：量化 vs 无损差 92.8% 像素、alpha 偏到 8/255、单通道偏到 255（量化器完全可以给一个近透明的白挑一个黑色调色板项）。**「能装进 256 项」和「sharp 的量化器会挑那 256 项」是两个命题。** 这份产物 072131d8 之后就不再发布了，量化只会把损失烧进真正上线的合并页、在那边省不到一个字节，所以改成无损。
- **`art/ui/{equipment,material}/build-atlas.js` 的 `requireSharp()` 从来解析不到 sharp**：候选路径写的是 `dist/index.cjs`，而这仓库装的 sharp 0.32 入口是 `lib/index.js`——两个候选全落空后会 fall through 到一个没有 `package.json` 的 `ROOT_DIR` 上跑 `npm install`。也就是这两个 builder 一直**跑不起来**。改成 require 包根、让 node 读 `main`（与 `patchMergedAtlas.js` 同一顺序）。
- **`mergeAssetAtlases.js` 的 `icons` 组** 删掉已不存在的 `avatars/` 源。

### 16.5 一个被实测否掉的顺手改动

`build-atlas.js` 两个 builder 都用 sharp 的 `composite()` 拼图，而 08-19 的教训明确说「永远不要用 `composite` 摆帧」（premultiply→取整会让每个抗锯齿边缘像素偏 1–2）。本来打算一并换成 memcpy，先量了一下：equipment 图集 composite vs memcpy 差 16,590 像素（8.44%），但**其中 alpha>0 的只有 590 个、最大偏差 1/255，alpha 偏差 0**——剩下那 16,000 个全是 alpha=0 的完全透明像素（composite 把它们的 RGB 归零，raw resize 保留源 RGB；PIXI 走 premultiplied alpha，这些 RGB 不参与显示）。

**结论：这里不值得改**，并且现在有了量出来的理由而不是感觉。教训是通用规则也要按位置定量——同一条 `composite` 警告在"往一张已有内容的页上盖帧"时是硬伤（会透出旧图 + 边缘漂移），在"往空画布上摆互不重叠的块"时只剩 ±1。

### 16.6 `boot.gate` 预算被这次改动顶红了——处理方式与留下的下一步

§13.4 的体积门禁**立刻抓到了这次改动**：`boot.gate` 822.4 KiB / 800.0 KiB（102.8%），正好是 `icons_atlas` 涨的那 128 KiB。门禁自己给的建议是「先问什么变大了、以及它非得变大吗」，以及「正确答案通常是 `BACKGROUND_STEPS` 或 L1，而不是抬预算」。

**这次选择抬预算，抬到 850 KiB——而且新余量比旧的更紧**（比当日实测 822.4 高 3.4%，旧的是比 694.2 高 15%）。理由：

- **它非得变大**。变大的原因是停止量化，而量化本身是 bug（§16.1）。这不是 bloat，是一处修正的固有代价。
- **同一次改动把这一页的解码纹理从 6.00 MB 砍到 1.54 MB**。付出的是 ~128 KiB **一次性、走 CDN、本地缓存**的传输字节，换回 4.5 MB **常驻**显存——而 ADR-073 之后后者才是被预算管着的量。
- **新余量刻意留得比以前紧**，等于把旧 reason 那句话说得更硬：这一层现在贴近真实上限，**下一次增加不该再靠抬预算**。

**留下的下一步（本次刻意不做）**：把 `icons_atlas` 从阻塞层挪进背景层。三个消费者本来就全都能退化成程序化 glyph（`equipmentAtlas`/`materialAtlas`/`factionIcon`），所以不会坏；缺的是像 §11.2 给三兵 `.tao` 配 `ensureBattleAssets` 那样，在真正画这些图标的入口（装备背包 / 卡牌详情 / 抽卡揭示 / 各种奖励行）补一次 re-await，**或者**明确接受首次打开时闪一下程序化 glyph。这是一次**启动行为**变更、需要它自己的画面核对，不该捆在一次重打包里——记在这里当作下一次这一层再顶红时的第一选项。

### 16.7 验收

- `client/test/ui/iconsAtlasEncoding.ui.ts`（新增 7 例）：三组活帧齐全 / 帧集合恰好等于活帧且不含 8 个退役帧 / 无零面积帧 / cell 尺寸 128·256 / 每帧落在 `meta.size` 声明的画布内 / 面积预算 < 2.2 MB / PNG 非调色板且 PNG 与 JSON 的画布一致。
- **变异验证**：拿 `png({effort:10})` 原地重新量化 → 「非调色板」那条变红；往 JSON 里塞回 `coin` 帧 → 「帧集合」那条变红。（还原用文件副本，不走 `git checkout`——见 `claudedocs/worktrees.md` 那条陷阱。）
- 全量：client `tsc --noEmit` 干净 / `vitest run` 197 文件 2054 例全绿 / `test:ui` 236 文件 2230 例全绿 / `build:web` 通过 / `check:bundlesize`·`check:cachepolicy`·`check:filelength` 三道门禁全绿。
- **画面核对**：见 §16.8。

### 16.8 顺手修掉一处与本任务无关、但挡住验证的红（CardScene 守卫在 Windows 上恒红）

跑全量时 `client/test/cardSceneTabSwitchGuard.test.ts`（当天早些时候刚落地）是红的，而且跟本任务毫无关系：它报出来的「违规行」正是 `list.ts` 里**解释这个守卫的那句注释**。根因是 `text.split('\n')` 在 CRLF 检出上留下尾部 `\r`，而 `\r` 是 ECMAScript LineTerminator，于是 `$` 锚定的剥注释 `replace` 一个字符都没剥掉——**这个守卫在 CI（LF）永远绿、在每个 Windows 检出上永远红**。改成 `split(/\r?\n/)`，并反向验证过「真塞一句 `core.tab =` 仍然抓得到、行号也对」。

修它不是扩大范围，是 ADR-066 之后 CI 红会挡住部署门禁、也挡住这次改动自己的验证。教训（一条以 `$` 结尾的逐行正则，正确性上限等于喂给它的 split）记在 [`claudedocs/client-testing.md`](../../claudedocs/client-testing.md)。

## 17. 微信开发者工具黑屏：两个独立成因（2026-09-01）

用户报「游戏在微信开发者工具里是黑屏」。查下来是**两件互不相干的事叠在一起**，而且顺序有意义：先修好的那个（资源）修完仍然黑屏，真正让第一行就抛的是第二个（canvas）。两个的共同底色是——`client/wechatgame/` 是**整个 gitignore 的**，没有任何东西保证它里面的东西彼此一致、或者和当前代码一致。

### 17.1 上屏 canvas：裸全局 `canvas` 从来不是文档接口

```
ReferenceError: canvas is not defined
    at Object.getCanvas (WechatPlatform.ts:57)
    at define.constructor (app.ts:46)
```

`WechatPlatform.getCanvas()` 一直是 `return canvas`——读那个**裸全局**。它由适配层提供，**不在小游戏的文档 API 里**；开发者工具在 2026-08-31 晚上换到 canary 基础库 **3.17.2** 之后不再提供它。于是 `startApp()` 的第一行（`new PIXI.Application({ view: platform.getCanvas() })`）就抛，一个像素都没画：**整个游戏完好地站在黑屏后面，控制台里那条错误和"游戏"两个字毫无关联**。

改成按文档的契约取：`wx.createCanvas()` 的**第一次**调用返回上屏 canvas，之后的都是离屏。所以 `resolveScreenCanvas()` 有两条承重约束，都写进了代码注释：

- **它必须是进程里第一个 `createCanvas`**。目前是：`app.ts` 在构造 PIXI 应用**之前**调 `platform.getCanvas()`，而 PIXI 的 `settings.ADAPTER.createCanvas`（`render/fastText.ts` 那条路）只在渲染期才跑。
- **必须记忆化**。不记的话第二次 `getCanvas()` 会拿到一张离屏 canvas，渲染进虚空——同一个黑屏，只是隔了一层。

回退链是「裸全局 → `GameGlobal.canvas` → `wx.createCanvas()`」，所以旧基础库（≤ 3.15）和 3.17.2 都能跑。`test/WechatPlatform.test.ts` 补 4 例（三条路径各一 + 记忆化一），变异检查过：抽掉记忆化 1 例红、再抽掉 `GameGlobal` 分支 2 例红。

`project.private.config.json` 钉的 `libVersion` 同步从 3.15.1 升到 **3.17.2**（跟上工具实际装的那版；`wx.d.ts` / `entries/wechat.ts` / `WechatAudioBus.ts` 里引用这个数的三处注释一并订正）。

> **一般化**：这条和音频那次（`AUDIO_DESIGN.md` §0.3「把自己的 `.d.ts` 当成运行时事实」）是**同一枚硬币的两面**。那次是 typing 里**没声明**的 API 被当成运行时没有；这次是 typing 里**声明了**的全局被当成运行时一定有。`declare` 两个方向都不是证据。

### 17.2 包不完整：`pixigame.js` 和 `cdn/` 来自两次不同的构建

发现时磁盘上的状态：`pixigame.js` 是当天 09:08 的（当前代码），`cdn/` 里是 **7 月 29 日**的 **57 个**文件——而那份 bundle 烘焙进去的资源引用有 **301 个**。八月那批图标/美术全换了 contenthash，于是 244 个引用在磁盘上根本不存在，L0 闸门一张图都取不到。

成因：前一轮（音频后端）收尾时只把 `pixigame.js` + `.map` **刷进主检出**，没有在主检出里跑一遍 `build:wechat`——真跑会把 301 个资源一起吐出来。两个文件时间戳精确相同、`cdn/` 一动没动，是"复制"而不是"构建"的指纹。DevTools 打开的**始终是主检出**（见 [`claudedocs/worktrees.md`](../../claudedocs/worktrees.md)），worktree 里构建得再新也没用。

新增门禁 `client/scripts/checkWechatPackage.mjs`（`npm run check:wechatpackage`，并串进 `build:wechat`），**读产物、不读意图**，查三件事：

1. **壳完整**——`game.js` 确实 `require('./pixigame.js')`、`game.json` 能解析。
2. **每个烘焙进 bundle 的资源 URL 在磁盘上都有文件**（包内相对 `cdn/<hash>` 与方案 A 的绝对 CDN URL 两种形态都认；后者本地虽然不是运行时读取处，但它就是上传集）。← 本节这个黑屏。
3. **只有一个 bundle**——出现 `<id>.pixigame.js` 同级文件说明 `asyncChunks:false` 失守（§4.0）。`test/wechatSingleBundle.test.ts` 守的是配置，这条守的是产物。

**它故意查不了的那一半**：反过来的情况——**旧 bundle 配新 `cdn/`**。微信产物跑在 `clean:false` 下（`game.js`/`game.json`/`cdn/` 必须活下来），所以历史构建的文件只会堆积不会被扫掉，旧 bundle 的 hash 仍然都在、规则 2 照样通过。孤儿文件数因此只报数不报错——任何一次重建之后它都不为零。

`test/wechatPackageGate.test.ts` 12 例，每条规则配一个**恰好破坏它**的 fixture（门禁自己也要做变异测试）。另外拿**真实产物**复现过一次事故现场：把 301 引用的 bundle 配上 57 个资源的 `cdn/`，门禁报「251 of 301 baked asset URLs have no file」——证明那条正则在真 bundle 上有效，而不只是在手搓 fixture 上。

### 17.3 验证与欠账

- 全量：client `npm run typecheck`（含测试工程 + fulllink）干净；`vitest run` **222 文件 2393 例**全绿（内含 `test/WechatPlatform.test.ts` 9 例、`test/wechatPackageGate.test.ts` 12 例）；`test:sim` 8 文件 13 例绿；`build:wechat` 通过且串联的门禁绿（**301 引用全在位，42 个孤儿**）。
- **画面由用户在开发者工具里核对**——这台机器上没有别的路子：`mcp__claude-in-chrome__*` 够不到 DevTools，`miniprogram-automator` 对小游戏是死路（`AUDIO_DESIGN.md` §0.3）。
- 仍然欠着 §4.2 遗留 1/2（微信后台域名白名单、`cdn/` 上传），以及**真机**——3.17.2 的这条 canvas 行为是在 Chromium 模拟器上观察到的。

### 17.4 宿主适配层：把这层依赖收归自己（当天下午）

§17.1 修好 canvas 之后，下一个报错是 `Unrecognized source type to auto-detect Resource`（`Graphics`
→ `FillStyle` → `Texture.WHITE`）。到这里性质就变了：**不是一个 API 没了，是 PIXI 依赖的整个 DOM
嗅探面没了**。用户拍板自己拿一层适配层（理由：以后出问题查得快），架构与验收条件写在
[`ASSET_PACKAGING.md`](ASSET_PACKAGING.md) §4.3/§4.4，这里只记过程里值钱的东西。

**第 1 阶段先量后写。** 新增 `platform/wechat/hostProbe.ts` + `entries/wechat-probe.ts`
（`build:wechat-probe`，永不发布），把宿主表面写到 `USER_DATA_PATH`。实测结论一句话：
**实现都在，只是没挂到全局**——`document`/`window`/`navigator`/`URL`/`WebGLRenderingContext` 都在，
`document.createElement('canvas')` 正常返回且 `constructor.name` 恰好是 `HTMLCanvasElement`，
`wx.createImage()` 的构造函数名就是 `HTMLImageElement`；缺的是 `HTMLCanvasElement`/
`HTMLImageElement`/`Image`/`OffscreenCanvas`/`ImageBitmap`/`createImageBitmap`/`fetch`/`DOMParser`/
`XMLHttpRequest`/`CanvasRenderingContext2D` 这些**全局类绑定**，外加裸 `canvas` 和 `document.baseURI`。

> 探针的三个出口（磁盘 / `GameGlobal` / `console.log`）不是冗余：磁盘上什么都没有时，「探针崩了」
> 和「模拟器根本没跑它」是等价的，而两者修法完全不同（AUDIO_DESIGN §0.3 同一条）。

#### ⚠️ 中途被推翻的设计，以及推翻它的那句话

第一版方案打算从 `document.createElement('canvas').constructor` 取类绑定——探针实测它可用。**错的。**
`D:\daydayup` 的 `design/04-wechat.md` 里有他们用两次线上 bug 换来的一句：

> **`document` 在开发者工具模拟器里存在，在真机上不存在。这是这个平台最有误导性的一件事。**

我的探针正是在模拟器里量的。照那份数据设计，会得到一层**在模拟器里全绿、在手机上必崩**的适配层，
而 funny 至今没在真机上跑过——**这笔费本来会由第一个真机测试的人来付**。改成一律从
`wx.createCanvas()` / `wx.createImage()` 的实际产物取类。

**这也是这轮最值钱的一般化**：探针只能告诉你「这台机器上有什么」，不能告诉你「这个平台保证什么」。
两者之差就是模拟器与真机之差。

#### 从 daydayup 抄到的其余三条（port the method, not the assets）

- **不用 weapp-adapter，实现 PIXI 官方 adapter 扩展点**——他们 v8 用 `DOMAdapter.set()`，我们 v7 是
  `settings.ADAPTER`，同一个决定。
- **`fetch` 故意不实现**。他们复核过：Assets 真上了也没有任何路径走到 `fetch`（纹理解析只在
  `createImageBitmap` 那条路上用它，而这个运行时没有 `createImageBitmap`，于是走 `createImage`）。
  落到 `fetch` 的一律是「有人想要远端资源」，那是打包边界的决定，应该响亮地失败。
- **测试 harness 要把浏览器全局真的 `delete` 掉**，而不是「碰巧没用到」。Node 自带 `fetch`/`URL`，
  留着它们，一个仍然依赖 DOM 的实现会在测试里全绿、在手机上崩。

v7 独有的两条（他们那边不适用）：`@pixi/settings` 的 `isMobile` 在**模块顶层**读
`globalThis.navigator`，所以装宿主必须是入口第一个 **import**（写在函数体里，ESM 的求值顺序决定了
来不及）；而他们踩的 `context.letterSpacing = '0px'` 毒化上下文那条，v7 关在
`TextMetrics.experimentalLetterSpacing` 开关后面（默认关），只需一条用例钉住别被打开。

#### 顺手修掉的两处真机必崩

门禁扫出来的：`render/stickman/shadow.ts` 和 `outline.ts` 直接 `document.createElement('canvas')`。
改走 `settings.ADAPTER.createCanvas`。另外三处造纹理（`fastText` 字形 atlas、影子、描边）改成指名
`CanvasResource`（新增 `render/canvasTexture.ts`）——**不该让「画面出不出来」取决于某个全局补没补上**。

#### 验证

- `test/wechatHost.test.ts` 17 例，断言的是**真实 PIXI 判定函数**（`CanvasResource.test` /
  `ImageResource.test` / `Texture.WHITE` / `determineCrossOrigin`），全局全部 delete，fake 只有 `wx`。
  变异 5 个全抓：抽掉类绑定 4 红、抽掉 `location` 2 红、嗅探另造 canvas（偷走上屏）2 红、
  `??=` 改成无条件覆盖 1 红、删掉 `Image` 工厂 2 红。
- 门禁 13 例（含扫描器自身的误报/漏报用例）。变异：往 `render/bake.ts` 塞一句 `document.body` → 红；
  同句加 `// dom-ok: 理由` → 绿。
- 全量：`typecheck`（含 fulllink）干净 / `vitest run` 225 文件 2490 例 / `test:sim` 8 文件 13 例 /
  `test:ui` 253 文件 2428 例 / `lint` 0 error / `build:wechat` + 包门禁绿（323 引用全在位）。
- **画面仍未由人确认**：适配层落地后重新构建过，但开发者工具里那一眼只有用户能看
  （`mcp__claude-in-chrome__*` 够不到 DevTools）。§4.4 第 3 条的真机验证同样开着。

## 18. REST 走 `wx.request`：一个接缝，不是一个 `fetch` polyfill（2026-09-01）

§17.4 把渲染层的宿主依赖收归自己之后，[`ASSET_PACKAGING.md`](ASSET_PACKAGING.md) §4.4 只剩三条欠账，第 1 条是**整个 REST 层在微信上完全不通**：`net/ApiClient/core.ts`、`net/WorldApiClient/core.ts`、`net/anomaly/reporter.ts`、`analytics/{config,queue}.ts` 一共 6 处直接调 `fetch`，而小游戏运行时没有这个全局。`ApiClient/core.ts` 的注释里记着现状：「微信云同步与合规一起排期，当前 `SaveManager` 降级本地存档」——**但降级的其实不止云存档**：埋点、异常上报、SLG/社交/拍卖的每一次请求，在微信上都是一次同步抛出的 `ReferenceError` 或一个静默的 no-op。

### 18.1 两种形状，以及为什么选了后一种

| | (a) 在 `wechatHost` 里补 `globalThis.fetch` | (b) 在 `net/` 抽一个 transport 接缝 |
|---|---|---|
| 改动面 | 一个文件，REST 层一行不改 | 新增 2 个文件 + 6 个调用点 |
| 契约 | 必须假装是 `fetch`（stream / redirect / `Request` 对象 / cookie jar / `Response` 全套） | 五个字段的 `NetRequest` + 四个成员的 `NetResponse`，**能满足的那部分才写进契约** |
| 对其余代码的影响 | 翻转全图的特性探测 | 无 |
| 门禁 | 6 处只能靠 `// dom-ok:` 放行 | 6 处消失 |

选 (b)。三条理由里第二条是决定性的，也是当初没想到的那条：

1. **一个只做得到一半的 `fetch` 正是 §4.3 要终结的东西。** `wx.request` 没有 stream、没有 redirect 模式、不认 `Request`/`Headers` 对象、没有 blob、没有 cookie jar。把它挂到 `fetch` 这个名字下，就是重新制造 2026-09-01 黑屏的那个形状：代码读一个宿主全局，拿到一个**几乎**对的东西，到真机上才发现差在哪。一个五字段的具名接缝是我们真能兑现的契约。
2. **它会翻转整张图的特性探测。** `typeof fetch === 'function'` 在本仓库里就是活分支（`analytics/queue.ts` 的 unload 路径当时正靠它分流），第三方库里更多，PIXI 的 Assets 也是这么挑 loader 的。装上全局 `fetch` 等于把这些分支统统改道到 HTTP——**包括最终会走到资源 URL 上的那些**。而「包内文件不该走 HTTP」这条边界（`WechatAssetIO` + 故意抛错的 `wechatPixiAdapter.fetch`，§17.4）就再也守不住了：它现在能成立，靠的正是这个运行时**没有** `fetch`。
3. **门禁会失明。** `test/wechatHostSurface.test.ts` 扫的是可达图里的裸 `fetch(`。走 (a) 的话这 6 处一个都不会消失，只能逐个加 `// dom-ok:`——欠账清单就变成了它自己头注释里警告的那种白名单。

(a) 唯一的卖点「REST 层不用改」在这里也不值钱：6 个调用点里有 2 个是 `core.ts` 的共用 transport 辅助方法，另外 4 个是 fire-and-forget 的遥测发送，改动总量就是六处。

### 18.2 落地

- **`client/src/net/transport.ts`**：`NetRequest`（`method`/`url`/`headers`/`body?`/`signal?`/`keepalive?`/`credentials?`）→ `NetResponse`（`ok`/`status`/`json()`/`text()`）。默认实现是 fetch 的，**把原来各调用点手搓的 init 对象一字不差地搭回去**（可选字段是省略而不是给 `undefined`），所以 web 侧零回归、仓库里所有假 `fetch` 的测试一句不用改。`NetResponse` 是 `Response` 的子集，因此 web 路径直接把原对象递回去，不包一层。
- **`client/src/platform/wechat/wechatTransport.ts`**：`wx.request` 实现。四处真实差异写在文件头的表里——① 字段名是 `header` 不是 `headers`（写错的话请求照发、只是一个头都不带，鉴权全线失效）；② `dataType` 默认 `'json'`，**它替你 parse 且失败时静默把字符串原样给回来**，于是一次 502 的 HTML 错误页会变成 `json.ok === undefined`，所以必须显式要非 `'json'`，parse 留给 `json()` 做、与 `fetch` 一样在非法 JSON 上抛；③ 取消桥到 `RequestTask.abort()`，且**由我们先 reject** 再 `abort()`（`abort()` 之后 wx 回不回调 `fail`、`errMsg` 长什么样都是运行时细节，先 reject 才能保证语义和 web 完全一致）；④ 没有 cookie jar，`credentials:'omit'` 天然成立。
- **装配**：`entries/wechat.ts` 加 `setNetTransport(new WechatTransport())`，与 `setAssetIO`/`setAudioBus` 并排——同一条惯例，且**与 `setAssetIO` 那行是两条路，注释里点明了别混**。
- **超时只有一个来源**：调用方自己的 `AbortController` + `setTimeout`（ADR-058 的 metaserver 10s、`WorldApiCore.req` 的 per-call `timeoutMs`）一字未动，transport 只负责把 signal 接到 `RequestTask` 上。`rateGate` 同理留在调用方，于是微信这条路**自动**继承了 5 req/s 的全局限速。

**顺手删掉的一处死代码**：`analytics/queue.ts` 的 `flushSync` 原本是「有 `fetch` 就 keepalive fetch，否则 `navigator.sendBeacon`」。那个 fallback 在每个平台上都是死的——web / CrazyGames / 套壳都有 `fetch`（没有的话资源加载器先垮），而唯一真没有 `fetch` 的运行时（微信）**也没有 `sendBeacon`**，所以这个方法在微信上一直是个静默 no-op。现在它走 transport，微信上第一次真的发得出去，而且不像 beacon 那样丢掉 `Authorization` 头（那正是 2026-08-24 记的那个「2848 条 `session_end` 无一可归属」的坑）。对应的那条用例改成断言「没有 fetch 的运行时里，装上的 transport 收到了带鉴权头的请求」。

### 18.3 门禁与验证

- **`test/dom-usage-baseline.json`：54 → 45 处**（21 → 17 文件）。删掉 `analytics/config.ts`、`net/ApiClient/core.ts`、`net/WorldApiClient/core.ts`、`net/anomaly/reporter.ts` 四条，`analytics/queue.ts` 6 → 3。「基线不许留过期项」那条本来就会为此报红，所以这不是可选动作。`wechatHostSurface.test.ts` 里的总量上限同步从 54 拧到 45——**还完一批就往下拧**，否则上限自己会变成新的垃圾桶。剩下的 45 处里 30 处是 §4.4 第 2 条那批隐藏 `<input>`。
- **`test/wechatTransport.test.ts`（18 例）**：harness 与 `wechatHost.test.ts` 同一个范式——`fetch`/`document`/`window`/`navigator`/`localStorage`/`XMLHttpRequest` 等在整轮测试期间从 `globalThis` 上**真的 delete 掉**，fake 只有 `wx`。所以最后那三例（真 `ApiClient` 跑通 login、错误信封解成 `ApiError`、ADR-058 的 10s 超时把 `RequestTask` abort 掉）是有分量的：它们跑在一个**没有 fetch 的进程**里，能绿就说明那条链路真的不碰 fetch 了。
- **`test/netTransport.test.ts`（9 例）**：接缝本身 + 「REST 层真的经过接缝」——最后两例装一个假 transport 再断言**全局 `fetch` 一次都没被调用**。这条是给未来的人留的：哪天有人图省事把 `fetch` 写回 `ApiClient`，在 Node 里（自带 fetch）所有既有测试都会照绿，只有真机会崩。
- **变异测试（9 个，全红）**：`header`→`headers`（2 红）、`dataType`→`'json'`（1）、抽掉 `task.abort()`（2）、抽掉「signal 已 aborted 就一个包都不发」（1）、`json()` 不再 parse（5）、抽掉重复 settle 的守卫（1）、`keepalive` 改成无条件写键（1）、不转发 `signal`（1）、以及把裸 `fetch` 塞回 `ApiClient/core.ts`（DOM 门禁 1 红）。
- **全量**：`typecheck`（含 fulllink）干净 / `vitest run` **227 文件 2518 例** / `test:sim` 8 文件 13 例 / `test:ui` 253 文件 2428 例 / `lint` 0 error（2 条既有 warning，与本次无关）/ `build:wechat` + 包门禁绿（323 引用全在位）。

### 18.4 仍然欠着

- **`wx.request` 的「request 合法域名」白名单**，与 `downloadFile` 的是**两份**（§4.2 遗留 1）。配不上就是全线 REST 挂掉；开发者工具能勾「不校验合法域名」绕过，真机不行——所以这条会精确地在真机上第一次现形。
- **微信云同步本身**仍与合规一起排期：桥通了不等于 `SaveManager` 就该上云，`getApiBaseUrl()` 在微信构建里目前也还没注入。这次只把「没有传输层」这个物理障碍搬开。
- **真机**（§4.4，2026-09-01 晚间盘点后的唯一一条）。以上全部只在 Node 测试与 Chromium 模拟器上成立。

## 19. 14 处隐藏 `<input>` → `IPlatform.openTextInput`（2026-09-01）

§18 把 REST 层的 `fetch` 收归 `net/transport.ts` 之后，[`ASSET_PACKAGING.md`](ASSET_PACKAGING.md) §4.4 只剩一条真正的功能缺口：**14 个场景直接 `document.createElement('input')` 收文本**——登录名/密码、聊天、家族/宗门创建表单与频道发言框、拍卖行买家 ID 与价格编辑、SLG 首府改名、申诉/反馈弹窗。这段代码不是「没适配微信」，是**微信上完全不通**：小游戏运行时没有 `document`，14 处调用点原样跑起来就是 14 个 `ReferenceError`（有一处，`LoginScene.setupHiddenInput()`，此前干脆用 `typeof document === 'undefined'` 整段跳过——效果是微信玩家永远打不开登录框，静默失效比抛错还隐蔽）。

### 19.1 抽成 `IPlatform` 的一个能力，不是一个模块级接缝

`assetIO()`/`netTransport()`/`audioBus()` 都是模块级单例（§6、§18.2）——这条不跟：文本输入的调用点全部在场景类里，而场景已经通过各自的 `XxxSceneCallbacks` 接口拿 `IPlatform` 的能力（`hasRewardedAd`/`showRewardedAd` 是先例），不需要再造一条独立的全局接缝。`IPlatform.openTextInput(opts): ITextInput` 直接加成 IPlatform 的方法，WebPlatform/CrazyGamesPlatform/WechatPlatform 三个实现各自满足：

```ts
interface TextInputOptions {
  value: string; maxLength: number; password?: boolean;
  confirmType?: 'done' | 'next' | 'search' | 'go' | 'send';
  onInput(value: string): void;
  onConfirm?(value: string): void;   // Enter（web/CrazyGames）/ 系统键盘 Confirm 键（微信）
  onComplete(): void;                // 会话结束——无论因为谁关的
}
interface ITextInput { setValue(value: string): void; close(): void; }
```

`onConfirm` **不自动关闭输入**（web 一个纯 `<input>` 按 Enter 本来就不会自己 blur），微信侧同理把 `wx.showKeyboard` 的 `confirmHold` **恒定传 `true`**（永不自动收起）——两端行为对齐，「按 Enter 后是否关闭」完全由调用方的 `onConfirm` 自己决定要不要调 `close()`，不需要在接口里塞一个 `confirmHold` 选项分叉两条平台语义。14 个调用点原来的行为分两类，迁移时逐一保留：LoginScene/ChatScene（Enter 不关闭，允许继续编辑/连续发送）、FamilyScene/SectScene 发言框与拍卖数字编辑器/首府改名（Enter 提交并关闭）。

Web/CrazyGames 的实现集中到 `client/src/platform/web/domTextInput.ts`（`openDomTextInput`）——12 个场景文件里原本几乎逐字重复的一段「建 `<input>` → 定位到屏幕外 → 挂 `input`/`keydown`/`blur` 监听 → `focus()`」样板收成一个函数，两个平台类各一行转发。这个文件躺在 `platform/web/` 下，天然在 `wechatHostSurface.test.ts` 的 `OFF_PATH` 排除范围里（跟 `WebPlatform.ts` 自己一样），是仓库里唯一一处「该碰 `document`」的新文件。

FriendsScene 的 `chrome.ts` 早就有一个自己的 `openHiddenInput(core, opts)` 内部封装（8 个调用点共用），这次只改它的实现体去调 `core.cb.openTextInput`，8 个调用点的签名一个字没动。

### 19.2 微信侧：`wx.showKeyboard` 家族，一次只有一个会话

`wx.showKeyboard`/`updateKeyboard`/`hideKeyboard` + `onKeyboardInput`/`onKeyboardConfirm`/`onKeyboardComplete`（小游戏原生 API，基础库 2.1.0+，跟小程序 `<input>`/`KeyboardInputComponent` 组件完全是两套东西——这个运行时没有 DOM 可以挂那些组件）。`client/src/wx.d.ts` 里没有这几个声明——按本仓库的教训（AUDIO_DESIGN §0.3、§4.3）这不代表运行时没有，`WechatPlatform.ts` 照惯例自己声明一个只含本文件用到的字段的局部 `declare const wx`，不碰那个文件。

真正的坑：`onKeyboardInput`/`onKeyboardConfirm`/`onKeyboardComplete` 是**全局**监听器——wx 的 API 里没有「这次回调属于哪个会话」的标识，跟「一次只能有一个键盘」这个事实本身是匹配的（一个 `<input>` 抢焦点也只有一个）。`WechatPlatform` 因此只在首次 `openTextInput()` 调用时装一次这三个全局监听（`wireKeyboardListenersOnce`），路由到 `this.activeTextInput` 指向的那个会话；`openTextInput()` 自己在打开新会话前，如果上一个还开着就先关掉它（触发它的 `onComplete`）——跟聚焦一个新 `<input>` 会 blur 旧的是同一个语义。`close()`（调用方主动关）和全局 `onKeyboardComplete`（原生键盘被关，无论是用户划走还是我们自己调的 `hideKeyboard()`）两条路径都会触发 `onComplete`，用一个 `closed` 标记 + `this.activeTextInput` 的身份检查保证只触发一次——`close()` 自己关闭时立刻把 `activeTextInput` 置空并直接调 `onComplete`，随后到达的 `onKeyboardComplete` 因为找不到匹配的活跃会话而空转。

**已知限制，写进代码注释而不是留着不说**：`TextInputOptions.password` 在微信侧没有对应物——`wx.showKeyboard` 没有掩码输入这个概念，字符会明文显示在系统键盘的预览里。今天唯一传 `password: true` 的是 LoginScene 的密码字段，而微信从不走 LoginScene（`wx.login` 直接换 openid，见 `getAuthCredential`），所以这是一个潜在缺口而不是活的缺口——真要有人在微信上加了密码输入的路径才会现形。

### 19.3 一次性顺手清理

- **FriendsScene `openHiddenInput` 的 `placeholder` 参数是死代码**：设在一个 `opacity:0`、定位到屏幕外的 `<input>` 上，浏览器渲染的 placeholder 文字从来没人看得到——真正的占位文案走的是同一个 tap handler 里另一次调用的 `caretText()`（画在 canvas 上）。迁移时直接删掉这个参数，8 个调用点都没传过它。
- **ShopScene 的 Enter-to-redeem 不再需要「先建后补听」的两段式构造**：旧代码里 `ShopSceneCore` 构造时就建好隐藏 `<input>`（`setupHiddenInput()`），但 Enter 键的处理要等 `ActionsPanel` 造出来才能接线，所以 `ShopScene.ts`（外层装配）在 `new ActionsPanel(...)` 之后单独 `core.hiddenInput?.addEventListener('keydown', ...)` 补一刀。新模型下输入会话是「用户点了才开」（`focusPromo()` 惰性打开），点击发生的时刻装配早就完成了，`onConfirm` 直接在 `focusPromo(onConfirm)` 里当参数传下去即可——`ShopScene.ts` 那段外部补线代码整段删除。
- **FeedbackDialog 的 submit 成功路径原本只清了镜像状态 `feedbackText`，没清底层 `<input>` 的真实值**：连续两次提交、中间不重新聚焦的话，第二次输入会把已提交的文字和新内容拼在一起（DOM 层面从未清空过）。这个 bug 一直存在，只是没人踩到过（多数人提交后会重新点一次输入框）。这次经手顺便用新拿到的 `ITextInput.setValue('')` 补上，不算范围蔓延——修复点和迁移点是同一行代码。
- **`world.nationNamePrompt` i18n key** 只喂给了那个从未渲染的 placeholder，三语言文件一并删除（`i18n-no-dead-keys.test.ts` 会抓不然会报死键）。

### 19.4 门禁与验证

- **`test/dom-usage-baseline.json`：15 处 / 5 文件**（原 21 文件 / 54 处落地时的口径；§18 已把 REST 那批还清到 17 文件 / 45 处，这次再还清 12 文件 / 30 处，剩下的 5 文件 15 处全部是 `analytics/`、`PixiAppViews.ts`（web-only 的 sketch demo 入口探测）、`assetIO.ts`/`ota.ts` 两个「平台默认实现」——跟本次改动无关，是各自独立的欠账）。§4.4 从两条欠账收成一条：只剩「真机从未验过」。
- **`test/WechatPlatform.test.ts` 新增 `openTextInput` 一节（17 例）**：`wx.showKeyboard` 拿到正确的 `defaultValue`/`maxLength`/`confirmHold:true`/`confirmType`；`onKeyboardInput`/`onKeyboardConfirm` 路由到当前活跃会话；原生 `onKeyboardComplete` 触发一次 `onComplete` 且脱钩会话（之后的杂散 input/complete 事件不再命中）；`close()` 调 `hideKeyboard`、触发一次 `onComplete`，重复调用与随后到达的原生 `onKeyboardComplete` 都不会二次触发；`setValue()` 转发到 `updateKeyboard`，`close()` 后变 no-op；打开新会话会先关掉（并触发其 `onComplete`）旧会话。
- **12 个场景文件逐一改完**，配套测试同步：`familyChannelInput.test.ts`/`familySendButton.test.ts`/`sectActions.test.ts`/`shopActions.test.ts` 里手搭的假 `document`（`document.createElement`/`addEventListener`）换成新建的 `test/harness/fakeTextInput.ts`（记录每次 `openTextInput()` 调用的 `TextInputOptions`，返回一个契约与真实实现一致——`close()` 幂等、`setValue()` 关闭后 no-op——的假 `ITextInput`）；5 个 `test:ui` 文件（`caretRegression.ui.ts`/`dialogModalInputGate.ui.ts`/`familyIncrementalRepaint.ui.ts`/`sectIncrementalRepaint.ui.ts`/`auctionScene.ui.ts`）改成把真实的 `openDomTextInput` 接到既有的假 `document` 上（这几个文件本来就在无 DOM 的 headless Node 环境里跑，假 `document` 早就在，只是原先直接喂给场景自己的 `document.createElement` 调用；现在喂给 `openDomTextInput`，断言方式基本不用改，除了 `AuctionScene` 那批需要从 `core.hiddenInput`/`core.textInput`（现在存的是不透明的 `ITextInput` 句柄）改成从假 `document` 自己的 `createElement` 记录里取最近一次创建的假元素）。
- **全量**：`typecheck` 干净 / `vitest run` 229 文件 2572 例 / `test:sim` 8 文件 13 例 / `test:ui` 253 文件 2428 例 / `build:web` + `build:crazygames` + `build:mobile` + `build:wechat`（含 `check:wechatpackage` 包门禁）全部绿。`test:e2e` 需要活的 metaserver/gateway/matchsvc/gameserver/commercial + Mongo 全栈（`server/dev-up.ps1` 或 docker compose 起），这次会话环境里没有对应可达的地址，**没有跑**——纯客户端改动，`test:e2e` 覆盖的是编排/网络逻辑而非本次触碰的场景/平台层代码，风险可控但记在这里而不是假装跑过。
- **真实浏览器人工核对**（`mcp__claude-in-chrome__*`，非 in-app Browser 面板）：SettingsScene 改名框（键入镜像、确认关闭）、FeedbackDialog 多行输入框（键入镜像、caret）两条路径截图确认符合预期。

### 19.5 仍然欠着

- **真机**（唯一一条，见 §4.4）。`wx.showKeyboard` 一次只有一个会话这条设计假设，以及「新会话打开时是否会让 wx 自己也补发一次 `onKeyboardComplete`」这个边界情况（本节 19.2 提到的 focus-steal 竞态），都只在这份代码审查 + 单元测试层面成立，从未在真机或开发者工具里点过一次。

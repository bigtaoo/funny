# Notebook Wars — 资源打包补测/复核/重打包记录（spec 见 [`ASSET_PACKAGING.md`](ASSET_PACKAGING.md)）

> 从 `ASSET_PACKAGING.md` 拆出（2026-08-29，ADR-067 单册形态：hub 原位留同号 stub + 箭头，不建索引表）。§1–§14（当前架构：三层分级/各平台打包方案/首屏加载策略/预取策略）仍在 hub；本册是 §15（补测）与 §16（icons_atlas 重打包）两节的逐条记录，小节编号与正文一字未改。

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

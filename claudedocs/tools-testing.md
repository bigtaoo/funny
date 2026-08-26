# 工具链（`tools/`）测试与覆盖率快查

> 五个工具：`animator`(9091) / `level-editor`(9092) / `ops`(9093) / `vfx-editor`(9094) / `map-editor`(9095)，外加 `desktop-shell`（Electron 壳，仅 build）。
> 相关：覆盖率工具本体见 [`server-testing-tooling.md`](server-testing-tooling.md) 「测试覆盖率百分比工具」；animator 自身的模块/测试细节见 [`animator.md`](animator.md)；口径拍板见 [ADR-070](../design/DECISIONS_ADR-070-onward.md#adr-070-tools-覆盖率口径-scoped-include-与-reported-not-gated-过渡--accepted--2026-08-20)。

## 怎么跑

```bash
cd tools/<tool> && npm test                 # vitest run
cd tools/<tool> && npm run test:coverage    # 同上 + coverage/（v8）
cd tools/<tool> && npm run typecheck        # tsc --noEmit -p tsconfig.test.json
cd tools/<tool> && npm run lint             # eslint .（2026-08-26 新增）
```

权威的**跨包**覆盖率数字来自仓库根（读的是各包刚产出的 `coverage/`，跟 CI 同一份脚本）：

```bash
node scripts/coverageSummary.mjs          # 报表，永不失败
node scripts/checkCoverageThreshold.mjs   # 门禁，低于门槛/缺产出则退出 1
```

`desktop-shell` 没有测试基础设施（1 个依赖的 Electron 壳），**不在**任何覆盖率清单里；它的 `tsc -p tsconfig.json`（即 `npm run build`）就是它的类型检查。**也刻意不给它写单测**（ADR-071）：539 行全是 Electron 主进程接线（`BrowserWindow`/`ipcMain`/`autoUpdater`/`git` 调用），要测就得把整个 Electron 面 mock 掉，断言的是 mock 而不是它的行为。它受的约束是**可达性闸门**（2026-08-21 接入，见下），那条不需要跑它。

## 四条 CI 闸门

| 闸门 | 范围 | 语义 |
|---|---|---|
| 单文件 500 行 | `tools/` 全树（`.ts`/`.tsx`，排除 `test/`、`scripts/`、`dist/`） | `tools/scripts/checkFileLength.mjs` 薄封装转调根 `scripts/checkFileLength.mjs`；只在**新文件**越过 500 行、或 `tools/scripts/file-length-baseline.json` 里的已知文件**继续变大**时判红。2026-08-13 (G4) 起 |
| 覆盖率 | 5 个工具包 | 报表 + **产出必须存在** + **百分比受 90% 门禁**，跟 13 个服务端 workspace 与 `client` 完全同待遇。ADR-070 的「reported, not gated」豁免存在了不到一天：4a–4e 依次毕业，名单空掉，机制随 4e 退休（ADR-070 收尾条）。2026-08-20 起 |
| 可达性 | 5 个工具包各自的 `src/**` | `tools/scripts/checkUnreachableModules.mjs`（逐包调用根 `scripts/checkUnreachableModules.mjs`）：**任何一个 `src/` 下的源文件，若从该包的 bundler entry、`--extra-root` 声明的兄弟产物目录（animator 的 `runtime/`）、以及 `test/**` 这三类根出发都到不了，判红**。2026-08-20 起 |

| ESLint | 5 个工具包各自的 `src/**` | 各包 `eslint.config.mjs`，规则共用仓库根 `eslint.shared.mjs`（跟 `client/` 和 `server/` 同一份）。error 判红。`desktop-shell` 不在内（跟它不在测试/覆盖率名单里同理）。2026-08-26 起 |

覆盖率那条闸门有两半，都已受门禁：
- **管路**——某个工具包不再产出 `coverage/`，`checkCoverageThreshold.mjs` 判红。这不是覆盖率回归，报错文案也刻意分开说（"produced no coverage output at all"），免得有人去找缺失的测试而真正要修的是缺失的 CI 步骤。这条分开说的措辞是 ADR-070 那轮顺带修掉的既有缺陷，**跟豁免机制无关，机制退休后保留**。
- **百分比**——5 个包各自的 scope 现在都 ≥90%（下表；四个 100%、animator 98.9%）。**过渡已结束**：`NOT_GATED_JSON_SUMMARY_PACKAGES`、行上的 `gated` 字段、报表的「reported, not gated」小节、门禁的豁免脚注全部随 Phase 4e 删除。退休的理由与验收条件写在 ADR-070 末尾那条「收尾」记录里；一句话版本是「留着一套能用的、合法地不受门禁约束的机制，本身就是一份长期邀请函」。另一样保留下来的是报表的 **`Scope (files)`** 列——那是防「缩 include 抬 %」的护栏，跟豁免无关，五个包毕业后反而更该看（三个包的 scope 只占 `src` 文件的 1/4 到 1/2）。

## ESLint（2026-08-26 新增：五个工具以前一个 lint 都没有）

背景：同日发现 `client/` 的 `npm run lint` 已经在启动阶段坏了很久而没任何 CI 步骤跑它（见 [`client-testing.md`](client-testing.md)）；修好之后更大的缺口才露出来——**client 是当时全仓库唯一有 linter 的包**，`server/` 13 个 workspace 和这五个工具都没有。

- **三处共一份规则**：仓库根 `eslint.shared.mjs` 导出 `sharedRules({ js, tseslint, prettierConfig })` 和 `sharedIgnores`。它**自己不 import 任何 plugin**——plugin 按 import 它的文件解析，而 client / server / 每个 tool 的 `node_modules` 是分开的，所以各包各自 import 再传进去。五个工具各新增了一份 30 行的 `eslint.config.mjs` + `lint` 脚本 + 5 个 devDependency（eslint / @eslint/js / @typescript-eslint 两个 / eslint-config-prettier）。**合并后主检出要在每个 tool 里补一次 `npm install`**（`claudedocs/worktrees.md` 那条「worktree 里 `npm install` 会把 junction 换成真实目录」的陷阱）。
- **首跑只有 6 个问题，level-editor / ops / map-editor 直接全绿**。这个数字本身是个结论：工具链虽然没 lint，但它们的 `src` 这两年跟着拆分/可达性门禁走，残留代码早就被那两道门厕干净了。
- **animator 4 个**：一个三元运算当语句用（`isPlaying ? pause() : play()`）、一个什么都没拑住的 `eslint-disable`、一个未用的 `MouseEvent` 参数，以及一个**真正值钱的发现**：`timeline/TimelineView.ts` 里的 `MoveKeyframeCommand` 类**完全没人用**——也就是说**时间轴上拖关键帧不可撤销**（`onMouseMove` 直接调 `moveKeyframe()` 并覆写 `dragKfTime`，到 mouse-up 时拖拽的原始时间已经丢了；`onMouseUp` 的注释写着「commit as Command if time actually changed」但什么都没做）。**没删，也没就地修**：删了就抹掉了这个缺口的唯一痕迹，而接上需要新增 `dragKfStartTime` 字段 + `CommandManager.pushExecuted(cmd)` 入口（现有 `execute()` 会在已经改过的 state 上重跑 `moveKeyframe`），是单独一件事。类头上的注释把这些写清了 + 一条带理由的 disable。**→ 同日晚些时候已按这份注释接完**（`pushExecuted` + `dragKfStartTime` + `endKfDrag()`，dev server 实测 undo/redo 往返正确；随后又补了一批**回归测试**——把判定抽成导出的 `getKfDragCommit` 并 `export` 掉 `MoveKeyframeCommand`，用真实 `AnimationController` 重放拖拽，`TimelineView.test.ts` 10 → 21 条），那条 disable 和 `NOT WIRED UP` 注释块一并删除，细节见 [`animator.md`](animator.md)「关键帧拖拽终于进 Undo 栈」。**这条是本轮 lint 最值钱的产出，也是它最该被记住的形状**：另外三条闸门一条都看不见它——文件不超长、`timeline/` 不在 coverage include 里、`TimelineView.ts` 本身从入口完全可达（可达性闸门判的是**文件**，不是文件里的**符号**），而 `tsc` 默认不报未使用的**顶层声明**（`noUnusedLocals` 只管函数内的局部变量）。「定义了但从未被构造的类」此前在 `tools/` 里没有任何自动化能发现。
- **vfx-editor 2 个**：一个未用 import，一个 `prefer-const` 是规则弄错了——`index.ts` 的 `let effectList` 必须先声明后赋值（Library 的回调闭包引用它，`effectList?.refresh()` 的 `?.` 就是防回调提前触发），改 `const` 要么 TDZ 抛错要么得重排代码。已在共用配置里改成 `['error', { ignoreReadBeforeAssign: true }]`（这正是该规则为这种形状提供的选项），其余 prefer-const 能抓的照旧报。

## 可达性闸门（2026-08-20 新增）

起因是 animator 那 1424 行死码（见下方「已知遗留」）：它**同时躲过了另外两条闸门，且是构造性的**——每个文件都不到 500 行（行数闸门看不见），又全在 coverage `include` 之外（受门禁的百分比看不见）。当初是有人恰好手跑了一次 import 遍历才发现的，靠运气；现在那次遍历变成了常驻闸门。

- **判定口径刻意宽松**：只要**任何一个根**能到达就算活的，**包括测试文件**。「只有测试 import 它」不是死码，那是另一件（弱得多的）事，本闸门不表态；只有「全仓库没有任何东西提到它」才判红。
- **解析顺序是承重的**：`./x` 必须先试 `x.ts`、再试 `x/index.ts`。animator 那张死图正是靠这一点自闭合的（死的 `renderer.ts` 里 `from './skeleton'` 命中死的 `src/skeleton.ts`，而不是活的 `src/skeleton/Skeleton.ts`）——**顺序反了，整张死图会被判成活的**。这条有专门的测试钉住，把脚本里的顺序调过来它就红。
- **`--extra-root` 是必需的逃生口**，不是可选装饰：animator 的 `runtime/StickmanRuntime.ts` 在 `src/` 外、没有任何 entry import 它，不把 `runtime/` 声明成根，它拉进来的文件会全体误报。误报一旦大到让人烦，闸门就会被关掉——所以这条也双向钉了测试（不给 `--extra-root` 必须红，给了必须绿）。
- **canary**：扫到 0 个文件 / 0 个根，或者 entry 找不到，都直接判红——否则「什么都没扫」和「什么问题都没有」印出来是同一句 OK。
- **测试**：`server/shared/test/reachabilityGuard.test.ts`（15 例，与 `guardScripts.test.ts`/`coverageScripts.test.ts` 同一手法：spawn 真 CLI、断言退出码 + stdout、跑一次性 fixture 目录树）。最后一例是**真仓库集成**——直接跑 `tools/` 的封装、断言 6 个包全 OK（2026-08-21 起含 `desktop-shell`，并额外断言它那三个 `--entry` 根逐字出现），因为封装里包名写错、漏了 animator 的 `--extra-root` 或漏了 desktop-shell 的某个 preload 根，前 14 例全绿也照样什么都没守住。两条承重断言都做过 red-then-green 实测（把解析顺序调反 → 顺序那例红；把 import 正则改成不跨行 → 跨行那例红，**顺带把真仓库集成例也带红了，因为 ops 里真有一处跨行 import**）。

**`desktop-shell` 已于 2026-08-21 接进来（ADR-071）**，此前写的「不适用」（Electron main/preload 对，没有单入口 web bundle）复核后不成立：闸门判的是**根与 import**，不是 bundle。它的根是三个而不是一个——`src/main.ts` 是真入口，两个 preload 由 Electron 按路径字符串加载（`main.ts` 里 `preload: path.join(__dirname, 'preload.js')`），没人 import 它们，所以要用 `--entry` 声明成根，否则它们和它们独占 import 的东西会全体误报（跟 animator 的 `runtime/` 需要 `--extra-root` 是同一类逃生口，只是这三个都在 `src/` 下）。接进来之后 9 个文件全部可达。**它恰恰是最该被这条闸门管的包**：`tools/` 里唯一以周为单位不动的（上次改动 2026-07-28），又不在任何 coverage `include` 里，也就是另外两条闸门同样看不见它。反向验过：往 `src/` 扔一个 10 行死文件，闸门报 `1/6`。

**这条闸门管不到什么**：`client/`、`server/` 都不在范围内（多入口，模型不适用）。

## 覆盖率口径：scoped `include`

跟 `client` 同一套做法（`client/vitest.config.ts` 的 `coverage.include` 只圈 `src/game/**`，PIXI 渲染层出界）：每个工具的 `coverage.include` 是**它的 `vitest.config.ts` 头注释自 2026-08-13 起就用文字描述过的那个纯逻辑层**的机器可读形式，不是「现在哪块覆盖率高」挑出来的。out-of-scope 的一律是 DOM/PIXI 构造接线（这些编辑器都没有 headless-PIXI harness）。

### 台账（2026-08-20 实测）

| 包 | `coverage.include` | scope 内行覆盖 | 全包行覆盖 | 距 90% 要做的事 |
|---|---|---|---|---|
| `level-editor` | `state/**`、`layout/**`、`units.ts` | **100.0%** (445/445)、函数 64/64 | 25.7% | **✅ 已接门禁（Phase 4b，2026-08-20）**。坐标/命中数学 + 原本埋在 `resize()`/`onMove()`/`onWheel()`/draw 方法里的纯决策已从两个面板类移进新的 `src/layout/{board,timeline}.ts`（纯层：一格/一个 block 在屏幕哪儿、光标下是什么、什么颜色、路径怎么走），`src/board/`+`src/timeline/` 从此均质地是 DOM 那半。scope 216 → **445** 行（ADR-070 原估 ~600，见下方「4b 实测」）。同日加了 `pureLayerBoundary.test.ts` 守边界 |
| `map-editor` | `state/**`、`tiles/**`、`i18n.ts`、`constants.ts` | **100.0%** (652/652)、函数 62/62 | 38.3% | **✅ 已接门禁（Phase 4a，2026-08-20）**。`isoGrid`/`tileStyle` 已从 `render/` 移进新的 `src/tiles/`（纯层：一格在屏幕哪儿 / 长什么样），`include` 回到目录级，包也从 `NOT_GATED_JSON_SUMMARY_PACKAGES` 移进 `JSON_SUMMARY_PACKAGES`。同日补完最后 8 行（150 例），并加了 `pureLayerBoundary.test.ts` 守边界——见下方「覆盖率百分比守不住目录边界」|
| `vfx-editor` | `model/**`、`io/**` | **100.0%** (529/529)、函数 76/80 | 40.4% → **47.2%** | **✅ 已接门禁（Phase 4c，2026-08-20）**。`io/IOController.ts`（74 行）0% → 100%——它没有浏览器依赖挡路，缺的只是一个测试文件。`rendering/Playback.ts` 这个**本仓库最后一个逐文件 include 项**也去掉了：Playback 是编辑器状态而非渲染器，已移进 `src/model/Playback.ts`，`src/rendering/` 从此均质地是 PIXI 那半。同日加了 `pureLayerBoundary.test.ts`，但**形状跟 4a/4b 不同**——见下方「4c 实测」|
| `animator` | `core/**`、`skeleton/**`、`animation/**`、`io/**` | 64.3% → **98.9%** (1426/1442)、函数 191/195 | 29.5% → **42.9%** | **✅ 已接门禁（Phase 4d，2026-08-20）**。五个里唯一**一行结构改动都没有**的：include 从 ADR-070 落地那天起就是目录级，64.3% 是因为它刻意把整个没测过的 IndexedDB 层留在 scope 内。`io/{AutoSaveController,ProjectStore,IOController}.ts` 0% → 100%、`animation/AnimationController.ts` 41.3% → 100%、`core/AppState.ts` 81.5% → 100%、`skeleton/Skeleton.ts` 89.0% → 100%、`io/editorProject.ts` 71.4% → 100%。测试 138 → **340 例**。同日加了 `pureLayerBoundary.test.ts`，**形状又跟前三个都不一样**——见下方「4d 实测」|
| `ops` | `logic/**`、`api/**` | **100.0%** (1516/1516)、函数 100%、分支 99.87% | 8.8% → **35.4%** (1516/4286，`src/**` 口径；分母涨了是因为纯层拆出 25 个新文件、`pages/*` 反而变薄) | **✅ 已接门禁（Phase 4e，2026-08-20，最后一个）**。原来**根本没有 include**（报全包 8.8%，322/3639，仓库最差）——不是疏忽：Phase 3 导出的 9 个纯函数各自嵌在一个 90% 是 `h()` DOM 的 `pages/*.ts` 里，没有目录可指，缩到 `src/api/**` 又是一个测试不加就把数字抬上去。现在每页一个 `src/logic/<page>.ts`（该页的查询构造、校验、pivot、权限判定、派生文案），`pages/*` 只剩 DOM 装配；`src/api.ts` 并进 `src/api/index.ts`（`src/api/**` 这个 glob 匹配不到 `src/api.ts`）。同日加了 `pureLayerBoundary.test.ts`，**两层判据**——见下方「4e 实测」|

**Phase 4a 实测（2026-08-20，`map-editor`）**：搬 `isoGrid`/`tileStyle` 是**零行为改动**的搬移——production bundle 逐 token 比对，两侧各只有 25 个独有 token，全部是 webpack 的确定性 module id（模块路径集合变了必然重排）与 contenthash 本身，无任何代码/字符串差异（581751 → 581765 字节）。所以这类 graduation **不要指望 contenthash 相同**（那是 animator 删死码那次能用的证据，因为那次模块集合只减不改名）；能用的是 token 集合对比。顺带一并搬走的还有 `TerrainTextureName` 类型：它原来定义在 PIXI 的 `render/terrainAtlasLoader.ts` 里，纯层要用就得 `import type` 一个 PIXI 模块（运行期无害，但边界读不出来），现在类型归 `tiles/tileStyle.ts`、loader 反向 import。~~**接门禁之后边界是自守的**~~ —— **这句话是错的，同日订正，见下一节**。

**Phase 4b 实测（2026-08-20，`level-editor`）**：同一手法、同一天。这个包的退出条件是「把已导出的 12 个坐标/命中函数抽成独立纯模块」，但只搬那 12 个的话 scope 撑不起来——所以**顺手把还埋在 `resize()`/`onMove()`/`onWheel()` 和 draw 方法里的纯决策一起提了出来**（board 的 `fitCell`/`headerFor`/`activeHandles`/`crossPathPoints`/`escortPathPoints`，timeline 的 `blockRect`/`unitTickXs`/`blockLabel`/`gridStepSec`/`visibleSecondRange`/`snapAtTick`/`zoomAround`/`panBy` 等），这跟 2026-08-13 Phase 4 提那 12 个是同一类动作。顺带消掉两处真重复：`gridStepSec`/`visibleSecondRange` 原本在 `drawTimeGrid` 和 `drawRuler` 里逐字写了两遍；一个 block 的**右边界原本被算两次**（`drawBlocks` 当宽度、`hitTest` 当 `x1`，两个不同表达式），现在 `blockRect` 是唯一定义、`hitTest` 打它，并有一例专钉「点在画出来的边上必须命中」——抽模块顺手合掉重复，比只搬位置值钱。

- **scope 216 → 445 行（100%，函数 64/64），不是 ADR-070 表里估的「约 600」**。600 那个数得当成估计值改掉而不是去凑：剩下的差额是面板类的绘制代码本身，那按定义就是 DOM 那半边。`Overall (gated)` 93.9% → **94.0%**（15 → 16 个包），豁免段降为 3 个工具。测试 77 → **135 例**；`test/{BoardPanel,TimelinePanel}.test.ts` 改名成 `test/layout{Board,Timeline}.test.ts`（它们测的是 `src/layout/*`）。
- **行为不变的证据同样用 token 集合对比**（别指望 contenthash，理由同 4a）：字符串字面量 506 → 506，仅两条模板串因插值变量被压缩改名而不同，无任何文案/颜色变化；标识符 −8/+16 全部可解释——消失的 8 个是那 7 个 `this.` 方法名（原本是不可 mangle 的类成员，现在是模块函数）加一个 `18.2`（`Math.round(26*0.7)` 原本被常量折叠，现在藏在 `headerFor()` 后面，值仍是 18），新增的 16 个是 12 个新 mangle 名 + `secondX` + `startSec`/`endSec` 解构。**踩过的坑**：朴素的 `"字符串"|标识符` 正则交替在转义引号处会级联错位、报出两百个假 diff；得用真扫描器（逐字符走、跟踪字符串/模板状态）。
- **顺带退休了 `tools/scripts/file-length-baseline.json` 的唯一条目**：`BoardPanel.ts` 543 → **430 行**，`checkFileLength.mjs` 自己会打印「可以删这条」的 housekeeping 提示。该文件现在只剩 `_readme`（闸门在空 baseline 下正常工作，实测 `0 tracked in baseline` 仍绿）。

**为什么剩下的低分留着**：include 清单刻意把已知未测的文件圈在里面（最典型的是 animator 那两个 0% 的 IndexedDB 文件，它把该包从 100% 拉到 64.3% 整整半年——**而 Phase 4d 就是去把它们测掉，不是把它们移出 include**，这条论证到此走完了一个完整闭环）——缺口是要干的活，不是要定义掉的东西。反过来，`ops` 只要把 include 缩到 `src/api/**` 就能把印出来的数字抬上去，**一个测试都不用加**，这是覆盖率门禁最不该奖励的事，所以它宁可挂着 8.8% 的全包数字。

**Phase 4c 实测（2026-08-20，`vfx-editor`）**：这个包的退出条件只写了「补 `io/IOController.ts`（74 行 0%）」，实做时另一半才是有内容的那半——**去掉本仓库最后一个逐文件 include 项** `rendering/Playback.ts`。4a 的判断是「逐文件 include 是缺模块边界的味道」，先验证前提：`Playback.ts` 只有 `t`/`playing`/`duration` 加 `Math`，无 PIXI/canvas/DOM，rAF 循环从外面读它、它从不反向伸手——它不是渲染器，是**编辑器状态**。于是移进 `src/model/Playback.ts`，`src/rendering/` 只剩 `PreviewRenderer.ts`（均质地是 PIXI 那半），依赖方向单向 `model/ ← rendering/`，`include` 回到 `['src/model/**','src/io/**']`。测试 114 → **136 例**，scope 内 84.9% → **100.0%（529/529）**，全包 40.4% → **47.2%**，`Overall (gated)` 94.0% → **94.1%**（16 → 17 个包）。

- **purity 守卫在这个包必须换判据，不是换条目**。`src/io/**` 在受门禁的 scope 里，而它**理应**用 `window`/`document`/`localStorage`/`indexedDB`/`Blob`/`URL`——持久化和文件交换就是它的活。照抄 level-editor 的「一律禁 DOM 全局」要么是假话，要么只能把 io/ 挤出 scope，而后者正是 ADR-070 拒绝的「把缺口定义掉」。所以判据换成本包真正那条线：**能不能 headless 跑**（scope 内每个浏览器 API 都有真替身：IndexedDB → `fake-indexeddb`、window/document/localStorage → `vi.stubGlobal`、Blob/URL → Node 自带，下载出来的 blob 用 `node:buffer` 的 `resolveObjectURL` 读回来验字节；`new PIXI.Application` 一个都没有）。落成**两层、一套机制**：`src/model/**` 一律禁 DOM，`src/io/**` 只许一份显式白名单的 global（其余照禁：全部 `HTML*Element`、canvas/rAF/observer 一族、`performance`）。白名单是**预算不是描述**——往 io/ 加一个浏览器 API 就得改这份清单，那正是该说清「它怎么 headless 测」的时刻。
- **另外两条断言前两轮没有**：①**依赖方向** `io/ → model/` 单向（`model/` 不许 import `io/`）——两个目录都受门禁，`include` 本身给不出方向；②`coverage.include` **不许再出现逐文件项**——4c 刚去掉最后一个，加回来得先过这条，而不是当一行小改动溜进去。六条断言各做过 red-then-green（含「io/ 里放 `requestAnimationFrame` 判红、而 `document` 放行」这条，专门证明两层是活的，不是一层伪装成两层）。
- **「百分比守不住边界」第三次独立复现**：余量 = `529/0.9 - 529` = **58 行**（4a 72、4b 49）。实测往 `src/model/` 放一个 **5 行** DOM 探针，`All files` 99.06%、**门禁照过**，守卫当场红。
- **行为不变的证据这次是逐字节相同的 bundle**（contenthash `442ad037…` 不变，562501 字节），但**别把它当成新规则**：原因是这个包的产物里**根本没有 module id**——整张图被 scope hoisting 折成一个模块，562KB 产物里 `__webpack_require__` 出现 **0 次**，模块路径没进产物。4a/4b 的产物有 module id 表，所以那两次 hash 必变。判据是「产物里有没有 module id」而不是「有没有搬文件」：`grep -c __webpack_require__ dist/bundle.*.js` 为 0 才能拿 hash 当证据，否则退回 token 集合对比。
- **补完最后 6 行时发现一条真空白**：`ProjectStore` 的首次运行 `onupgradeneeded`（新用户必走的第一条路）**从没被任何测试走过**——`ProjectStore.test.ts` 的 `beforeEach` 用裸连接重置状态（`deleteDatabase` 会挂），而那条裸连接顺手把库和 object store 建好了，等被测类打开时 store 已存在。修法是单开一个测试文件（vitest 按文件隔离 → `fake-indexeddb/auto` 是全新空库），并把「库尚不存在」这个承重前提**写成断言**，文件隔离哪天关掉它会红，而不是继续绿着什么也不证明。**这类「重置逻辑顺手把被测的初始化路径做掉了」的空白，覆盖率报表是能看见的**（那几行就是红的），代价是得去看，而不是只看总百分比。
- **明确不补**：剩下 4 个未覆盖**函数**全是 IndexedDB 的 `onerror`/`onabort` reject 回调；碰到它们得把 `fake-indexeddb` 换成对被测 API 自身的 mock，买一个数字丢掉测试意义。门禁只看行覆盖率（仓库既有约定），理由写在 `vitest.config.ts` 注释里，免得下一个人当成漏掉的活。
**Phase 4d 实测（2026-08-20，`animator`）**：五个里**未覆盖行最多**的一个（515 行），也是唯一**不需要抽模块**的一个——`coverage.include` 从 ADR-070 落地那天起就是四个目录，64.3% 纯粹是缺测试。补法就是照着未覆盖行从大到小写：`io/AutoSaveController.ts`（132 行 0%）、`io/IOController.ts`（73 行 0%）、`io/ProjectStore.ts`（66 行 0%）、`animation/AnimationController.ts`（141 行未覆盖）、`io/editorProject.ts`（52 行）、`core/AppState.ts`（22 行）、`skeleton/Skeleton.ts`（10 行）、`io/fileIO.ts`（3 行）。测试 138 → **340 例**，scope 内 64.3% → **98.9%（1426/1442）**，函数 191/195，全包 29.5% → **42.9%**，`Overall (gated)` 94.1% → **94.2%**（17 → 18 个包），豁免段降为 1 个（`ops`）。

- **`fake-indexeddb` + fake timers 的分工，是这轮唯一的硬约束**。`ProjectStore.test.ts` 跑真（内存态）IndexedDB，照 vfx-editor 的先例；但 `AutoSaveController` 的每一条有意思的行为都绕着那 1500ms debounce 转，**必须** `vi.useFakeTimers()`，而 fake timers 和 `fake-indexeddb` 混用会直接挂死到 hook 超时（`fake-indexeddb` 自己的异步模拟也排在真计时器上，被接管后再不会被排到——`animator.md` 早就记过这个坑，vfx-editor 的 `Library.test.ts` 撞过同一面墙）。所以 `AutoSaveController.test.ts` 用一个内存态 `FakeStore`（ProjectStore 自己的正确性已经在它自己那份文件里用真 IndexedDB 钉过了），顺带还能数写入次数。**两份文件的分工写在各自头注释里**，免得下一个人「统一一下」把 ProjectStore 那份也换成 FakeStore（那就没人测真 IndexedDB 了）或者给 AutoSaveController 换成真库（那就挂死）。
- **`IOController.test.ts` 的 mock 方向是反的，这是故意的**。`editorProject.test.ts` 什么都不 mock、跑真 JSZip + 真 AppState；`IOController.test.ts` 反过来把 `editorProject`/`taoExport` 两个流程模块整个 mock 掉。因为拆分之后（771 → 123 行）这个类**只剩三件事**：五个 `document.getElementById(...)?.addEventListener(...)`（id 写错就是一个静默死掉的按钮，`?.` 把它吞了）、两个 host builder 的 getter/setter 对（这是「一次 load 能清掉 `editorFilePath`、一次磁盘保存能设上它，并且真的写回 IOController 自己的字段」的唯一实现方式，类的头注释自己就这么写着）、以及「哪个入口把哪个 host 交给哪个流程」。把流程当边界 mock 掉，这三件事才第一次变得可观测。顺带钉住了 `taoExportHost` **比** `editorProjectHost` **窄**（没有 `cmdManager`，`editorFilePath`/`editorFileHandle` 只有 getter 没有 setter）——顺手加宽是这类拆分腐烂的方式。
- **DOM 判据这次是四层**（4a 一层、4b 一层、4c 两层）：`src/core/**` 和 `src/skeleton/**` 零浏览器 API（纯数据 + FK 数学，也正是 `runtime/StickmanRuntime.ts` 和客户端那份手抄件复用的东西）、`src/animation/**` 只许 `requestAnimationFrame`/`cancelAnimationFrame`（播放时钟）、`src/io/**` 一份 20 项的显式清单（磁盘/IndexedDB/File-System-Access，天然长，但**是封闭的**）。清单是**实测出来的**：写了个脚本把 impure 半边（`rendering/`、`ui/`、`interaction/`、`timeline/`、`images/`、`App.ts`、`index.ts`）用到的 global 减去 pure 半边用到的，差集就是 `FORBIDDEN_GLOBALS`（`PIXI`、`CanvasRenderingContext2D`、`ResizeObserver`、`MouseEvent`/`WheelEvent`/`KeyboardEvent`、`HTML{,Div,Button}Element`、`Node`、`confirm`），它**独立于**每个目录的白名单再判一次——把某个目录的白名单放宽，也不可能顺带把 PIXI 放进来。
- **animator 是唯一一个 scope 内必须跨界 `import type` 的包，而这跟 4a 的判断不矛盾**。`io/{IOController,editorProject,taoExport}.ts` 的 host 接口要指名真实的 `ImageController`，而那个类为了建纹理确实 import 了 `pixi.js`。4a 的做法是把 `TerrainTextureName` **搬出** map-editor 的渲染器（一个配色/贴图名类型不该住在 PIXI 模块里）；这里被指名的**本身就是那个持有 PIXI 的类**，没有东西可搬。所以守卫把「值导入」和「类型导入」分开判：值导入白名单只有 `jszip` + 纯目录内部，类型导入额外允许**恰好一个** specifier（`../images/ImageController`），并且**专门有一条断言禁止把它改成值导入**——那会把 pixi.js 拉进这层的产物里，却读起来像「这个模块本来就允许」。
- **多一条前三轮没有的断言：`runtime/` 只许伸进受守目录**。animator 是唯一有 `src/` 外产物的工具（`runtime/StickmanRuntime.ts`，也正因此是可达性闸门里唯一需要 `--extra-root` 的包）。它 import `core/types`、`animation/interpolate`、`skeleton/Skeleton` —— 也就是说「纯层保持 PIXI-free」在这里不是抽象偏好，而是「第二个产物编得过」的前提。断言钉住这条兄弟产物永远只伸进受守的四个目录，新加一处伸手就得先有守卫覆盖它。
- **「百分比守不住边界」第四次复现，而且这次量级本身就是重点**：余量 = `1426/0.9 - 1442` = **142 行**（4a 72、4b 49、4c 58）。1442 行的 scope + 98.9% 的覆盖率，等于门禁能吞下一个中等大小的 PIXI 面板一声不响。实测两次：往 `src/animation/` 放一个 **10 行** PIXI+DOM 探针 → `All files` 98.34%、门禁过；把同一个探针撑到 **143 行** → `All files` **90.08%**、**门禁还是过**，而守卫的三条断言（值导入、目录 DOM 层、renderer/UI 黑名单）当场全红。前三轮的探针是 13/10/5 行，因为那三个包的余量只够那么大——**余量是随 scope 大小和覆盖率一起长的，别把前几轮的「小探针」当成上限**。
- **red-then-green 做了两轮，第一轮有 4 处照绿**。除了守卫自己的 7 条断言（PIXI 值导入、跨界类型导入、类型导入改值导入、纯目录改名 canary、`coverage.include` 加第五个目录、`runtime/` 伸出界、`codeOnly()` 不再剥字符串）各做一次，还写了个小脚本对**生产代码**做 16 处单点变异、跑对应测试文件、再还原。第一轮 12 红 4 绿，四处照绿各有各的原因，值得分类记下来：
  - **两处是「断言了结果，而结果被两条机制共同保证」**：`AutoSaveController` 的 `remove()` 和 `flushNow()` 里的 `clearTimeout` 删掉后测试照绿，因为两条路径最后都会经过 `setActive()`/flush 把 `dirty` 清掉，残留的计时器醒来只会撞上 `if (!this.dirty) return`。改法是断言**机制**而不是结果：`expect(vi.getTimerCount()).toBe(0)`。「写入次数没变」在这里两个版本完全一样。
  - **一处是「同一份东西被深拷贝了两次」**：`pasteKeyframe` 的深拷贝删掉后照绿，因为 `copyKeyframe` 进剪贴板时已经拷过一次，所有「改源关键帧不影响粘贴出来的」断言都还成立。真正被第二次拷贝挡住的是「同一份剪贴板粘两次，两个关键帧共享同一个 bones Map」——补上「粘两次、改其中一个、断言另一个不变」才红。
  - **一处根本不该被「测出来」**：`computeDefaultShadowSize` 的 `Math.max(4, …)` 地板对固定 11 骨骼的 rig 不可达（w≈54 → `ceil(w*0.3)`≈16）。原来的断言把整个表达式（含地板）照抄了一遍，看着像覆盖了地板，其实什么都没钉。改成只断言真能区分版本的那半（0.3 比例）+ 一句「地板对本 rig 不可达」的注释——同 map-editor 的 `clampPan`/`lerpHexColor` 那一类。**门禁只看行覆盖率，这一行是覆盖的；缺的是能区分两个版本的输入，而固定 rig 给不出。**
- **顺手订正了两处文档谎**（都是写测试才发现的，零行为改动）：①`Skeleton.computeNaturalHeight` 的注释说「没有 clip 时返回 0（表示未知）」——不对，`scan(new Map())` 是无条件跑的，空 clip 列表返回的是静息姿的高度（实测 169.007），`: 0` 那条兜底要求 rig 完全没有竖直跨度，固定 11 骨骼给不出。**`client/src/render/stickman/skeleton.ts` 那份手抄件抄的是同一句错话**，而两份注释各自都写着「与另一份保持同步」，所以两边一起改（同 4a 发现 map-editor 抄漏了 `lerpHexColor` 的「故意留着」那句）。②`tools/animator/vitest.config.ts` 的头注释说 Phase 4d 是「把 `pointToSegmentDist`/`getKfColors` 抽成独立模块」——ADR-070 里的 4d 其实是本轮这个测试缺口；那个抽取没有排期，注释已改成如实描述。
- **行为不变的证据这次最省事**：本轮生产代码的唯一改动是一句 JSDoc 注释，压缩后不进产物，所以既不用 token 对比也不用比 hash。**但别把「这轮不用比」当成通例**：4a/4b 必须比 token（有 module id 表，hash 必变），4c 可以比 hash（scope hoisting 折成单模块、产物里 `__webpack_require__` 出现 0 次），判据见 4c 那条。
- **可见性核对退化成数值核对**（Browser 窗格不 composite，截图 5s 超时，同 2026-08-20 删死码那次）：dev server 起在 **9191**（默认 9091 被 Docker Desktop 双栈占着，`localhost:9091` 会返 200 但那不是 webpack），在**主检出**的 `.claude/launch.json` 加一条临时配置（`preview_start` 只读主检出那份），收尾时删掉。核对内容刻意选了跟本轮测试同构的那条链路——**自动保存的真实往返**，因为它同时跑真 IndexedDB、真 JSZip、真 `AutoSaveController`/`ProjectStore`/`IOController`：①空库开机 → 自动建 `Untitled`（`crypto.randomUUID` 的 id）并落盘；②`btn-project-rename` → **`meta.name` 变、`updatedAt` 变、blob 字节数不变（984 → 984）**，即真的是 `putMeta` 而不是 `put`；③`btn-project-new` → 新 uuid + 新 blob，旧工程不动，下拉按 `updatedAt` 倒序重排（`Brawler, Archer`）；④**debounce 契约**：1.5s 窗口内连打三次编辑（新建 clip + 两次打关键帧），窗口内 `updatedAt` **一次都没变**，窗口后只变一次、blob 从 1034 涨到 1048；⑤切工程 → 另一个工程的 clip 列表里没有 `probe-clip`，切回来完全恢复，`localStorage` 跟着当前工程走；⑥**刷新页面 → 恢复上次工程（Brawler）连 `probe-clip` 一起**。全程 `error-toast` 为空、控制台无 error。主 canvas 仍是 0×0（不 composite → rAF 不触发 → PIXI ticker 冻结，未修改版本表现一样，不是回归）。核对完把探针工程从 IndexedDB 清掉了。

**Phase 4e 实测（2026-08-20，`ops`，最后一个）**：唯一一个**没有 include 可以先缩**的包，所以结构改造不是「把已导出的东西搬个位置」，而是先造出一个逻辑层来。每页一个 `src/logic/<page>.ts`，`pages/*` 只剩 DOM 装配；另外多做两件事：①`src/api.ts` → `src/api/index.ts`（`src/api/**` 这个 glob **匹配不到 `src/api.ts`**，不合并就得在 include 里加一条逐文件项，正是 4a/4b 拔掉的那个味道；所有 `from '../api'` 的 importer 一行没改，走目录 index 解析）；②`app.ts` 的 NAV 表提进 `src/logic/nav.ts`——`app.ts` 的 import 会把 21 个 page 模块连带整个 DOM 半边拉进来，所以「谁能看见哪个页面」这条唯一的权限渲染规则毕业前根本没法在测试里碰。scope **1516 行 100%**（函数 100%、分支 99.87%），`Scope (files)` 25/53，测试 121 → **615 例**，`Overall (gated)` 94.0% → **94.4%**（19 个包）。

- **`fmtTime` 刻意没进纯层**，这是一条判据而非疏漏：它无 DOM 依赖，但输出是 `Date#toLocaleString`（跟 runner 的 locale/时区绑定），测试只能写成 `expect(fmtTime(x)).toBe(new Date(x).toLocaleString())` 这种同义反复。所以纯层里凡是**围着时间戳造句**的函数（`flagMetaText`/`shopMetaText`/`overlayMetaText`/`auditResolvedByText`）改成把格式化函数当参数收——句子留在纯层、可测（传 `ms => 'T'+ms` 的桩），环境相关的那一步留在 DOM 半边。为了把一行拉进 scope 而搬一个环境相关的格式化器，是拿数字换真实性。
- **端点面测成一张表**：`test/api.test.ts` 78 行，每行是 `{动词, 路径, body, reply, returns}`——即「谁被 `encodeURIComponent`」「哪个 query 参数是**省略**而不是发空值」「响应从哪个 key 解包」。外加一条 canary：`Api.prototype` 上每个公开方法都必须在表里出现，第一次跑就抓到漏掉的 `logout`。`environment: 'node'` 下装 `fetch`/`localStorage`/`location` 三个桩就能跑整个 transport——这件事本身就是「api/ 是 transport 层而不是 DOM 层」的证据，也是守卫给它单开一层的依据。
- **抽模块合掉的真重复（第五次验证这条比搬位置值钱）**：analytics 的五段 `*_dist` 是**同一段十五行表格代码逐字抄了五遍**（差异只有列名和取哪个字段当 label）→ 一次 `distribution(rows, key)` + 一个 `shareCard()`，`pages/analytics.ts` 474 → 356 行；`x.publicId ? '#' + x.publicId : <fallback>` 六处三种 fallback → `publicIdLabel`；`name ?? id.slice(0,8)` 五处两种写法 → `adminLabel`；`${n} thing${n===1?'':'s'}` 五处 → `plural`；SLG 世界 "Close" 的确认文案两个分支各写一遍 → `worldActions()` 单一定义；moderationWordlist 把「这次写入该不该拦」问了三遍（两处内联三 kind 判断 + `checkMessage.blocked`）→ `isBlocked()`。
- **⚠️ 守卫的扫描器有两个 bug，是这个包的内容才触发的**——4a–4d 四轮全绿，并不说明它们对：
  - `importsOf` 的 `\bfrom\s*['"]` 会命中 `qs.set('from', String(fromMs))` **字符串里**的 `from`，然后把后面直到下一个引号的整行当 specifier 报越界。修法：`(?<!['"])\b` 负向后瞻。
  - `stripComments` 那两条正则（先块注释、再行注释）会把**行注释里**出现的 `src/api/**` 当成 `/*` 开头，一路吃到文件里下一个 `*/`（本包是 `logout()` 的 `/* ignore */`，四十行之外）——**整个 import 块凭空消失，扫描器报一个它根本没读到的干净文件**。交换两条正则的顺序只是把洞挪到「块注释首行含 `//`」上，所以改成了**逐字符扫描 + 字符串状态机**。跟本页 4b 那条「token 对比别用正则交替」是同一课，只是这次在注释边界上。
  - 两个都是**扫描器空转**类的 bug：报「没发现越界」和「什么都没扫」印出来一模一样。所以这个包的 canary 除了「每个受检目录都扫到文件」「importsOf 至少匹配到一条」之外，还多一条**真仓库跨行 import**——点名 `logic/auctionAudit.ts` 与 `api/index.ts` 这两个唯一的 import 写成跨行的文件，断言它们的 `../types` 被找到。总量 canary 挡不住「大部分单行 import 还能匹配、只有跨行的丢了」。
- **两层判据，不是一层**（4a/4b/4c 一层、4d 四层，这里两层）：`src/logic/**` 一个 global 都不许碰；`src/api/**` 允许 `fetch`/`localStorage`/`location` + `Response` 类型（一份**短的闭列表**，不是「非 DOM 皆可」——第四个 global 出现就该被 review 一次，因为那也是 `api.test.ts` 要多装一个桩），两者共同受「不许碰 DOM」。**并成一条会坏在两头**：取并集是放 DOM 进纯层，取交集是用规矩把 REST 客户端判成不可测。另有两条 include 结构断言：每个目录必须**恰好落在一层**（加第三个目录不分类就红），include 里**不许有逐文件项**（逐文件项是这套守卫看不进去的洞，而 `src/api.ts` 本来就是候选）。
- **`confirm` 这个字段名付了代价**：`worldActions()` 返回的确认文案字段叫 `confirmText` 而不是 `confirm`，因为守卫按**名字**禁 `confirm`，分不清属性名和 `window.confirm()` 调用。刻意保持这种钝——「需要解析才能判对的规则，就会安静地判错」。
- **门禁余量 168 行，五个包里最大**（4a 72 / 4b 49 / 4d ~140），原因正是「测试越好、能容忍的杂质越多」：scope 打满 100% 的直接结果就是 168 行的 0% 文件可以塞进 `src/logic/` 而门禁不响。**八条断言各做过 red-then-green**：纯层 DOM global、纯层网络 global、纯层跨界 import、include 加第三个目录、include 加逐文件项、纯目录改名、`importsOf` 退回引号盲正则、`stripComments` 退回两条正则。
- **行为不变的证据：这轮标识符集合不是有用的不变量**（25 个新模块，−260/+401 全是重命名与点号链重排），文档里也不假装它是。承重的是两项：**普通字符串字面量 −1 +13** 全部可解释（一对是 `v <sha>` / `v <sha>-dirty` 构建版本串；其余 12 个是抽取引入的具名判别值与字段名参数——`'settle'/'close'/'reset'/'merge'`、`'approve-self'`、五个 `*_dist` 的 key，以及 `'?'`/`'result'` 从模板串内部升成独立参数）；**模板字面量把 `${...}` 归一化后逐条相等**，只有 5/6 条不同，全部因为 `plural()`/`adminLabel()` 现在拥有了那个片段。**归一化是必须的**：不归一化的话每条含插值的模板都因为压缩后的变量名变化而"不同"，一眼看去像 87 条 diff。
- **可见性核对：两个 dev server 并排**（Browser 窗格不 composite、截图 5s 超时，同 4c/4d；端口 **9193/9194**，默认 9093 被 Docker Desktop 双栈占着——`localhost:9093` 会返 200 但那不是 webpack；临时配置加在**主检出**的 `.claude/launch.json`，收尾时删掉）。改动前后各起一份、连同一个真 admin 后端（18083），**21 个页面逐个点开，节点数与 `.err` 槽内容逐页一致**（两处 404 和一处 "social backend unavailable" 是那个后端自己的，两侧都有）。唯一差值 Audit 页 60 节点/7 行 vs 81/10——两次探测间审计日志自己多了 3 条，回头重读改动后那页也是 81/10，且两侧都恰好 7 节点/行。跨 origin 的 `localStorage` 不共享，基线那份要手工把 token 拷过去再 reload。另外派真事件跑了三条穿过纯层的链路：Word Lists 输入 `fuckery` → `"fuck" is already active via the built-in global floor, and every "fuckery" contains it`；SLG Shop cost 改 0 点保存 → `cost must be a positive number`（没有发出请求）；Analytics 的 17 个请求 query string 与 `api.test.ts` 表里的断言逐字一致、全 200。

### ⚠️ 覆盖率百分比守不住目录边界（2026-08-20 订正）

Phase 4a 的原始写法声称「接门禁之后，往 `src/tiles/`/`src/state/` 丢一个 PIXI 模块，等于往已 include 的目录里塞一个 ~0% 的文件，直接打红 90%」。**方向对，量级错**，别再照抄这句：

```bash
node -e "const t=require('./coverage/coverage-summary.json').total.lines; console.log(Math.floor(t.covered/0.9 - t.total))"
```

- 门禁的余量 = `covered/0.9 - total`。map-editor 补完测试后是 **72 行**（补测试之前是 63 行）——**测试越好，能容忍的杂质越多**，这条反向激励才是问题的根。
- 这不是理论边角：该包 16 个 PIXI/DOM 文件里**有 10 个 ≤63 行**（三个 atlas loader、`refresh.ts`、`citySprites.ts`、`viewport.ts`、`status.ts`、`i18nApply.ts`、`panels.ts`），随便哪一个搬进 `src/tiles/` 门禁都不响。
- 实测确认过：往 `src/tiles/` 放一个 13 行的 PIXI+DOM 探针文件，`All files` 掉到 96.98%，**门禁照过**。

所以边界要有自己的断言：`tools/map-editor/test/pureLayerBoundary.test.ts`（4 例）——扫 `src/state/**` + `src/tiles/**` 的源码，断言 ①import 白名单（只许 `@nw/shared/slg`、`../constants`、`../i18n` 和纯目录内部；`import type` 一个 PIXI 模块同样算越界，那正是 Phase 4a 搬 `TerrainTextureName` 的理由）②不出现任何 DOM/浏览器全局（先剥注释，免得文档里提一句就误报）③canary：每个纯目录必须扫到文件、import 正则必须至少匹配到一条（CRLF/跨行那类空转 bug）④**受检目录从 `vitest.config.ts` 的 `coverage.include` 反推**，往 include 里加第三个目录而不加守卫，这条直接红 ⑤扫描器本身在 LF 与 CRLF 下都要工作（本仓库 Windows 检出 CRLF、CI 检出 LF，正是源码扫描器「在一边空转、两边印一样的 OK」的典型场合；顺带钉住跨行 import）。五条断言都做过 red-then-green，含两个 canary（改名一个纯目录、往 include 加一项）和一个真会坏的 LF-only 正则。

**4b 独立复现了同一件事（2026-08-20）**：`level-editor` 毕业后余量 = `445/0.9 - 445` = **49 行**。这个包的 5 个 out-of-scope 文件是 196–477 行，全都大于 49——所以把**现有**任何一个搬进 `src/layout/` 确实会打红门禁。但那是这几个文件恰好都大，不是门禁的性质：实测往 `src/layout/` 放一个 **10 行**的 DOM 探针，`All files` 97.8%（445/455）、**门禁照过**，而 `pureLayerBoundary.test.ts` 当场判红。所以两件事的分工在第二个包上又验证了一次。

**结论（五个包走完之后）**：graduation 不等于边界有人守。`include` 回到目录级只是让「加文件」变得可见**给覆盖率算法**，不等于可见给门禁——门禁只看一个百分比，而百分比有余量。每个毕业的包都该配一条同形的 purity 守卫，`PURE_DIRS` 改一下就能抄——但**白名单和 DOM 全局清单要按目标工具的实际情况改**，别照抄 map-editor 那份：`level-editor` 根本没有 pixi.js 依赖（面板用裸 `canvas.getContext('2d')`），所以"挡 pixi"那句话在这里没有对应物，承重的是 DOM 全局清单（按该工具 impure 半边真正用到的 global 逐个列：`document`/`window`/`ResizeObserver`/`CanvasRenderingContext2D`/`MouseEvent`/`WheelEvent`/`showOpenFilePicker`…），允许的 bare specifier 也从 `@nw/shared/slg` 变成 `@nw/engine/*`。四条断言各做过 red-then-green 实测（DOM 全局、跨界 import、纯目录改名 canary、往 include 加第三个目录 canary）。**4c 走得更远：连「一律禁 DOM」这个前提本身都可能不成立**（`vfx-editor` 的 `src/io/**` 在门禁范围内、又理应用 IndexedDB/localStorage/Blob），那时要改的不是清单里的条目而是**判据**——见下方「4c 实测」的两层写法。**4d 把这条推到了四层**（同一个包里 `core`/`skeleton` 零浏览器 API、`animation` 只许 rAF 两个、`io` 一份显式清单），并且是唯一一个真有 `pixi.js` 可挡、也是唯一一个 scope 内**必须**跨界 `import type` 一个 PIXI 拥有者的包——见下方「4d 实测」。**4e 又是第五种形状**：`ops` 的 include 名下两个目录**本来就该受不同规矩**（`logic/**` 一个 global 不许碰，`api/**` 允许 `fetch`/`localStorage`/`location` 这三个、REST 客户端的定义就是这个），并成一条会两头都坏；它还是唯一一个连**扫描器本身**都被抓出两个 bug 的包（引号里的 `from`、行注释里的 `src/api/**` 被当成块注释开头）——见下方「4e 实测」。**五个包五种形状，这本身就是结论**：可以抄的只有骨架（受检目录从 `coverage.include` 反推 + canary + LF/CRLF + 每条断言 red-then-green），判据和扫描器每次都得自己量、自己验。余量数字也一样越往后越大：4b 49 行 → 4a 72 → 4d ~140 → **4e 168**，因为它是「测试越好、能容忍的杂质越多」的直接后果。

**防刷分的那一列**：报表每行有 `Scope (files)`（measured / `src` 下源文件数）。缩 include 抬 % 的同时这个比例会掉，两个数印在同一张表里，取舍在 review 时就看得见。

## Phase 4 graduation：五个工具怎么接进门禁（**已全部完成**）

> 走了五遍：**4a `map-editor`**、**4b `level-editor`**、**4c `vfx-editor`**、**4d `animator`**、**4e `ops`**（都是 2026-08-20）。
> **这一节现在是历史**：`NOT_GATED_JSON_SUMMARY_PACKAGES` 已随 4e 退休（见「三条 CI 闸门」与 ADR-070 收尾条），所以第 1–3 步没有对象了。保留它是因为剩下的步骤对**下一个新增的包**仍然适用，而且这五次踩到的坑不该跟着机制一起被删掉。

给一个新包接门禁，今天要做的是：

1. 把它加进 `scripts/coverageLib.mjs` 的 `JSON_SUMMARY_PACKAGES`（或 `LCOV_PACKAGES`），并在那一行上方写清楚它的 scope 是什么、为什么。**没有第二条「先豁免」的路了**——那条路存在过不到一天，退休理由见 ADR-070 收尾条。
2. `coverageScripts.test.ts` 有一条「never list the same package twice」用例钉着「同一个包不能出现在两份清单里」；`tools/` 下的包还额外被那条退休 canary 钉着「每个带 `vitest.config.ts` 的 tools 包都必须在受门禁清单里」——从文件系统读，所以新加一个 tools 工具而忘了把它接进门禁，会直接红。
3. 更新本文台账 + 该包 `vitest.config.ts` 的注释（包括「scope 内 X%」那个数字：复核一遍，别照抄旧值）。
4. 加一条 `test/pureLayerBoundary.test.ts`（见上一节；受检目录从 `coverage.include` 反推，判据按本工具量），每条断言各做一次 red-then-green。**顺带把「补的测试真的会红」也抽查一遍**：4d 用一个小脚本对 16 处源码逐个做单点变异、跑对应测试文件、再还原，第一轮有 4 处照绿（详见「4d 实测」）——补完覆盖率不等于补了检验能力，而覆盖率报表对这个差别完全是瞎的。
5. `node scripts/checkCoverageThreshold.mjs` 本地过一遍。本地跑要求**每个**受门禁包都有 `coverage/`，只跑一个包会被判成「产出缺失」而非绿——在 worktree 里可以先把主检出各包已有的 `coverage/coverage-summary.json`（+ `server/engine` 的 `lcov.info`）拷进来占位，只重跑本轮改的那个包。**并行开发时占位会骗人**：4d rebase 进当日分支后，`vfx-editor` 的占位还是 4c 之前的旧 scope（40.4%），而 4c 已经把它接进门禁了——占位是「借一个数字让脚本跑得起来」，凡是本轮 rebase 带进来的包都得重跑，不然报表里会混着别人的旧口径。4e 同样中过这条（`animator`/`vfx-editor` 两个占位都是 rebase 带进来的）。

### 那套 not-gated 双清单机制（2026-08-20 上线、同日退休）

短命但值得记：`NOT_GATED_JSON_SUMMARY_PACKAGES` 让五个 tools 包「出现在报表里、必须产出 coverage、但暂不受百分比约束」，好处是它们从第一天起就被测量，而不是等结构改完才进视野。三件事按这个顺序发生：

1. **上线**（ADR-070）：豁免必须在**每次** CI summary 里复述当前值与目标，绿跑也印——只写在设计文档里的「临时豁免」会无声变永久。
2. **与测试解耦**（同日）：`coverageScripts.test.ts` 原本有 7 条用例把 `'tools/ops'` 写死当样本、外加一条 `expect(NOT_GATED.length).toBeGreaterThan(0)`，两处都会在「最后一个合并的人」身上随机炸。改成从名单取样本（`notGatedSample()` + `itIfNotGated`）+ two-state canary。**买到的东西是真的**：4c、4d 各自毕业时 `coverageScripts.test.ts` **一行没改**。
3. **退休**（4e，同日）：名单空了以后，留着一套「能用的、合法地不受门禁约束」的机制本身就是一份长期邀请函——下一个到不了 90% 的包会先去用它，而不是去改结构。所以第三份清单、行上的 `gated` 字段、报表小节、门禁脚注、那 7 条用例和两个 helper 一并删除；two-state canary 收成单态的 `every row is gated, and the not-gated pipeline is retired`。**保留的两样**：报表的 `Scope (files)` 列，和门禁把「低于门槛」与「完全没产出」分成两条消息——都是那轮顺带修掉的既有问题，跟豁免无关。完整理由与验收条件见 ADR-070 收尾条。

**这段历史里最可复用的一条**：那个 canary 被写错过两次（`toBeGreaterThan(0)` 形状错 → two-state 对 → 单态），但它防的事一次没变——**一个从所有清单里掉出去的包，谁都不再测量它，而这从外面看跟一次成功的退休一模一样**。所以退休时的验收条件是「机制在输出里消失 **且** 每个 tools 包都在受门禁清单里」，两半都断言，缺一半就等于把「悄悄漏掉」当成「按计划完成」。

## 测试历史


四个阶段的补测（2026-08-13，纯逻辑 → 状态管理类 → 业务页 → 渲染/交互层的可抽纯函数）全部完成，细节写在 [`animator.md`](animator.md) 的「测试」节（它是唯一有独立 claudedocs 页的工具；`level-editor`/`vfx-editor`/`ops`/`map-editor` 的说明写在各自 `vitest.config.ts` 的头注释里）。当时明确留下的口子——DOM/PIXI 构造接线需要每个工具各投一套 headless-PIXI harness——就是上表 Phase 4 的来源。

## 已知遗留

- ~~**`tools/animator/src/` 有 11 个重构前的扁平模块从入口不可达**~~ —— **已于 2026-08-20 同日删除**（13 个文件 / 1424 行：`animation.ts`/`events.ts`/`interaction.ts`/`io.ts`/`presets.ts`/`renderer.ts`/`skeleton.ts`/`state.ts`/`timeline.ts`/`types.ts`/`ui.ts` + 两个 `export {}` 空壳 `atlas/AtlasController.ts`、`ui/AtlasPanel.ts`）。可达性用一次按 tsconfig 解析规则的 import 遍历独立复核过，起点取全部三类入口（`src/index.ts`、**`runtime/StickmanRuntime.ts`——不在 `src/` 下，是单独产物，必须单独当根**、11 个测试文件），保留 `src/globals.d.ts`（ambient 声明，无人 import 但 tsc 需要）；最硬的证据是删除前后 production bundle 的 contenthash 完全一致（`bundle.04a1b40b5390a85f7d41.js`）。**对本表的影响**：animator 全包 23.53% → **29.54%**（`--coverage.include='src/**'` 口径 24.37% → 30.87%），而 `npm run test:coverage` 印的 scope 内数字 **64.28% 前后不动**——死文件本来就在 include whitelist 之外，别指望门禁数字变。细节见 [`animator.md`](animator.md)「删除重构前的扁平死模块」。（这两个数后来又都动了：Phase 4d 补测试把 scope 内推到 98.9%、全包推到 42.9%，见上方台账；引用时务必说清是哪一次、哪个口径。）
- 其余四个工具做过同样的可达性遍历，**均无不可达文件**。
- ~~**`tools/` 的可达性遍历值得偶尔重跑**~~ —— **已于同日变成第三条闸门**（`tools/scripts/checkUnreachableModules.mjs`，见上方「可达性闸门」）。当初记这条的理由依然成立、且正是闸门存在的理由：这类死图是重构留下的，**原来那两条闸门都发现不了**——死文件既不超长（500 行闸门看不见），也在 coverage scope 之外（受门禁的数字看不见），只有全包分母会隐约透光，而全包分母不设门禁。上面那次是接覆盖率时顺手遍历才发现的，不是任何闸门报出来的；现在不必再靠「偶尔想起来重跑」。

# 工具链（`tools/`）测试与覆盖率快查

> 五个工具：`animator`(9091) / `level-editor`(9092) / `ops`(9093) / `vfx-editor`(9094) / `map-editor`(9095)，外加 `desktop-shell`（Electron 壳，仅 build）。
> 相关：覆盖率工具本体见 [`server-testing-tooling.md`](server-testing-tooling.md) 「测试覆盖率百分比工具」；animator 自身的模块/测试细节见 [`animator.md`](animator.md)；口径拍板见 [ADR-070](../design/DECISIONS_ADR-041-onward.md#adr-070-tools-覆盖率口径-scoped-include-与-reported-not-gated-过渡--accepted--2026-08-20)。

## 怎么跑

```bash
cd tools/<tool> && npm test                 # vitest run
cd tools/<tool> && npm run test:coverage    # 同上 + coverage/（v8）
cd tools/<tool> && npm run typecheck        # tsc --noEmit -p tsconfig.test.json
```

权威的**跨包**覆盖率数字来自仓库根（读的是各包刚产出的 `coverage/`，跟 CI 同一份脚本）：

```bash
node scripts/coverageSummary.mjs          # 报表，永不失败
node scripts/checkCoverageThreshold.mjs   # 门禁，低于门槛/缺产出则退出 1
```

`desktop-shell` 没有测试基础设施（1 个依赖的 Electron 壳），**不在**任何覆盖率清单里；它的 `tsc -p tsconfig.json`（即 `npm run build`）就是它的类型检查。

## 三条 CI 闸门

| 闸门 | 范围 | 语义 |
|---|---|---|
| 单文件 500 行 | `tools/` 全树（`.ts`/`.tsx`，排除 `test/`、`scripts/`、`dist/`） | `tools/scripts/checkFileLength.mjs` 薄封装转调根 `scripts/checkFileLength.mjs`；只在**新文件**越过 500 行、或 `tools/scripts/file-length-baseline.json` 里的已知文件**继续变大**时判红。2026-08-13 (G4) 起 |
| 覆盖率 | 5 个工具包 | 报表 + **产出必须存在**；`map-editor`（Phase 4a）与 `level-editor`（Phase 4b）**百分比也受 90% 门禁**，其余 3 个仍豁免（ADR-070）。2026-08-20 起 |
| 可达性 | 5 个工具包各自的 `src/**` | `tools/scripts/checkUnreachableModules.mjs`（逐包调用根 `scripts/checkUnreachableModules.mjs`）：**任何一个 `src/` 下的源文件，若从该包的 bundler entry、`--extra-root` 声明的兄弟产物目录（animator 的 `runtime/`）、以及 `test/**` 这三类根出发都到不了，判红**。2026-08-20 起 |

覆盖率那条的两半要分清：
- **管路已受门禁**——某个工具包不再产出 `coverage/`，`checkCoverageThreshold.mjs` 判红，跟服务端 workspace 一样。这不是覆盖率回归，报错文案也刻意分开说（"produced no coverage output at all"），免得有人去找缺失的测试而真正要修的是缺失的 CI 步骤。
- **百分比未受门禁**——每个包各自的 scope 先要做结构性改造才谈得上 90%（下表）。这条豁免在**每次** CI 的 summary 里复述当前值与目标，绿跑也印。**已开始收缩**：同一天 Phase 4a（`map-editor`）、Phase 4b（`level-editor`）先后毕业进 `JSON_SUMMARY_PACKAGES`，豁免名单从 5 个降到 3 个。

## 可达性闸门（2026-08-20 新增）

起因是 animator 那 1424 行死码（见下方「已知遗留」）：它**同时躲过了另外两条闸门，且是构造性的**——每个文件都不到 500 行（行数闸门看不见），又全在 coverage `include` 之外（受门禁的百分比看不见）。当初是有人恰好手跑了一次 import 遍历才发现的，靠运气；现在那次遍历变成了常驻闸门。

- **判定口径刻意宽松**：只要**任何一个根**能到达就算活的，**包括测试文件**。「只有测试 import 它」不是死码，那是另一件（弱得多的）事，本闸门不表态；只有「全仓库没有任何东西提到它」才判红。
- **解析顺序是承重的**：`./x` 必须先试 `x.ts`、再试 `x/index.ts`。animator 那张死图正是靠这一点自闭合的（死的 `renderer.ts` 里 `from './skeleton'` 命中死的 `src/skeleton.ts`，而不是活的 `src/skeleton/Skeleton.ts`）——**顺序反了，整张死图会被判成活的**。这条有专门的测试钉住，把脚本里的顺序调过来它就红。
- **`--extra-root` 是必需的逃生口**，不是可选装饰：animator 的 `runtime/StickmanRuntime.ts` 在 `src/` 外、没有任何 entry import 它，不把 `runtime/` 声明成根，它拉进来的文件会全体误报。误报一旦大到让人烦，闸门就会被关掉——所以这条也双向钉了测试（不给 `--extra-root` 必须红，给了必须绿）。
- **canary**：扫到 0 个文件 / 0 个根，或者 entry 找不到，都直接判红——否则「什么都没扫」和「什么问题都没有」印出来是同一句 OK。
- **测试**：`server/shared/test/reachabilityGuard.test.ts`（15 例，与 `guardScripts.test.ts`/`coverageScripts.test.ts` 同一手法：spawn 真 CLI、断言退出码 + stdout、跑一次性 fixture 目录树）。最后一例是**真仓库集成**——直接跑 `tools/` 的封装、断言 5 个包全 OK，因为封装里包名写错或漏了 animator 的 `--extra-root`，前 14 例全绿也照样什么都没守住。两条承重断言都做过 red-then-green 实测（把解析顺序调反 → 顺序那例红；把 import 正则改成不跨行 → 跨行那例红，**顺带把真仓库集成例也带红了，因为 ops 里真有一处跨行 import**）。

**这条闸门管不到什么**：`client/`、`server/` 都不在范围内（多入口，模型不适用），`desktop-shell` 也不在（Electron main/preload 对，没有单入口 web bundle）。

## 覆盖率口径：scoped `include`

跟 `client` 同一套做法（`client/vitest.config.ts` 的 `coverage.include` 只圈 `src/game/**`，PIXI 渲染层出界）：每个工具的 `coverage.include` 是**它的 `vitest.config.ts` 头注释自 2026-08-13 起就用文字描述过的那个纯逻辑层**的机器可读形式，不是「现在哪块覆盖率高」挑出来的。out-of-scope 的一律是 DOM/PIXI 构造接线（这些编辑器都没有 headless-PIXI harness）。

### 台账（2026-08-20 实测）

| 包 | `coverage.include` | scope 内行覆盖 | 全包行覆盖 | 距 90% 要做的事 |
|---|---|---|---|---|
| `level-editor` | `state/**`、`layout/**`、`units.ts` | **100.0%** (445/445)、函数 64/64 | 25.7% | **✅ 已接门禁（Phase 4b，2026-08-20）**。坐标/命中数学 + 原本埋在 `resize()`/`onMove()`/`onWheel()`/draw 方法里的纯决策已从两个面板类移进新的 `src/layout/{board,timeline}.ts`（纯层：一格/一个 block 在屏幕哪儿、光标下是什么、什么颜色、路径怎么走），`src/board/`+`src/timeline/` 从此均质地是 DOM 那半。scope 216 → **445** 行（ADR-070 原估 ~600，见下方「4b 实测」）。同日加了 `pureLayerBoundary.test.ts` 守边界 |
| `map-editor` | `state/**`、`tiles/**`、`i18n.ts`、`constants.ts` | **100.0%** (652/652)、函数 62/62 | 38.3% | **✅ 已接门禁（Phase 4a，2026-08-20）**。`isoGrid`/`tileStyle` 已从 `render/` 移进新的 `src/tiles/`（纯层：一格在屏幕哪儿 / 长什么样），`include` 回到目录级，包也从 `NOT_GATED_JSON_SUMMARY_PACKAGES` 移进 `JSON_SUMMARY_PACKAGES`。同日补完最后 8 行（150 例），并加了 `pureLayerBoundary.test.ts` 守边界——见下方「覆盖率百分比守不住目录边界」|
| `vfx-editor` | `model/**`、`io/**`、`rendering/Playback.ts` | 84.9% (449/529) | 40.4% | Phase 4c：`io/IOController.ts`（74 行，0%）。它没有浏览器依赖挡路，所以「没测」是缺口而非结构限制，故意留在 scope 内 |
| `animator` | `core/**`、`skeleton/**`、`animation/**`、`io/**` | 64.3% (927/1442) | 23.5% → **29.5%**（2026-08-20 删掉 1424 行不可达死码后实测，见下方「已知遗留」）| Phase 4d：`io/{AutoSaveController,ProjectStore}.ts`（IndexedDB，均 0%，按 vfx-editor 的 `fake-indexeddb` 先例）+ `animation/AnimationController.ts`（41.3%） |
| `ops` | **无（报全包）** | — | **8.8%** (322/3639) | Phase 4e：它没有可指的逻辑层——2026-08-13 Phase 3 导出的 9 个纯函数各自嵌在一个 90% 是 `h()` DOM 的 `pages/*.ts` 里，最大的非页面文件 `src/api.ts` 自己也只有 22.7%。先把各页纯逻辑抽进 `src/logic/<page>.ts`、`pages/*` 只留 DOM 装配（同 `f22c3df2` 拆 `api.ts`/`types.ts` 的方向），再把 include 收到 `logic/**` + `api/**` |

**Phase 4a 实测（2026-08-20，`map-editor`）**：搬 `isoGrid`/`tileStyle` 是**零行为改动**的搬移——production bundle 逐 token 比对，两侧各只有 25 个独有 token，全部是 webpack 的确定性 module id（模块路径集合变了必然重排）与 contenthash 本身，无任何代码/字符串差异（581751 → 581765 字节）。所以这类 graduation **不要指望 contenthash 相同**（那是 animator 删死码那次能用的证据，因为那次模块集合只减不改名）；能用的是 token 集合对比。顺带一并搬走的还有 `TerrainTextureName` 类型：它原来定义在 PIXI 的 `render/terrainAtlasLoader.ts` 里，纯层要用就得 `import type` 一个 PIXI 模块（运行期无害，但边界读不出来），现在类型归 `tiles/tileStyle.ts`、loader 反向 import。~~**接门禁之后边界是自守的**~~ —— **这句话是错的，同日订正，见下一节**。

**Phase 4b 实测（2026-08-20，`level-editor`）**：同一手法、同一天。这个包的退出条件是「把已导出的 12 个坐标/命中函数抽成独立纯模块」，但只搬那 12 个的话 scope 撑不起来——所以**顺手把还埋在 `resize()`/`onMove()`/`onWheel()` 和 draw 方法里的纯决策一起提了出来**（board 的 `fitCell`/`headerFor`/`activeHandles`/`crossPathPoints`/`escortPathPoints`，timeline 的 `blockRect`/`unitTickXs`/`blockLabel`/`gridStepSec`/`visibleSecondRange`/`snapAtTick`/`zoomAround`/`panBy` 等），这跟 2026-08-13 Phase 4 提那 12 个是同一类动作。顺带消掉两处真重复：`gridStepSec`/`visibleSecondRange` 原本在 `drawTimeGrid` 和 `drawRuler` 里逐字写了两遍；一个 block 的**右边界原本被算两次**（`drawBlocks` 当宽度、`hitTest` 当 `x1`，两个不同表达式），现在 `blockRect` 是唯一定义、`hitTest` 打它，并有一例专钉「点在画出来的边上必须命中」——抽模块顺手合掉重复，比只搬位置值钱。

- **scope 216 → 445 行（100%，函数 64/64），不是 ADR-070 表里估的「约 600」**。600 那个数得当成估计值改掉而不是去凑：剩下的差额是面板类的绘制代码本身，那按定义就是 DOM 那半边。`Overall (gated)` 93.9% → **94.0%**（15 → 16 个包），豁免段降为 3 个工具。测试 77 → **135 例**；`test/{BoardPanel,TimelinePanel}.test.ts` 改名成 `test/layout{Board,Timeline}.test.ts`（它们测的是 `src/layout/*`）。
- **行为不变的证据同样用 token 集合对比**（别指望 contenthash，理由同 4a）：字符串字面量 506 → 506，仅两条模板串因插值变量被压缩改名而不同，无任何文案/颜色变化；标识符 −8/+16 全部可解释——消失的 8 个是那 7 个 `this.` 方法名（原本是不可 mangle 的类成员，现在是模块函数）加一个 `18.2`（`Math.round(26*0.7)` 原本被常量折叠，现在藏在 `headerFor()` 后面，值仍是 18），新增的 16 个是 12 个新 mangle 名 + `secondX` + `startSec`/`endSec` 解构。**踩过的坑**：朴素的 `"字符串"|标识符` 正则交替在转义引号处会级联错位、报出两百个假 diff；得用真扫描器（逐字符走、跟踪字符串/模板状态）。
- **顺带退休了 `tools/scripts/file-length-baseline.json` 的唯一条目**：`BoardPanel.ts` 543 → **430 行**，`checkFileLength.mjs` 自己会打印「可以删这条」的 housekeeping 提示。该文件现在只剩 `_readme`（闸门在空 baseline 下正常工作，实测 `0 tracked in baseline` 仍绿）。

**为什么剩下的低分留着**：include 清单刻意把已知未测的文件圈在里面（animator 那两个 0% 的 IndexedDB 文件最典型）——缺口是要干的活，不是要定义掉的东西。反过来，`ops` 只要把 include 缩到 `src/api/**` 就能把印出来的数字抬上去，**一个测试都不用加**，这是覆盖率门禁最不该奖励的事，所以它宁可挂着 8.8% 的全包数字。

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

**给 4c–4e 的结论**：graduation 不等于边界有人守。`include` 回到目录级只是让「加文件」变得可见**给覆盖率算法**，不等于可见给门禁——门禁只看一个百分比，而百分比有余量。每个毕业的包都该配一条同形的 purity 守卫，`PURE_DIRS` 改一下就能抄——但**白名单和 DOM 全局清单要按目标工具的实际情况改**，别照抄 map-editor 那份：`level-editor` 根本没有 pixi.js 依赖（面板用裸 `canvas.getContext('2d')`），所以"挡 pixi"那句话在这里没有对应物，承重的是 DOM 全局清单（按该工具 impure 半边真正用到的 global 逐个列：`document`/`window`/`ResizeObserver`/`CanvasRenderingContext2D`/`MouseEvent`/`WheelEvent`/`showOpenFilePicker`…），允许的 bare specifier 也从 `@nw/shared/slg` 变成 `@nw/engine/*`。四条断言各做过 red-then-green 实测（DOM 全局、跨界 import、纯目录改名 canary、往 include 加第三个目录 canary）。

**防刷分的那一列**：报表每行有 `Scope (files)`（measured / `src` 下源文件数）。缩 include 抬 % 的同时这个比例会掉，两个数印在同一张表里，取舍在 review 时就看得见。

## Phase 4 graduation：怎么把一个工具接进门禁

> 已走过两遍：**4a `map-editor`** 和 **4b `level-editor`**（都是 2026-08-20）。下面六步就是那两次实际做的事。

1. 把该包从 `scripts/coverageLib.mjs` 的 `NOT_GATED_JSON_SUMMARY_PACKAGES` **移到** `JSON_SUMMARY_PACKAGES`。
2. **两个清单都要检查**——`coverageScripts.test.ts` 有一条专门钉这个错的用例：复制一行、忘了删原来那行，包就同时既受门禁又被豁免（`collectRows` 出两行，门禁被那条豁免行满足，表面看一切正常）。**反向的错**（只删不加）由那条 two-state canary 兜住，见下方「测试侧不用改」。
3. 顺手看一眼 `NOT_GATED_JSON_SUMMARY_PACKAGES` 上方那段注释里的**数量词**（"五个工具包"）——名单少一个，那句话就过时一句。
4. 更新本文台账 + 该包 `vitest.config.ts` 的注释（包括「scope 内 X%」那个数字：把它复核一遍，别照抄旧值）。
5. 加一条 `test/pureLayerBoundary.test.ts`（见上一节；`PURE_DIRS` 从 `coverage.include` 反推，白名单/DOM 清单按本工具改），并把四条断言各做一次 red-then-green。
6. `node scripts/checkCoverageThreshold.mjs` 本地过一遍（它会顺带把剩下的 not-gated 清单重印一次）。本地跑要求**每个**受门禁包都有 `coverage/`，只跑一个包会被判成「产出缺失」而非绿——在 worktree 里可以先把主检出各包已有的 `coverage/coverage-summary.json`（+ `server/engine` 的 `lcov.info`）拷进来占位，只重跑本轮改的那个包。

### 测试侧不用改（2026-08-20 解耦）

剩下的 **4c `vfx-editor` / 4d `animator` / 4e `ops`** 三条线可以并行、任意顺序合并：`coverageScripts.test.ts` 里再没有任何东西写死正在毕业的包名，所以毕业那个 PR 不需要连带改测试文件。做法两条：

- **需要一个真实 not-gated 行的用例**（共 7 条：「低于门槛不判红」「无产出判红」「两类失败分行」「`COVERAGE_THRESHOLD` 不作用于豁免行」「绿跑也复述差距」「报表单列一节」「不进 `Overall`」）从名单里取第一项当样本（`notGatedSample()`），并挂在 `itIfNotGated` 上——名单空了就整条跳过，因为那时根本没有这种行可断言。fixture 的百分比也不再用某个包当时的实测值（原来是 animator 的 64.3），只保留「在门槛的哪一侧」这一个语义。
- **原来那条 `expect(NOT_GATED.length).toBeGreaterThan(0)`** 改成 two-state：名单非空时断言每一项都确实产出了 not-gated 行；名单为空时断言**豁免已经从输出里消失**（`collectRows` 不再有 `gated: false` 行、报表不再打印「reported, not gated」小节、门禁不再打印豁免脚注），并且 `tools/` 下每个带 `vitest.config.ts` 的包都在受门禁清单里——即「三个包是**搬**进门禁了，不是从表里掉出去了」。它防的事没变（豁免不能悄悄空掉、变成死代码），只是不再由「最后一个合并的人」随机中奖。

**最后毕业的那条线额外要做的事**：名单一空，not-gated 那套管路（`collectRows` 的第三段 spread、两个脚本里的豁免小节/脚注、这 7 条用例 + `itIfNotGated`/`notGatedSample`）就成了死代码，该在同一个 PR 里退休掉；canary 的空名单分支正是那次退休的验收条件——它只接受「输出里再也不声称豁免任何东西」。

## 测试历史

四个阶段的补测（2026-08-13，纯逻辑 → 状态管理类 → 业务页 → 渲染/交互层的可抽纯函数）全部完成，细节写在 [`animator.md`](animator.md) 的「测试」节（它是唯一有独立 claudedocs 页的工具；`level-editor`/`vfx-editor`/`ops`/`map-editor` 的说明写在各自 `vitest.config.ts` 的头注释里）。当时明确留下的口子——DOM/PIXI 构造接线需要每个工具各投一套 headless-PIXI harness——就是上表 Phase 4 的来源。

## 已知遗留

- ~~**`tools/animator/src/` 有 11 个重构前的扁平模块从入口不可达**~~ —— **已于 2026-08-20 同日删除**（13 个文件 / 1424 行：`animation.ts`/`events.ts`/`interaction.ts`/`io.ts`/`presets.ts`/`renderer.ts`/`skeleton.ts`/`state.ts`/`timeline.ts`/`types.ts`/`ui.ts` + 两个 `export {}` 空壳 `atlas/AtlasController.ts`、`ui/AtlasPanel.ts`）。可达性用一次按 tsconfig 解析规则的 import 遍历独立复核过，起点取全部三类入口（`src/index.ts`、**`runtime/StickmanRuntime.ts`——不在 `src/` 下，是单独产物，必须单独当根**、11 个测试文件），保留 `src/globals.d.ts`（ambient 声明，无人 import 但 tsc 需要）；最硬的证据是删除前后 production bundle 的 contenthash 完全一致（`bundle.04a1b40b5390a85f7d41.js`）。**对本表的影响**：animator 全包 23.53% → **29.54%**（`--coverage.include='src/**'` 口径 24.37% → 30.87%），而 `npm run test:coverage` 印的 scope 内数字 **64.28% 前后不动**——死文件本来就在 include whitelist 之外，别指望门禁数字变。细节见 [`animator.md`](animator.md)「删除重构前的扁平死模块」。
- 其余四个工具做过同样的可达性遍历，**均无不可达文件**。
- ~~**`tools/` 的可达性遍历值得偶尔重跑**~~ —— **已于同日变成第三条闸门**（`tools/scripts/checkUnreachableModules.mjs`，见上方「可达性闸门」）。当初记这条的理由依然成立、且正是闸门存在的理由：这类死图是重构留下的，**原来那两条闸门都发现不了**——死文件既不超长（500 行闸门看不见），也在 coverage scope 之外（受门禁的数字看不见），只有全包分母会隐约透光，而全包分母不设门禁。上面那次是接覆盖率时顺手遍历才发现的，不是任何闸门报出来的；现在不必再靠「偶尔想起来重跑」。

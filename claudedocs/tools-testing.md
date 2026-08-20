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
| 覆盖率 | 5 个工具包 | 报表 + **产出必须存在**；`map-editor` 自 Phase 4a 起**百分比也受 90% 门禁**，其余 4 个仍豁免（ADR-070）。2026-08-20 起 |
| 可达性 | 5 个工具包各自的 `src/**` | `tools/scripts/checkUnreachableModules.mjs`（逐包调用根 `scripts/checkUnreachableModules.mjs`）：**任何一个 `src/` 下的源文件，若从该包的 bundler entry、`--extra-root` 声明的兄弟产物目录（animator 的 `runtime/`）、以及 `test/**` 这三类根出发都到不了，判红**。2026-08-20 起 |

覆盖率那条的两半要分清：
- **管路已受门禁**——某个工具包不再产出 `coverage/`，`checkCoverageThreshold.mjs` 判红，跟服务端 workspace 一样。这不是覆盖率回归，报错文案也刻意分开说（"produced no coverage output at all"），免得有人去找缺失的测试而真正要修的是缺失的 CI 步骤。
- **百分比未受门禁**——每个包各自的 scope 先要做结构性改造才谈得上 90%（下表）。这条豁免在**每次** CI 的 summary 里复述当前值与目标，绿跑也印。**已开始收缩**：Phase 4a（2026-08-20）把 `map-editor` 毕业进了 `JSON_SUMMARY_PACKAGES`，豁免名单从 5 个降到 4 个。

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
| `level-editor` | `state/**`、`units.ts` | **100.0%** (216/216) | 23.8% | 已达标，但 scope 只占 ~1670 行里的 216 行（**五个工具里最窄**）。Phase 4b 先把 `board/BoardPanel.ts`/`timeline/TimelinePanel.ts` 里已导出的坐标/命中数学抽成独立模块（现在夹在拥有 canvas 的面板类里，目录 include 够不着），scope 扩到约 600 行再接门禁 |
| `map-editor` | `state/**`、`tiles/**`、`i18n.ts`、`constants.ts` | **98.8%** (644/652) | 38.3% | **✅ 已接门禁（Phase 4a，2026-08-20）**。`isoGrid`/`tileStyle` 已从 `render/` 移进新的 `src/tiles/`（纯层：一格在屏幕哪儿 / 长什么样），`include` 回到目录级，包也从 `NOT_GATED_JSON_SUMMARY_PACKAGES` 移进 `JSON_SUMMARY_PACKAGES` |
| `vfx-editor` | `model/**`、`io/**`、`rendering/Playback.ts` | 84.9% (449/529) | 40.4% | Phase 4c：`io/IOController.ts`（74 行，0%）。它没有浏览器依赖挡路，所以「没测」是缺口而非结构限制，故意留在 scope 内 |
| `animator` | `core/**`、`skeleton/**`、`animation/**`、`io/**` | 64.3% (927/1442) | 23.5% → **29.5%**（2026-08-20 删掉 1424 行不可达死码后实测，见下方「已知遗留」）| Phase 4d：`io/{AutoSaveController,ProjectStore}.ts`（IndexedDB，均 0%，按 vfx-editor 的 `fake-indexeddb` 先例）+ `animation/AnimationController.ts`（41.3%） |
| `ops` | **无（报全包）** | — | **8.8%** (322/3639) | Phase 4e：它没有可指的逻辑层——2026-08-13 Phase 3 导出的 9 个纯函数各自嵌在一个 90% 是 `h()` DOM 的 `pages/*.ts` 里，最大的非页面文件 `src/api.ts` 自己也只有 22.7%。先把各页纯逻辑抽进 `src/logic/<page>.ts`、`pages/*` 只留 DOM 装配（同 `f22c3df2` 拆 `api.ts`/`types.ts` 的方向），再把 include 收到 `logic/**` + `api/**` |

**Phase 4a 实测（2026-08-20，`map-editor`）**：搬 `isoGrid`/`tileStyle` 是**零行为改动**的搬移——production bundle 逐 token 比对，两侧各只有 25 个独有 token，全部是 webpack 的确定性 module id（模块路径集合变了必然重排）与 contenthash 本身，无任何代码/字符串差异（581751 → 581765 字节）。所以这类 graduation **不要指望 contenthash 相同**（那是 animator 删死码那次能用的证据，因为那次模块集合只减不改名）；能用的是 token 集合对比。顺带一并搬走的还有 `TerrainTextureName` 类型：它原来定义在 PIXI 的 `render/terrainAtlasLoader.ts` 里，纯层要用就得 `import type` 一个 PIXI 模块（运行期无害，但边界读不出来），现在类型归 `tiles/tileStyle.ts`、loader 反向 import。**接门禁之后边界是自守的**：往一个已被 include 的目录里丢 PIXI 模块 = 塞进一个 ~0% 的文件 = 打红 90% 那条线；旧的逐文件 include 对「往 `render/` 加文件」完全隐形。

**为什么剩下的低分留着**：include 清单刻意把已知未测的文件圈在里面（animator 那两个 0% 的 IndexedDB 文件最典型）——缺口是要干的活，不是要定义掉的东西。反过来，`ops` 只要把 include 缩到 `src/api/**` 就能把印出来的数字抬上去，**一个测试都不用加**，这是覆盖率门禁最不该奖励的事，所以它宁可挂着 8.8% 的全包数字。

**防刷分的那一列**：报表每行有 `Scope (files)`（measured / `src` 下源文件数）。缩 include 抬 % 的同时这个比例会掉，两个数印在同一张表里，取舍在 review 时就看得见。

## Phase 4 graduation：怎么把一个工具接进门禁

> 已走过一遍：**4a `map-editor`（2026-08-20）**，五个里的第一个。下面五步就是那次实际做的事。

1. 把该包从 `scripts/coverageLib.mjs` 的 `NOT_GATED_JSON_SUMMARY_PACKAGES` **移到** `JSON_SUMMARY_PACKAGES`。
2. **两个清单都要检查**——`coverageScripts.test.ts` 有一条专门钉这个错的用例：复制一行、忘了删原来那行，包就同时既受门禁又被豁免（`collectRows` 出两行，门禁被那条豁免行满足，表面看一切正常）。
3. 顺手看一眼 `NOT_GATED_JSON_SUMMARY_PACKAGES` 上方那段注释里的**数量词**（"五个工具包"）——名单少一个，那句话就过时一句。
4. 更新本文台账 + 该包 `vitest.config.ts` 的注释（包括「scope 内 X%」那个数字：把它复核一遍，别照抄旧值）。
5. `node scripts/checkCoverageThreshold.mjs` 本地过一遍（它会顺带把剩下的 not-gated 清单重印一次）。本地跑要求**每个**受门禁包都有 `coverage/`，只跑一个包会被判成「产出缺失」而非绿——在 worktree 里可以先把主检出各包已有的 `coverage/coverage-summary.json`（+ `server/engine` 的 `lcov.info`）拷进来占位，只重跑本轮改的那个包。

## 测试历史

四个阶段的补测（2026-08-13，纯逻辑 → 状态管理类 → 业务页 → 渲染/交互层的可抽纯函数）全部完成，细节写在 [`animator.md`](animator.md) 的「测试」节（它是唯一有独立 claudedocs 页的工具；`level-editor`/`vfx-editor`/`ops`/`map-editor` 的说明写在各自 `vitest.config.ts` 的头注释里）。当时明确留下的口子——DOM/PIXI 构造接线需要每个工具各投一套 headless-PIXI harness——就是上表 Phase 4 的来源。

## 已知遗留

- ~~**`tools/animator/src/` 有 11 个重构前的扁平模块从入口不可达**~~ —— **已于 2026-08-20 同日删除**（13 个文件 / 1424 行：`animation.ts`/`events.ts`/`interaction.ts`/`io.ts`/`presets.ts`/`renderer.ts`/`skeleton.ts`/`state.ts`/`timeline.ts`/`types.ts`/`ui.ts` + 两个 `export {}` 空壳 `atlas/AtlasController.ts`、`ui/AtlasPanel.ts`）。可达性用一次按 tsconfig 解析规则的 import 遍历独立复核过，起点取全部三类入口（`src/index.ts`、**`runtime/StickmanRuntime.ts`——不在 `src/` 下，是单独产物，必须单独当根**、11 个测试文件），保留 `src/globals.d.ts`（ambient 声明，无人 import 但 tsc 需要）；最硬的证据是删除前后 production bundle 的 contenthash 完全一致（`bundle.04a1b40b5390a85f7d41.js`）。**对本表的影响**：animator 全包 23.53% → **29.54%**（`--coverage.include='src/**'` 口径 24.37% → 30.87%），而 `npm run test:coverage` 印的 scope 内数字 **64.28% 前后不动**——死文件本来就在 include whitelist 之外，别指望门禁数字变。细节见 [`animator.md`](animator.md)「删除重构前的扁平死模块」。
- 其余四个工具做过同样的可达性遍历，**均无不可达文件**。
- ~~**`tools/` 的可达性遍历值得偶尔重跑**~~ —— **已于同日变成第三条闸门**（`tools/scripts/checkUnreachableModules.mjs`，见上方「可达性闸门」）。当初记这条的理由依然成立、且正是闸门存在的理由：这类死图是重构留下的，**原来那两条闸门都发现不了**——死文件既不超长（500 行闸门看不见），也在 coverage scope 之外（受门禁的数字看不见），只有全包分母会隐约透光，而全包分母不设门禁。上面那次是接覆盖率时顺手遍历才发现的，不是任何闸门报出来的；现在不必再靠「偶尔想起来重跑」。

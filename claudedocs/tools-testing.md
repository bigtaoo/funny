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

## 两条 CI 闸门

| 闸门 | 范围 | 语义 |
|---|---|---|
| 单文件 500 行 | `tools/` 全树（`.ts`/`.tsx`，排除 `test/`、`scripts/`、`dist/`） | `tools/scripts/checkFileLength.mjs` 薄封装转调根 `scripts/checkFileLength.mjs`；只在**新文件**越过 500 行、或 `tools/scripts/file-length-baseline.json` 里的已知文件**继续变大**时判红。2026-08-13 (G4) 起 |
| 覆盖率 | 5 个工具包 | 报表 + **产出必须存在**；**百分比暂不受 90% 门槛约束**（ADR-070）。2026-08-20 起 |

覆盖率那条的两半要分清：
- **管路已受门禁**——某个工具包不再产出 `coverage/`，`checkCoverageThreshold.mjs` 判红，跟服务端 workspace 一样。这不是覆盖率回归，报错文案也刻意分开说（"produced no coverage output at all"），免得有人去找缺失的测试而真正要修的是缺失的 CI 步骤。
- **百分比未受门禁**——每个包各自的 scope 先要做结构性改造才谈得上 90%（下表）。这条豁免在**每次** CI 的 summary 里复述当前值与目标，绿跑也印。

## 覆盖率口径：scoped `include`

跟 `client` 同一套做法（`client/vitest.config.ts` 的 `coverage.include` 只圈 `src/game/**`，PIXI 渲染层出界）：每个工具的 `coverage.include` 是**它的 `vitest.config.ts` 头注释自 2026-08-13 起就用文字描述过的那个纯逻辑层**的机器可读形式，不是「现在哪块覆盖率高」挑出来的。out-of-scope 的一律是 DOM/PIXI 构造接线（这些编辑器都没有 headless-PIXI harness）。

### 台账（2026-08-20 实测）

| 包 | `coverage.include` | scope 内行覆盖 | 全包行覆盖 | 距 90% 要做的事 |
|---|---|---|---|---|
| `level-editor` | `state/**`、`units.ts` | **100.0%** (216/216) | 23.8% | 已达标，但 scope 只占 ~1670 行里的 216 行（**五个工具里最窄**）。Phase 4b 先把 `board/BoardPanel.ts`/`timeline/TimelinePanel.ts` 里已导出的坐标/命中数学抽成独立模块（现在夹在拥有 canvas 的面板类里，目录 include 够不着），scope 扩到约 600 行再接门禁 |
| `map-editor` | `state/**`、`render/{isoGrid,tileStyle}.ts`、`i18n.ts`、`constants.ts` | **98.8%** (644/652) | 38.3% | 已达标。Phase 4a 把 `isoGrid`/`tileStyle` 从 `render/` 挪进独立纯模块（现在只能逐文件列——那是缺模块边界的味道，不是偏好），include 回到目录级后接门禁 |
| `vfx-editor` | `model/**`、`io/**`、`rendering/Playback.ts` | 84.9% (449/529) | 40.4% | Phase 4c：`io/IOController.ts`（74 行，0%）。它没有浏览器依赖挡路，所以「没测」是缺口而非结构限制，故意留在 scope 内 |
| `animator` | `core/**`、`skeleton/**`、`animation/**`、`io/**` | 64.3% (927/1442) | 23.5% | Phase 4d：`io/{AutoSaveController,ProjectStore}.ts`（IndexedDB，均 0%，按 vfx-editor 的 `fake-indexeddb` 先例）+ `animation/AnimationController.ts`（41.3%） |
| `ops` | **无（报全包）** | — | **8.8%** (322/3639) | Phase 4e：它没有可指的逻辑层——2026-08-13 Phase 3 导出的 9 个纯函数各自嵌在一个 90% 是 `h()` DOM 的 `pages/*.ts` 里，最大的非页面文件 `src/api.ts` 自己也只有 22.7%。先把各页纯逻辑抽进 `src/logic/<page>.ts`、`pages/*` 只留 DOM 装配（同 `f22c3df2` 拆 `api.ts`/`types.ts` 的方向），再把 include 收到 `logic/**` + `api/**` |

**为什么两个低分留着**：include 清单刻意把已知未测的文件圈在里面（animator 那两个 0% 的 IndexedDB 文件最典型）——缺口是要干的活，不是要定义掉的东西。反过来，`ops` 只要把 include 缩到 `src/api/**` 就能把印出来的数字抬上去，**一个测试都不用加**，这是覆盖率门禁最不该奖励的事，所以它宁可挂着 8.8% 的全包数字。

**防刷分的那一列**：报表每行有 `Scope (files)`（measured / `src` 下源文件数）。缩 include 抬 % 的同时这个比例会掉，两个数印在同一张表里，取舍在 review 时就看得见。

## Phase 4 graduation：怎么把一个工具接进门禁

1. 把该包从 `scripts/coverageLib.mjs` 的 `NOT_GATED_JSON_SUMMARY_PACKAGES` **移到** `JSON_SUMMARY_PACKAGES`。
2. **两个清单都要检查**——`coverageScripts.test.ts` 有一条专门钉这个错的用例：复制一行、忘了删原来那行，包就同时既受门禁又被豁免（`collectRows` 出两行，门禁被那条豁免行满足，表面看一切正常）。
3. 更新本文台账 + 该包 `vitest.config.ts` 的注释。
4. `node scripts/checkCoverageThreshold.mjs` 本地过一遍（它会顺带把剩下的 not-gated 清单重印一次）。

## 测试历史

四个阶段的补测（2026-08-13，纯逻辑 → 状态管理类 → 业务页 → 渲染/交互层的可抽纯函数）全部完成，细节写在 [`animator.md`](animator.md) 的「测试」节（它是唯一有独立 claudedocs 页的工具；`level-editor`/`vfx-editor`/`ops`/`map-editor` 的说明写在各自 `vitest.config.ts` 的头注释里）。当时明确留下的口子——DOM/PIXI 构造接线需要每个工具各投一套 headless-PIXI harness——就是上表 Phase 4 的来源。

## 已知遗留

- **`tools/animator/src/` 有 11 个重构前的扁平模块从入口不可达**（约 1437 行，`animation.ts`/`events.ts`/`interaction.ts`/`io.ts`/`presets.ts`/`renderer.ts`/`skeleton.ts`/`state.ts`/`timeline.ts`/`types.ts`/`ui.ts` + `atlas/AtlasController.ts`、`ui/AtlasPanel.ts`）。活代码走 `src/index.ts → App.ts →` 目录版模块；这批旧文件只互相 import（`src/renderer.ts` 里的 `from './skeleton'` 解析到 `src/skeleton.ts`，而非活代码用的 `src/skeleton/Skeleton.ts`），形成独立死图。全 0% 覆盖，白拖低 animator 的全包数字。删除动作单列一个任务，未与覆盖率接线混在一起。注意 `src/types.ts` 与活代码的 `src/core/types.ts` 是两个不同文件，同名对照关系普遍存在，删前逐个复核。
- 其余四个工具做过同样的可达性遍历，**均无不可达文件**。

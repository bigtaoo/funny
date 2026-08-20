# 服务端 — 覆盖率百分比工具与 CI 稳定性（2026-08-13 ~ 08-15）

> 从 [`server-testing.md`](server-testing.md) 拆出（2026-08-20，原文件 501 行，ADR-067）。姊妹分册：[`server-testing-coverage.md`](server-testing-coverage.md)（各服务逐个补测记录）、[`server-testing-typecheck.md`](server-testing-typecheck.md)（`test/**` 类型检查）。
> 本册是工具/流水线侧：怎么量出百分比、90% 门禁怎么加、CI 怎么并行拆分、以及「PR 绿了、合进 main 却红」那轮 flaky 治理。下文各处「见下方各自小节」指的是各包的补测记录，现在在 [`server-testing-coverage.md`](server-testing-coverage.md)；下文「前两节」指的是 hub 上保留的那两轮人工审计。

## 测试覆盖率百分比工具（2026-08-13）

不要与前两节"server 端测试**覆盖审计**（2026-08-05/08-10）"混淆——那两节是人工审计"哪些代码路径完全没测过"，这里是 CI 里自动量出**行/分支/函数覆盖率百分比**的工具接入，client 同一批改动见 `claudedocs/client-testing.md` 对应章节。

- **12 个 vitest workspace**（`shared`/`admin`/`analyticsvc`/`auctionsvc`/`botsvc`/`commercial`/`gameserver`/`gateway`/`matchsvc`/`metaserver`/`socialsvc`/`worldsvc`）：`vitest.config.ts` 加 `coverage: { provider: 'v8', reporter: ['text','lcov','html','json-summary'], exclude: [...coverageConfigDefaults.exclude, 'src/generated/**'] }`（proto/openapi 生成代码排除在外，不占分母）；`package.json` 加 `"test:coverage": "npm run pretest --if-present && vitest run --coverage"`（保留各自原有的 `pretest` codegen/proto:gen 步骤）。`@vitest/coverage-v8` 只在 `server/package.json` 根加一次 devDependency，靠 npm workspaces 的 node_modules 提升让 12 个子包都能解析到，不逐包重复声明。
- **`engine`**（唯一非 vitest workspace，走 `tsc -b` 编译到 `dist/` 后用 `node --test` 跑）：没有额外引入 c8/istanbul 依赖，直接用 Node 自带的 `--experimental-test-coverage`——`scripts/runTests.mjs` 新增 `--coverage` 参数，命中时给 `node --test` 追加 `--experimental-test-coverage --test-coverage-exclude=**/__tests__/** --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info`（spec reporter 保留原有终端输出+文本覆盖率表，lcov reporter 额外落一份文件供 CI 汇总脚本读）。`package.json` 的 `test:coverage` 在既有 `test` 脚本末尾加 `--coverage` 转发给 runTests.mjs。
- **CI**（`.github/workflows/ci.yml`，`build-test` job）：`server unit + e2e tests` / `client unit tests` 两步从 `npm test` 换成 `npm run test:coverage`（`npm run test:coverage --workspaces --if-present` 在 server 根一次触发 12 个子包）；job 最后新增 `test coverage report` 步（`if: always()`），跑仓库根 `scripts/coverageSummary.mjs` 读每个包的 `coverage/coverage-summary.json`（vitest json-summary）或 `coverage/lcov.info`（engine），拼成一张 Markdown 表写进 `$GITHUB_STEP_SUMMARY`（GitHub Actions 跑完后运行摘要页可见），外加一行整体加权百分比。这一步本身**纯报告，不设硬性阈值门槛**——某个包这次没跑测试（文件缺失）显示 `—` 而不是让整个 job 变红，脚本本身永不 throw。
- **⚠️ 90% 硬性门槛（2026-08-15，14 个包全部拉到 ≥90% 之后加的）**：`coverageSummary.mjs` 原本读的 package 列表 + 两种解析器（`coverage-summary.json`/`lcov.info`）抽成 `scripts/coverageLib.mjs` 共享，新增 `scripts/checkCoverageThreshold.mjs`（同样从仓库根跑，读同一批 `coverage/` 产物）——只看**行覆盖率**（跟本仓库所有"补测"记录/记忆笔记一直沿用的口径一致，分支/函数只是参考不设门槛），任何一个包 <90%（或 `coverage/` 完全没产出，按"数据缺失=不达标"处理，不静默放过）就把这一步标红退出 1；阈值可用 `COVERAGE_THRESHOLD` 环境变量覆盖（默认 90）。`coverage-report` job 里紧跟 `test coverage report` 之后加了一步 `enforce >=90% line coverage per package`（同一个 `if: always() && github.event_name != 'pull_request'` job，PR 上不跑，只在 push-to-main / `workflow_dispatch` 那次跑），刻意拆成独立脚本/步骤而不是改 `coverageSummary.mjs` 本体——报告步骤按设计"永不失败"，门槛步骤按设计"低于阈值必须失败"，两者语义相反不能合并。**副作用（预期之内、正是要的效果）**：8 个 `*-deploy.yml` 都靠 `workflow_run.conclusion == 'success'` 门控，`coverage-report` job 一旦因这步变红，整个 `ci.yml` 的 workflow conclusion 变成 failure，所有部署自动被挡下——把"覆盖率是发布质量信号"从只读提示升级成了真正的发布闸门。**（2026-08-15 同日修订：`if: always() && github.event_name != 'pull_request'` 里的 PR 排除条件已删除，门禁在 PR 上同样生效；另加 `TESTS_OK` 判据——测试 job 已经挂了时不再把"缺 coverage 产物"报成第二条红。见下方"CI 稳定性"节。）**
- **`.gitignore`**：仓库根加了不带 `/` 前缀的 `coverage/`，一次性盖住 `client/coverage/`、每个 `server/*/coverage/` 和 `server/engine/coverage/`。
- **本地用法**：任意 workspace 目录下 `npm run test:coverage`；产物在该目录的 `coverage/`（`index.html` 可直接浏览器打开看逐行高亮，同 C#/coverlet 的体验）。

**2026-08-14 CI 并行拆分**（单 job 累计 10+ 分钟后的响应）：原单一 `build-test` job 里 server→client→tools 三段 `npm run test:coverage`/typecheck/build 全部挤在同一个 runner 上顺序跑；用实测数据定位瓶颈——`server unit + e2e tests` 这一步单独就要 ~11-12 分钟，其中 `metaserver`（~6.3 分钟）+ `worldsvc`（~3.3 分钟）两个包占了 ~85%（两者 `vitest.config.ts` 都设了 `fileParallelism: false`，注释写明是为了防止同进程内多个 e2e 文件抢同一个 mongodb-memory-server 实例产生数据竞争——**不是**意外遗留的慢速开关，不要不经排查直接打开）。拆分方案：
  - `build-test` 拆成 5 个独立 job：`server-checks`（codegen/filelength/typecheck，快，~40s，不含测试）、`server-test`（**matrix 三分片**：`metaserver` / `worldsvc` / 剩余 11 个包合成一组 `rest`，各自独立 runner + 各自的 mongodb-memory-server 实例，互不共享——分片跑在不同 runner 上，`fileParallelism:false` 那条"同进程内不许并发"的约束天然不适用，不用碰 vitest 配置）、`client-test`（typecheck/unit/UI smoke/build）、`tools-test`（5 个工具的 typecheck/test + 4 个的 build）、`coverage-report`（`needs: [server-test, client-test]`，聚合前四者上传的 coverage artifact 后跑同一份 `scripts/coverageSummary.mjs`）。GitHub Actions 里没有 `needs` 依赖的 job 默认并发跑在各自 runner 上，四个测试类 job 从"顺序执行"变成"并发执行"，服务端总耗时从 ~11-12 分钟降到受最慢分片（`metaserver`，~6.3 分钟）限制。
  - **coverage artifact 拼接细节**（容易踩坑的地方）：`actions/upload-artifact` 会把 artifact 内部路径"归一化"到所给 `path` 的最小公共祖先——单个目录当 `path` 时，产物会被拍平成该目录的**内容**（丢失目录本身这层前缀）；多个显式路径共享同一祖先时，则保留各自相对该祖先的子路径。`metaserver`/`worldsvc`/`client` 三个分片各自只上传一个包的 `coverage/` 目录（触发"拍平"），下载时对应地各自 `path:` 指到目标包自己的 `coverage/` 目录；`rest` 分片一次上传 11 个包的 `coverage/`（共同祖先是 `server/`），下载时整体 `path: server` 才能还原出 `server/<pkg>/coverage/...` 结构给 `coverageSummary.mjs` 读。四个下载步骤各自 `continue-on-error: true`——某个分片这次没跑起来（比如提前失败）就让对应包在报告里显示 `—`，不拖累整个聚合 job。
  - **⚠️ 同日续：拆分本身只是"摊平"，没消掉工作量——真正的退化源是 coverage，已把它挪出 PR 路径**。拆完之后 owner 拿出历史数据打脸：`main` 上 PR #93~#98 那批运行**一直是 ~7 分钟**（如 PR #98 的 `build-test` job 397s，`e2e` job 425s，wall clock = 425s），而 PR #99 未拆分时是 **27m50s**、拆分后仍有 **~16 分钟**。复盘发现最初的瓶颈定位起点就选错了——拿 PR #99 那次失败运行（13 分钟）当"现状基线"，从没去查 `main` 的历史运行，于是优化目标从一开始就偏了。逐步骤对照 PR #98 vs PR #99 才看清多出来的 ~20 分钟全部来自 `13.08.2026` 分支自己引入的两项（都不是拆分引入的）：①**`f8515745` 把 client 的 CI 命令从 `npm test` 换成 `npm run test:coverage`**——同一批测试文件（`test/difficulty/ch1-6` + `pvpSim` 那些 commit 早就在 `main` 里），**188s → 668s，v8 埋点让它慢了 3.6 倍（+480s）**；v8 instrumentation 的税恰好砸在最慢的那几个测试上（`difficulty/*` 和 `pvpSim` 跑的是完整无头战斗模拟，`ch6` 单个 331s，几千 tick 的引擎循环每一 tick 都在交这个税）。②`NW_REQUIRE_DB` 让 server 那 ~110 个 e2e 第一次真跑（+688s）——这条是真实质量提升，保留。**处理**：coverage 只在 **CD 前那次 CI** 跑（push 到 `main`——即 `workflow_run` 门控全部 8 个 `*-deploy.yml` 的那次——外加手动 `workflow_dispatch`），PR 上一律跑无 coverage 的 `npm test`。实现是 `server-test`/`client-test` 两个 job 各挂一个 job 级 `env: TEST_SCRIPT: ${{ github.event_name == 'pull_request' && 'test' || 'test:coverage' }}`，`run:` 里统一 `npm run "$TEST_SCRIPT"`；`upload coverage artifact` 两步和整个 `coverage-report` job 同步加 `github.event_name != 'pull_request'` 条件（PR 上没有 coverage 产物，否则报告整张表全是 `—`）。**为什么这么换是安全的**：14 个包（13 个 server workspace + client）**每一个**的 `test` 与 `test:coverage` 都验证过是同一条命令、只差一个 `--coverage` 标志（`engine` 是 `runTests.mjs --coverage`），且 14 个包两条 script **全都存在**——这点必须核对，否则 `--if-present` 会让缺 script 的包被静默跳过，正是本文档上面记过的那类"假绿"事故。`test:coverage` 里多出的 `npm run pretest --if-present` 只是补 npm 仅对 `test` 这一个名字自动触发 `pretest` hook 的差异，两者等价。所以 **PR 门禁强度零变化，只是不再产出报告**。**⚠️ 这条论证 2026-08-15 被推翻并回滚了**：`test` 与 `test:coverage` 确实是同一批文件、同一批断言，但**不是同一批失败**——v8 插桩把每个 await 窗口都拉长（同 commit 实测 worldsvc 184.53s→226.27s），时序敏感的 e2e 在 main 侧更容易挂，而 90% 门禁又只在 main 存在；结果是 main 上一天红两次、8 个 deploy 全被挡。现已改回两端一律 `test:coverage`，详见下方"CI 稳定性"节。理由本身也站得住：这份 coverage 按本节自己的定义就是"纯报告，不设硬性阈值门槛"、永远不会让 run 变红——在 PR 上它是拿三倍关键路径换一张 Markdown 表；而在 CD 前那次，这个数字确实被当作发布质量信号读，且没人卡在那儿等。预期 wall clock：client-test ≈ 916s−480s ≈ 436s、server 最慢分片 465s、e2e 408s 三者并行 ≈ **8.5 分钟**，比 7 分钟基线多出的 ~1.5 分钟就是"server e2e 从假绿变真跑"的必要成本。
  - **有意不做的事**：没有进一步把 `metaserver`/`worldsvc` 各自内部再用 vitest 原生 `--shard` 切成更小分片——那样能把两者都压到 ~3 分钟左右，但每个分片各自产出的 `coverage-summary.json` 只反映它跑到的那部分测试文件，`coverageSummary.mjs` 现有的 `readLcov`/`readJsonSummary` 都是整包读一份文件、不做跨分片按文件去重合并，会导致覆盖率数字失真（尤其 lcov 按 SF: 块求和的写法，同一源文件被两个分片各自命中一部分会重复计入分母）——如果以后真需要再压这两个分片的时间，要先给 `coverageSummary.mjs` 补上按文件路径去重合并的逻辑，而不是简单再加一层 matrix。

**首次实测基线（2026-08-13，行覆盖 %，本地跑出，用于对照未来回归）**：

| 包 | 行覆盖 | 分支 | 函数 |
|---|---|---|---|
| client（`src/game/**`） | 91.2% | 87.8% | 84.4% |
| engine | ~~86.5%~~ **92.98%**（2026-08-15 补测，见下） | 92.21% | 91.72% |
| shared | ~~82.3%~~ **98.96%**（2026-08-15 补测，见下） | 94.8% | 97.67% |
| worldsvc | ~~82.9%~~ **95.82%**（2026-08-15 补测，见下） | 87.57% | 97.93% |
| analyticsvc | ~~87.6%~~ **95.61%**（2026-08-15 补测，见下） | 97.56% | 98.64% |
| matchsvc | ~~88.3%~~ **93.99%**（2026-08-15 补测，见下） | 97.53% | 99.05% |
| commercial | ~~81.4%~~ **93.64%**（2026-08-14 补测，见下） | 76.9% | 91.8% |
| socialsvc | ~~78.4%~~ **94.71%**（2026-08-14 补测，见下） | 84.9% | 84.8% |
| botsvc | ~~70.0%~~ **92.74%**（2026-08-14 补测，见下） | 83.6% | 83.2% |
| auctionsvc | ~~72.3%~~ **92.0%**（2026-08-14 补测，见下） | 76.9% | 68.2% |
| gateway | ~~65.9%~~ **93.07%**（2026-08-14 补测，见下） | 70.3% | 76.8% |
| gameserver | ~~62.5%~~ **91.9%**（2026-08-14 补测，见下） | 91.4% | 95.9% |
| admin | ~~47.1%~~ **93.39%**（2026-08-14 两轮补测，见下） | 74.6% | 44.3% |
| metaserver | ~~35.1%~~ **90.84%**（2026-08-14 两轮补测，见下） | 78.4% | 32.3% |
| **加权总计** | **~70%** | **~82%** | **~71%** |

> 上表是 2026-08-13 的一次性基线快照，未逐行回填每次补测后的新值（metaserver→61.17%、admin→64.92% 均见下方各自小节）；gameserver 这行例外标了删除线，因为下一节紧接着就是它。

**metaserver 明显偏低**：`src/equipment/{craft,enhance,equip,reforge,salvage,trade}.ts`、`src/paddle/*`、`src/service/auth/{credential,helpers,oauthBind,profile,support}.ts`、`src/service/economy/*` 大片 0~10%——不是这轮改动引入的缺口，是这个包本身路由面最大（9 个 mixin/69 测试文件）但装备/Paddle/OAuth 这几块此前的 e2e 覆盖没跟上。**admin 47%**次低，同理。两者列为下一轮"server 端测试覆盖审计"（见上文 2026-08-05/08-10 两节）的优先输入，本轮不展开修——这次的目标只是把量出百分比的工具接上，不是把百分比刷高。

---

**里程碑（2026-08-15）**：至此 **14 个包（client + 13 个 server workspace）全部 ≥90% 行覆盖率**——本节工具接入以来跑的"修最低覆盖率"轮次到此告一段落，此后除非有改动引入回归，不必再按"哪个包最低"排队处理；各包仍标注的"未继续追"残余缺口（`levelSchema/*`、`mapTemplateService.ts`、`httpApi/*Routes.ts` 等）留作按需处理，不再是"最低优先级"驱动。

## CI 稳定性：让"PR 绿了、合进 main 却红、于是不部署"不再发生（2026-08-15，worktree `feat/ci-stability`）

**触发**：同一天 main 上 CI 红了两次（PR #101 run `31887181835`、PR #103 run `31902034760`），两次都在对应 PR 的 CI 已经绿了之后；8 个 `*-deploy.yml` 都靠 `workflow_run.conclusion == 'success'` 门控，于是"合并了但没上线"。事故面的记录见 `design/product/deploy-cloudflare.md` §6 同名小节（那里侧重部署侧），这里记测试/CI 侧。

**结论：根因是测试套件本身不确定，不是两条流水线检查内容不同。** 证据三条：

1. 三次 main 红各不相同——#101 metaserver `pvp-card-stats`（读抢在 fire-and-forget 写前面）、#103 worldsvc `httpApiActionSiegeMapGaps`（`PATH_BLOCKED`）、7-29 #76 full-link E2E。
2. **PR 也一样在 flake**：最近 100 次 CI 中 PR 失败 20 次，`31898655236`（PR，worldsvc shop TOCTOU）重跑后才绿。PR 是"重跑到绿"的**有筛选样本**，main 每次合并只跑一次——同样的 flake 率，只有 main 侧会被看见。这是观感的第一位成因。
3. #103 那次的直接原因可以证明与 coverage 无关：`POST /world/join` 自动选点走 `Math.random()`（`core/spawn.ts` `pickRandomEmptyTile`），首都落点每次不同，而该文件每个用例都以首都为原点取目标（`findCoord(…, baseX + 30, …)`）再行军过去——两点之间有没有路可走是**每次一掷**。

**放大器（真实存在的 PR/main 不对称，已全部消除）**：

- `TEST_SCRIPT` 让 PR 跑 `test`、main 跑 `test:coverage`。上一节 2026-08-14 那条改动的论证写的是"same test files, same assertions, same failures"——前两句成立，第三句不成立：v8 插桩把每个 await 窗口都拉长（同 commit 实测 worldsvc `184.53s → 226.27s`，collect `20.26s → 41.23s`；client 按当时自己的测量是 188s→668s），时序敏感用例在 main 侧概率更高。
- 90% 覆盖率门禁只在 main 跑 → 覆盖率回归在 PR 上原理上测不出来。
- shard 挂 → 无 coverage 产物 → 门禁再报一次 `no coverage/ output found`（#101 就是这样两条红），更响的假红盖住真因。

**本轮改动**：

- **确定性（治本）**：`httpApiActionSiegeMapGaps.e2e.test.ts` 的 `beforeAll` 改成显式坐标建都（`svc.joinWorld(W, 'acct-1', x, y)`，坐标由 `findCoord` 在固定锚点附近确定性地选出），整份文件从"每次一掷"变成"要么次次过、要么次次挂"；本地连跑 5 次全绿。`WorldServiceDeps` 新增可注入的 `rng?: () => number`（默认 `Math.random`，`SpawnService` 的选点与洗牌都走它），供必须验证自动选点路径的用例钉死随机源。
- **PR/main 同命令**：`ci.yml` 删掉 `TEST_SCRIPT`，两个 job 一律 `npm run test:coverage`；两处 `upload coverage artifact` 和 `coverage-report` job 去掉 `github.event_name != 'pull_request'` 条件，覆盖率门禁因此同时在 PR 生效。
- **client 那笔 3.6 倍的税直接买断，不是硬扛**：原先"PR 不跑 coverage"的唯一实质理由是 client 的 188s→668s。实测发现这笔税几乎全部来自 `test/difficulty/**` + `test/pvpSim.test.ts`（整场无头战斗模拟，几千 tick 每 tick 都在交插桩税），而**它们对覆盖率的贡献是 0.05 个百分点**（把它们排除后 client 行覆盖 91.20% → 91.15%——它们碰到的 `src/game/**` 早被单元测试覆盖了，它们本质是"第 6 章还打得过吗 / PvP 模拟还在区间内吗"的行为回归，不是覆盖率来源）。于是拆出 `client/vitest.sim.config.ts`：这批文件照跑（`test` 和 `test:coverage` 都在末尾链一条 `npm run test:sim`），只是**不插桩**。带 coverage 的那半从 668s 掉到 ~13s，两端全量 coverage 的总时长反而和过去 PR 上不带 coverage 的 188s 基本持平。**代价**只剩 server shard 的 ~+25%——等在 PR 上是便宜的，红在已合并的 commit 上是不能接受的。
- **retry + 可见性**：12 个 server workspace 的 `vitest.config.ts` 加 `retry: 1`（client 的 e2e/load 两个 config 同样加），并挂 `scripts/flakyReporter.mjs`——把"失败后重试才过"的用例输出成 GitHub `::warning::` 注解 + step summary 表 + `flaky-report.json`（CI 作为 artifact 上传，保留 7 天）。**retry 不是用来和 flaky 共存的**：它把 flaky 从"阻断部署"降级为"可见的待办"，全靠这个 reporter 保证它没被藏起来；一个需要 retry 才过的用例仍然是要修的 bug。client 的**单元测试没有加 retry**——那是纯逻辑套件，没有 DB/网络这类正当的重试理由，加了只会掩盖真实的不确定性。
- **级联假红**：`checkCoverageThreshold.mjs` 读 `TESTS_OK`（ci.yml 用 `needs.*.result` 传入）。测试 job 已挂时缺产物记为"跳过"、退出 0（run 反正已经红、也不会部署）；测试全绿时缺产物仍 fail-closed（那才是真的"覆盖率悄悄不产出了"）。
- **主动发现**：`.github/workflows/flake-hunt.yml`，每晚 02:00 UTC 把 metaserver/worldsvc/rest/client 各连跑 3 次（带 coverage，复现同样的时序），失败即报——树没变，所以任何一次挂都是不确定性；同时收集各 shard 的 `flaky-report.json`（保留 30 天）。可 `workflow_dispatch` 指定 `runs`/`shard` 手动追查。
- **兜底**：`.github/workflows/ci-rerun-once.yml`，main 上失败的 CI run 自动 `gh run rerun --failed` 一次（`run_attempt == 1` 卡住上限，只对 `push` 事件，PR 不自动重跑）。覆盖的是 vitest retry 够不到的那层——runner 抽风、docker pull 超时、mongod 下载中断。重跑成功会重新发一次 `workflow_run: completed`，deploy 照常触发，不需要在 8 个 deploy workflow 那边做任何改动。
- **结构性（本仓库暂时用不了，已确认）**：`ci.yml` 加了 `merge_group:` 触发器，但**GitHub merge queue 只对「组织（organization）名下的仓库」开放，个人账号名下的仓库无论公开与否都用不了**——`bigtaoo/funny` 属于个人账号，API 建 `merge_queue` 规则一律 422 `Invalid rule 'merge_queue'`（同一次调用里其它规则改动能成功，排除了权限问题；GraphQL `repository.mergeQueue` 恒为 null）。想要就得把仓库转到一个组织下（公开仓库转组织后免费可用）。触发器留着，转组织当天即生效，不用改 workflow。
- **替代品（已启用）**：ruleset `Only PR` 的必需检查里补上了 `test coverage report`（此前不在列表里，覆盖率门禁挡不住 PR），且该 ruleset 本来就开着 `strict_required_status_checks_policy: true`——**分支必须先与 main 同步才能合并**，等于强制 PR 的 CI 跑在「已经包含最新 main」的树上。在本仓库这种单人、日均 1~2 个 PR 的节奏下，这条已经覆盖了 merge queue 的绝大部分收益（差别只剩「CI 跑在真正的 merge commit 上」+ 串行排队）。

**写测试时的确定性规则（本轮沉淀，评审按这个看）**：

1. **不许依赖没注入的随机源**。业务代码里的 `Math.random()` 要么走注入（如本轮的 `WorldServiceDeps.rng`），要么测试绕开它（显式坐标/显式 id）。
2. **不许"写完立刻读" fire-and-forget**。正确姿势是 `vi.waitFor` 轮询（先例：`metaserver/test/pvp-card-stats.e2e.test.ts`、`gameserver/test/lifecycle.test.ts`）。
3. **并发用例不许断言具体的交错**。断言要对所有合法交错都成立（先例：`worldsvc/test/review-fixes-2026-08-03.e2e.test.ts` 的 coin conservation 写法）；确实要覆盖某条竞态分支时，注入钩子把那个交错**制造出来**（同文件的 `onSpend`），别指望调度器碰巧给你。
---

## 守卫脚本自己接入测试 + 两条 canary（2026-08-20，worktree `feat/guard-script-tests`）

`server/scripts/checkWorkspaceCoverage.mjs` 和根 `scripts/checkFileLength.mjs` 是两道 CI 门禁，此前**零测试**。这不是"顺手补个覆盖率"——这两个脚本的失效方式是**变绿**：

- `checkWorkspaceCoverage.mjs` 的每一个检查都在遍历 `package.json#workspaces`。列表为空时所有循环都是空转，它会打印 `OK — all 0 workspaces` 并退 0，看上去像一次干净的运行。
- `checkFileLength.mjs` 在 `collectSourceFiles` 返回空数组时打印 `scanned 0 source files, 0 over 500 lines` 并退 0 —— 跟"仓库很健康"的输出无法区分。`--root` 写错、`EXCLUDE_DIRS` 被放宽、某个 `--exclude-prefix` 打错字，门禁就此静默退休。

也就是说，**这两道门禁一旦坏掉，症状是 CI 一直绿，没有任何东西会察觉**。`scripts/checkDocLinks.mjs` 早就为这件事写了 canary（"if this ever hits zero the scan silently stopped working … every check below would pass vacuously"），这两个没有。

**做法**

- 各补一条 canary：workspaces 为空 → 失败；扫到 0 个源文件 → 失败。两条的报错都明说"这次运行什么也没验证"，而不是报告成功。
- `checkWorkspaceCoverage.mjs` 加 `--root=<dir>`（默认仍是脚本自身所在的 `server/`，CI 不变），拼写与兄弟脚本 `checkFileLength.mjs` 早已有的那个一致。这是让它能对着 fixture 目录树跑的唯一改动，**没有**为了可测性去重构内部结构。
- 新增 `shared/test/guardScripts.test.ts`（21 例）：**spawn 真正的 CLI 入口，断言退出码 + stdout**，不 import 内部函数。理由是退出码才是 CI 真正消费的契约；fixture 是 `mkdtemp` 出来的临时目录树，`afterEach` 清掉。
  - `checkWorkspaceCoverage` 11 例：happy path、canary、workspace 漏在 `tsconfig.build.json#references` 外、references 里有已删服务的残留条目、缺 `tsconfig.test.json`、缺 `typecheck:test` 脚本、**exclude 被 fulllink 程序接管（通过）**、无人接管（失败）、接管程序文件整个不存在（失败，而不是当成"没什么要查的"）、glob exclude 被拒、两类问题同时出现时都报出来。
  - `checkFileLength` 10 例：happy、canary、新超限文件不在 baseline、baseline 内不超、超过 baseline 记录值、reason 太短（G3 形状规则）、超过 hard cap、baseline 条目已缩回限内（非阻塞提示且退 0）、`generated/`+`test/`+`.d.ts` 确实被跳过、用法错误退 2。
- 最值得钉的是那条**通过**方向的用例：ownership 检查两边的路径拼写故意不同（`exclude` 相对 `server/<ws>/`，`include` 相对 `client/`），只有归一成同一种 repo 相对 POSIX 形式才对得上。归一写坏了会 fail-closed（吵闹但安全），所以真正需要证明的是"它确实能对上"，而不是"它会报错"。

**顺带发现（不在本次范围内修）**：跑真仓库时 `check:filelength` 在当日分支上**本来就是红的**，两处都来自别的会话的合并——`server/shared/src/slg/core.ts` 687 行且不在 baseline（2026-08-19 那批 `isCityGroundTile`/`tileFeatureBuilding` 上移导致），`client/src/net/WorldApiClient.ts` 544 行 vs baseline 542。canary 只在"扫到 0 个"时才触发，跟这两条无关；主检出上未带任何本次改动复现同样结果。拆还是进 baseline、以及 +2 的理由，都该由改动它们的人定。

**验证**：新用例 21/21 绿（两条 off-by-one 期望值在首跑时就被自己咬出来了，说明它们真的在读输出而不是只看退出码）；`shared` 全量 52 文件 1021 例绿；`shared` `typecheck:test` 干净；两个脚本对真仓库跑的结果与改动前一致（`checkWorkspaceCoverage` 绿；`checkFileLength` 红在上面那两条既有问题上）。

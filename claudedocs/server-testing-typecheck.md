# 服务端 — `test/**` 接入类型检查（2026-08-19 ~ 08-20）

> 从 [`server-testing.md`](server-testing.md) 拆出（2026-08-20，原文件 501 行，ADR-067）。姊妹分册：[`server-testing-coverage.md`](server-testing-coverage.md)（各服务逐个补测记录）、[`server-testing-tooling.md`](server-testing-tooling.md)（覆盖率工具 / CI）。
> 本册三节连成一条线：13 个包各补 `tsconfig.test.json` → 唯一豁免由 `client/tsconfig.fulllink.json` 接管 → 顺势清掉它留下的类型债。

## `test/**` 首次接入类型检查：13 个包各补 `tsconfig.test.json`（2026-08-19，worktree `feat/server-test-typecheck`）

**背景**：每个 workspace 的 `tsconfig.json` 只 include `src/**`，而 vitest 走 esbuild（只擦类型、从不检查），所以 **13 个包、约 380 个测试文件从来没有被类型检查过**。客户端早就用 `client/tsconfig.test.json` + `npm run typecheck` 关掉了这个口子（CI 在跑测试前先跑它），服务端一直没有。首次接上后一次性暴露 **758 个错误 / 140 个文件**。

**做法**

- 每个包新增 `tsconfig.test.json`：`extends ./tsconfig.json` + `include: ["src/**/*", "test/**/*"]` + `rootDir: "."` + `composite/declaration:false` + `noEmit`。engine 早就有一份（它的 `test` 脚本本来就 `tsc -p tsconfig.test.json` 编译后再跑），只补脚本。
- 每包 `typecheck:test` 脚本；根 `npm run typecheck:test` 用 `--workspaces --if-present` 扇出；CI `server-checks` job 在现有 `tsc -b` **之后**加一步跑它。
- `scripts/checkWorkspaceCoverage.mjs` 加两条断言：每个 workspace 必须有 `tsconfig.test.json` 和 `typecheck:test` 脚本（根扇出用的是 `--if-present`，少了脚本会被**静默跳过**，正是这个脚本存在的意义）。

**三个必须知道的配置坑**

1. **`references` 不会被 `extends` 继承**，必须在 `tsconfig.test.json` 里原样重复一遍。否则 `@nw/shared` 会退回 node_modules → `shared/dist/*.d.ts`，在没 build 过的检出里直接 240 个假 TS2307（光 metaserver 就这么多）。即便重复了，这些程序仍是**非 build 模式**，依赖 `tsc -b` 产出的 `dist/*.d.ts` 存在——所以 CI 里这一步必须排在 `tsc -b` 之后。
2. **`module` 要跟着 vitest 的现实走**：继承下来的 CommonJS 会让若干 e2e 里的顶层 `await` 报 TS1378（vitest 按 ESM 转译，运行时完全合法），所以除 metaserver 外都覆盖成 `ES2022`。metaserver 自己是 `NodeNext`，强行改成 ES2022 会 TS5110；但它在 NodeNext 下又会要求 `../src/x` 写成 `../src/x.js`（TS2835），所以单独覆盖成 `ESNext` + `moduleResolution: Bundler`——这才是 vitest 实际的解析方式。
3. **auctionsvc 排除了 `test/auction-fulllink.e2e.test.ts`**（配置里有注释）：它故意 import 真实的 client `WorldApiClient`，会把 DOM 全局 / pixi / @bufbuild 拖进一个 Node-only 程序，要检查它就得在 server-checks job 里装 client 依赖并加 `lib:DOM`。当时是全仓库唯一一个不检查的测试文件；**次日（2026-08-20）由 `client/tsconfig.fulllink.json` 接管**，见下一节——`exclude` 保留（它确实不该进 Node-only 程序），但文件本身不再是豁免。

**758 个错误的分布与修法**（多数是机械的，但每一类都藏着"测试其实没在验证它自称验证的东西"）

| 类别 | 量级 | 修法 |
|---|---|---|
| `Response.json()` 返回 `unknown` | ~230 | 每包一个 `test/jsonBody.ts`（带注释的单点 cast，支持传具体类型），不是满地 `as any` |
| 假实现落后于接口（少方法/少字段） | ~120 | 补上的成员一律 **throw `not stubbed`**，不返回假成功——这些成员本来就不存在，任何调到的路径早就崩了，抛错只是把崩溃变得有名字 |
| 假实现留着接口已删的成员 | ~30 | 直接删（类型上读不到，删了不改变行为） |
| `noUncheckedIndexedAccess` 下的下标/属性链 | ~150 | 加 `!`（纯类型层，运行时零影响） |
| `vi.fn(async () => x)` 声明了零参数，测试却断言 `mock.calls[0][1]` | ~80 | 给 mock 声明 `...unknown[]` 参数 |
| 测试双写的 Mongo/响应体 cast 不重叠 | ~45 | `as unknown as T` |

**顺带挖出来的真问题**（都不是格式问题）

- `metaserver/test/internal.test.ts` 40 处 `makeNewSave('a')` 少传 `now`——所有种子存档的时间戳是 `undefined`。
- `shared/test/internalFetch.test.ts` 用 `caller: 'metaserver'` 并断言出站 `x-internal-caller` 等于它，但合法值是 `'meta'`（`InternalCaller` 里没有 `metaserver`）——线上永远不会发出那个值。
- `admin/test/comp-mail.e2e.test.ts` 调 socialsvc `startHttpApi` 只给了 6 个参数中的 5 个（`meta` client 整个缺失），且 `FamilyService` 没给 `now`。
- `admin/test/clients-worldAuctionAnalytics.test.ts` 用 `status: 'active'` 查拍卖，而 `AuctionStatus` 是 open/sold/cancelled/expired。
- `worldsvc/test/sect-query-gaps.test.ts` 断言 `emblemKey: 'lion'`，而 `EMBLEM_KEYS` 全是 `emblem_*`。
- `CardInstance.xp` 在换成融合升级时就删了（`2d6b08a3`），31 处夹具还在写。
- **`metaserver` 的钱包镜像路径其实一直没被测到**：`FakeCommercial.getWallet` 只返回 `{coins, pity}`，而 `mirrorWalletFrom` 第一件事就是 `wallet.starterUsed.includes(...)` → 每次 `GET /save` 的镜像都在 `try/catch` 里静默 TypeError。补全 `WalletView` 后 `retention.e2e` 的 day-30 用例立刻挂了——因为它读的是"镜像失败才保住"的旧值；那个用例自己的注释早就写明"failingApp 必须复用同一个钱包账本"，但代码给的是 `new FakeCommercial()`。改成共用同一个实例后通过。
- 两处**生产类型**确实写错，测试是对的：`worldsvc/src/nationChannelService.ts` 的 Deps 要具体类 `HttpWorldGatewayClient` 却只用 `broadcast`（收窄成接口）；`PlayerWorldView` 从未声明 `hasBattlePass`，可 `getMe()` 一直在返回、openapi 里也有（补上）。
- 两个一次性迁移脚本（`metaserver/scripts/migrateCardInv.ts`、`samplePvpReplays.ts`）用 `Collection<Document>` 表示 string-keyed 集合，`{_id: accountId}` 过滤全是类型漏洞——它们被测试 import，这次一并类型化。

**验证**：13 个包 `typecheck:test` 全 0 错、根 `tsc -b` 全绿；各包测试套件全跑一遍确认没有行为回归（metaserver 1639 / worldsvc 917 / shared 956 / socialsvc 216 / commercial 213 / gateway 181 / botsvc 119 / gameserver 127 …）。

---

## 唯一的类型检查豁免归零：`client/tsconfig.fulllink.json` 接管跨包 full-link 测试（2026-08-20，worktree `feat/auction-fulllink-typecheck`）

**背景**：上一节把 13 个包的 `test/**` 都接进了类型检查，只留下一个洞——`auctionsvc/test/auction-fulllink.e2e.test.ts` 写在 `tsconfig.test.json` 的 `exclude` 里。它是唯一一个**跨包**测试：一头驱动真实的 `client/src/net/WorldApiClient`（浏览器构建实际发的那份代码），另一头打真实的 auctionsvc `startHttpApi` + `mongodb-memory-server`。它的类型错误此前对任何 CI 步骤都不可见。

**为什么不能塞进任何已有程序**（这三条决定了解法的形状）

- 它同时要 **DOM lib + `client/node_modules`**（`WorldApiClient` → `platform/IPlatform` → `import type * as PIXI from 'pixi.js-legacy'`，类型层真的要 pixi）**和 `server/node_modules` + node 类型**（`mongodb`、`import('http').Server`、`import('net').AddressInfo`）。没有任何现成程序是这个并集。
- 塞进 `auctionsvc/tsconfig.test.json` 等于把一个 Node-only 配置弯成第二份 client 配置，还要让 `server-checks` job 去装 client 依赖。
- 塞进 `client/tsconfig.test.json` 会撞 `paths`：client 故意把 `@nw/shared` 窄化成 `../server/shared/src/slg/index.ts`（只给客户端看 slg 子集），而这个测试要 `signToken`/`SlgError`/`EquipmentInstance`——全在完整 barrel 里、不在 slg barrel 里。

**做法**：新增第三个程序 `client/tsconfig.fulllink.json`，专门装「import 了 client 源码的 server 测试」。

- `extends ./tsconfig.json`（拿到 DOM lib、strict、`@nw/engine` 映射），**只覆盖三处**：
  - `paths` 里 `@nw/shared` 重新指向 `../server/shared/src/index.ts`（完整 barrel）。它是 slg barrel 的**超集**，所以 client 源码在这个程序里不会解析到不同的东西；而"客户端只能看 slg 子集"这条边界仍然由 `tsconfig.test.json` 把关——那才是真正 gate 客户端代码的程序。
  - `types: ["node"]` + `typeRoots` 指到 `../server/node_modules/@types`。**没有**把 `@types/node` 装进 client devDependencies：那会让浏览器代码引用 `process`/`Buffer` 也能通过主程序的类型检查，是一条有用的边界，不能为了一个测试文件拆掉。
  - `include` 只有一行（那个测试文件本身），其余全靠 import 追踪进来；以后有第二个跨包测试就再加一行。
- **宿主放 client 侧而不是 server 侧**，唯一理由是 CI：`client-test` job 本来就 `npm ci` 装了 **server/ 和 client/ 两份**依赖（步骤名"server install (client's @nw/engine + @nw/shared aliases resolve to server/ TS source)"），而 `server-checks` 只装 server/。这是全仓库唯一同时具备两侧依赖的 job。
- `client/package.json`：新增 `typecheck:fulllink`，并把它**链进** `typecheck`（`tsc -p tsconfig.test.json && npm run typecheck:fulllink`）。于是 CI 现有的 client typecheck 步骤零改动就覆盖到了，不用新增 job（只改了步骤名和注释）。
- **`exclude` 保留不动**：这个文件确实不该进 auctionsvc 那个 Node-only 程序。变的不是"要不要排除"，而是"排除之后有没有人接"。

**把「零豁免」变成可执行约束**：`scripts/checkWorkspaceCoverage.mjs` 加第三条检查——遍历每个 workspace 的 `tsconfig.test.json#exclude`，每一条都必须出现在 `client/tsconfig.fulllink.json#include` 里（两边路径都归一成 repo 相对的 POSIX 形式再比），否则失败并指名道姓告诉你加到哪。顺带**禁掉 glob 形式的 exclude**（`*`/`?`）：一旦允许通配，"这个文件到底有没有被某个程序检查"就变成不可判定的，守卫本身就失去意义。这条正是上一节留下的教训的推广——`exclude` 是个能悄悄把文件从检查里摘出去的旋钮，跟当年 `--if-present` 悄悄跳过缺失脚本是同一类问题。

**验证**：`client npm run typecheck`（两个程序）+ server `npm run typecheck` / `typecheck:test` / `check:workspacecoverage` 全绿；`auctionsvc` 那 8 个 full-link 用例照旧全过。三次反向验证：①往测试文件里注入两处类型错误（`price: 'ten'`、`const bogus: number = view.auctionId`），确认新程序**报了这两条**而不是静默通过；②把 `tsconfig.fulllink.json#include` 清空，确认守卫报"excluded ... without another program owning it"并退 1；③把 exclude 换成 `test/*.e2e.test.ts`，确认守卫报 glob 不允许并退 1。另外用 `tsc --listFiles` 确认程序里确实同时含 `client/src/net/WorldApiClient.ts`、`client/src/platform/IPlatform.ts`、`pixi.js-legacy`、`server/shared/src/index.ts`、`server/auctionsvc/src/httpApi`、`mongodb/mongodb.d.ts`（934 个文件），排除"程序其实是空的、所以当然全绿"这种假绿。
---

## `MatchReplayDoc.frames[].cmds[].commands`：`unknown` → `string`（2026-08-20，worktree `feat/replay-commands-string`）

上一节接入 `test/**` 类型检查时留下的第二笔类型债（第一笔是 full-link 那个豁免）。`@nw/shared` 的 `MatchReplayDoc` 把命令字节声明成 `unknown`，注释写的是「BSON binary（opaque game.proto bytes）」——**两个都是 2026-07-20 gzip 改动之前的遗留**。

**为什么 `string` 才是唯一正确的形状**（这条是本次改动的全部依据）

- `MatchReplayDoc` 从来不以 BSON 形式落库。自 2026-07-20 存储成本修复起，它只以 **JSON 形式存在于 gzip blob 里**（`compressReplayDoc` → `MatchDoc.replayGz` / `ReplayBlobDoc.replayGz`），而 `MatchDoc.replay` 这个内嵌字段早就不存在了（只剩 `replayGz` / `replayRef`）。全仓库 grep 确认没有任何代码还在读旧字段。
- JSON 没有字节类型。所以 Buffer 根本活不过这条管线：`JSON.stringify(Buffer)` 出来的是 `{"type":"Buffer","data":[…]}`，`JSON.parse` 回来就是那个对象，往下游裁判/复算一喂就是垃圾。
- 真正的字节→base64 转换只有**一处**：gameserver 的 `metaReport.ts`，把 `MatchReplay`（内部类型，`commands: Uint8Array`）转成 `MatchReplayDoc`（存储类型，`commands: string`）。两个类型之所以不同，就是这一步。

**改动**：`commands: unknown` → `commands: string`，并把注释改成说明「proto 里是 `bytes`，但这份 doc 只以 JSON 存在，所以是 base64」。随之删掉两处 `String(c.commands)` 强转（`metaserver/src/anticheatAudit.ts` 的 `toJudgeFrames`、`internal/matchReport/peerJudge.ts` 的 judge 调用）——它们对已经是字符串的值是空操作，只是把形状藏起来了；真要是 Buffer 走到那儿，`String()` 给出的也是垃圾而不是补救。顺手订正两句已经指向不存在字段的注释（`ReplayBlobDoc` 的 `MatchDoc.replay`、`balanceDocs.ts` 的 `MatchDoc.replay.decks`）。

`server` 全量 `tsc -b` + `typecheck:test` **零错误**——上一轮把 380 个测试文件接进类型检查时，已经把所有夹具规范成了字符串，所以这次收紧没有暴露任何调用方。

**补了两个此前不存在的用例，把契约的两端都钉住**（光收紧类型是编译期的事，运行时行为一个字没变，所以真正的价值在这两条）

- `shared/test/replayCodec.test.ts`：**为什么不能是字节**。故意越过类型塞一个 Buffer 进去，断言 round-trip 回来的是 `{type:'Buffer',data:[0,1,2]}` 而不是 Buffer；同一批字节的 base64 则原样回来且能解回原字节。等于把上面「JSON 没有字节类型」这句话变成可执行的。
- `gameserver/test/metaReport.test.ts`：**生产端确实做了 base64**。这个文件原有的 16 个用例**全部**用 `frames: []`，也就是说 `metaReport.ts` 里那行 base64 编码——两个类型差异的唯一理由——从来没有被任何测试执行过。新用例塞一帧真命令字节，从 POST 出去的 `replay_gz` 解回来，断言等于 `Buffer.from(bytes).toString('base64')` 且能解回原字节。反向验过：把那行的 `.toString('base64')` 去掉，用例立刻红在 `expected { type: 'Buffer', …(1) } to be 'BwD/Kg=='`——正是上面描述的失效形态。

**验证**：`server` `tsc -b` / `typecheck:test` / `check:workspacecoverage` 全绿；`shared` 51 文件 997 例、`gameserver` 11 文件 128 例（+1）、`metaserver` 全量套件全绿。两条新用例都做了 red-then-green 实测（破坏点见上），`MatchReplayDoc` 的收紧本身也反向验过（往夹具里塞 Buffer 确实报 TS2322）。

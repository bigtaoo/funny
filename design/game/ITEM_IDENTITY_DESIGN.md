# 物品身份基准：唯一id / 状态 / 溯源

> 状态：设计中（第1、2部分+称号实例化已实现，材料实例化为后续待办）· 权威：本文 · 更新：2026-08-10

## 0. 背景

拍卖行"选择物品"picker 从未接入皮肤类型（见 [AUCTION_DESIGN.md](AUCTION_DESIGN.md) §9 任务11），排查时发现用户抽到的多余皮肤没出现在列表里。修复过程中，用户提出更大的问题——**是否所有物品类型（材料/装备/角色卡/皮肤/称号）都应该有各自的唯一实例id、可追溯来源和当前状态**。本文记录一次全物品类型审计的结论，以及后续要不要/怎么补的决策（见 [DECISIONS.md](../DECISIONS.md) ADR-059）。

## 1. 现状审计（2026-08-04）

| 物品类型 | 存储模型 | 唯一id | 状态字段 | 来源溯源 |
|---|---|---|---|---|
| 装备（`EquipmentInstance`） | 实例化 map（`equipmentInv`/`equipmentInstances` 集合） | ✅ 服务端生成，Mongo `_id` 约束，全生命周期稳定 | ✅ 等级/词条/是否装备中（派生）/锁定 | ✅ 本次补上 `sourceType`/`obtainedAt`（见 §2） |
| 角色卡（`CardInstance`） | 实例化 map（`cardInv`/`cardInstances` 集合） | ✅ 同上 | ✅ 等级/装备槽/锁定 | ✅ 本次补上 `sourceType`/`obtainedAt`（见 §2） |
| 材料（scrap/lead/binding + `inventory.items`） | `Record<string, number>` 数量计数 | ❌ 无 | N/A（无等级/词条/品质随机性） | ❌ 无，`$inc` 原子加减不留痕迹 |
| 皮肤（`inventory.skins`） | `string[]` 去重集合（拥有=1份，不存在=0份） | ❌ 无 | N/A（无等级/词条） | ❌ 无，`grantSkin` 只是 `$addToSet` |
| 称号（`titles`） | `string[]` 去重集合，终身不可移除 | ❌ 无 | N/A | ❌ 无，连获得时间都不存（`titles.ts` 头部注释明确写了） |

**技术判断**：材料/皮肤/称号维持现有模型是合理设计，不是遗漏——三者都是"同质化可替换资源"（材料无词条/品质随机性；皮肤/称号无等级；跟金币一样，"这一份"和"那一份"在游戏机制上无差别），给它们逐一分配实例id不会解锁任何新玩法，只会带来存储/性能成本。给每份材料分配实例id的改造成本保守估计 **20-30+ 文件**，等价于把 `scrap`/`lead`/`binding` 提升到跟 `EquipmentInstance` 同一复杂度级别——库存操作从 Mongo `$inc` 原子加减换成"选择N份实例并原子移除"，所有奖励/掉落发放入口（战令/签到/充值里程碑/gacha/PvE 掉落）都要跟着重写成生成带来源标签的实例，存档体积从"3个数字"暴涨到"上千个实例对象"，重演 `deliveredOrders` 曾经因无上限增长导致读写变慢的性能坑。

**用户不同意这个判断**，明确要求全部物品类型最终都要有唯一id。本文 §3 把这个诉求落成一份分阶段任务清单，作为独立后续立项——不在 2026-08-04 这次任务里一并做。

## 2. 本次已实现：装备/角色卡溯源字段

`EquipmentInstance`/`CardInstance` 已有完整实例id + 状态，唯一缺口是"这件东西是哪次抽卡/合成/掉落获得的、什么时候获得的"——当前**没有任何功能消费**这个信息（无客服溯源工单、无反作弊审计读取它），纯粹是为未来这类需求预留。

- **字段**：`sourceType?: string`（如 `'craft'`/`'gacha:<orderId>'`/`'checkin:<monthKey>'`/`'pve_drop:<levelId>'`/`'pve_anchor:<levelId>'`/`'starter'`）、`obtainedAt?: number`（epoch ms）。均为可选，向后兼容，**不需要** `SAVE_VERSION` 迁移（老实例反序列化后就是 `undefined`）。
- **改动位置**：`server/shared/src/types.ts`（`EquipmentInstance`/`CardInstance`）、`server/shared/src/mongo.ts`（对应 Doc 类型）、`server/contracts/openapi/schemas.yml`（+ 级联 codegen）、`client/src/game/meta/SaveData.ts`（镜像）、`server/metaserver/src/{equipment.ts,cards.ts}` 的 `toInstanceDoc`/`fromInstanceDoc`/`toCardDoc`/`fromCardDoc`。
- **埋点位置**：装备 4 处创建点（`equipment.ts craftEquipment`／`economy.ts` gacha 产出／`service/liveops.ts` 月度签到终极档／`service/pve.ts` 掉落）；角色卡 `grantCards` 加 `sourceType` 必填参数，5 个调用方（`service/auth.ts` 新手赠卡／`service/liveops.ts` 签到卡包／`service/pve.ts` 章节首通锁定卡+掉落／`economy.ts` gacha 别名 `grantHeroCards`）各自传入字面值。
- 详见 [EQUIPMENT_DESIGN.md](EQUIPMENT_DESIGN.md) / [CHARACTER_CARDS_DESIGN.md](CHARACTER_CARDS_DESIGN.md) 的对应小节。
- **测试覆盖**（一个 stamping 点一条断言，2026-08-04）：`equipment.e2e.test.ts`（craft→`'craft'`）、`economy.e2e.test.ts`（gacha 装备/角色卡→`gacha:<orderId>`）、`retention.e2e.test.ts`（签到装备/角色卡里程碑→`checkin:<monthKey>`）、`pve.e2e.test.ts`（关卡掉落→`pve_drop:<levelId>`；章节首通锚点卡→`pve_anchor:<chapterId>`，ch1/ch2 各一条）、`pve-verify.e2e.test.ts`（spot-check verify 路径的掉落卡）、`save.e2e.test.ts`（新手赠卡→`'starter'`）；`server/shared/test/equipment.test.ts` 额外单测 `makeGachaEquipInstance`/`makeDropInstance` 两个工厂函数本身——纯透传调用方传入的 `sourceType`/`obtainedAt`，不做任何派生。

## 3. 后续待办：材料/皮肤/称号实例化（未排期，独立立项）

> 执行约定同 [AUCTION_DESIGN.md](AUCTION_DESIGN.md) §9：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成，按编号顺序做，每个任务独立 worktree + 独立分支。新会话直接说「开始物品身份任务N」定位到本节。

### 任务1：皮肤实例化 ✅（2026-08-08）

- **起因**：账号 tao 抽到一个重复皮肤，背包不显示、也拿不去拍卖——排查发现 `markDuplicates` 对重复皮肤是纯 no-op（不生成新实例，不补偿），GACHA_DESIGN §4.3 写的"重复退币"从未真正接入发货流程（`DUPE_REFUND_COINS` 此前只在离线 `econ-sim` 里用到）。
- [x] **数据模型**：新增 `SkinInstance{id, skinId, sourceType?, obtainedAt?}`（`server/shared/src/types.ts`）+ `skinInstances` 集合（`server/shared/src/mongo.ts`，`_id`=instanceId，索引 `{accountId,skinId}`）。**`inventory.skins: string[]` 语义完全不变**——仍是"当前是否拥有至少一份"的去重视图，`skin.ts` 负责在实例增减时同步它，这样已有的 ~20 处读取点（装备槽校验/`everOwned`/客户端等）零改动。
- [x] **`skin.ts` 重写**：`escrowSkin`/`grantSkin`/新增 `sellSkinToSystem` 都改成对 `skinInstances` 做增删；`escrowSkin`/`sellSkinToSystem` 的"已装备"限制从"完全禁止"放宽为"只保护装备中的最后一份"（`effectiveCount<=1` 才拒绝，`Math.max(count,1)` 兼容老账号——见下）；`grantSkin`（拍卖成交/撤单/过期归还）铸造一份新实例，皮肤同质无词条，不需要保留原实例身份。
- [x] **auctionsvc 契约刻意不改**：ADR-059 原计划挂单体从 `{skinId}` 改 `{instanceId}`（仿装备/卡牌），实现时改为**保持 `{skinId}` 不变**——`escrowSkin(accountId, skinId, orderId)` 对 auctionsvc 而言接口完全没变，内部实现从"字符串增删"换成"挑一份实例删掉"是纯粹的内部换血。理由：皮肤本就同质（无等级/词条），instanceId 对调用方毫无信息量，暴露它只会平白无故牵动 auctionsvc/contracts/client 三处（`auctionService.ts`/openapi-auction schema/`AuctionScene` picker），而这次真正要修的 bug（重复皮肤消失）跟"挂单体长什么样"无关。零改动即可验证：`auctionsvc` 全量测试原样通过。
- [x] **老账号自愈**（不做 SAVE_VERSION 迁移）：`assembleSkinCounts`（GET /save 的 skinCounts join，`app.ts` preSerialization hook，仿 `assembleEquipmentInv`）遇到"`inventory.skins` 里有、但 `skinInstances` 一份都没有"的 skinId，`$setOnInsert` 补一条 `sourceType:'legacy'` 的实例——幂等，并发调用不会重复补。`escrowSkin`/`sellSkinToSystem` 同样有 `Math.max(count,1)` 兜底，即使某个请求抢在自愈之前到达也不会误判"未拥有"。
- [x] **gacha 重复皮肤 = 真实例，不再自动转币**：`economy.ts` 的 `deliverLootBox`/`deliverGrant`/`deliverMailGrant`/`deliverOrder`（fate 兑换、商店直购）现在对**每一次**皮肤结果都铸造一个 `SkinInstance`（id 取 `skin_gacha_<orderId>_<i>` 等确定性格式，幂等），无论是不是重复——`markDuplicates`/`newSkins` 只决定 NEW 徽章和 `everOwned` 记账，不再决定"要不要发东西"。
- [x] **"卖给系统"= 玩家主动操作，绝不自动**：新增 `POST /skins/sell`（`skin.ts sellSkinToSystem`），售价复用已有的 `DUPE_REFUND_COINS[目录稀有度]`（legendary 1500/epic 400/rare 50/common 10，与 GACHA_DESIGN §4.3 一致，没有另编数字），走 `commercial.grant` 幂等入账。同一个"最后一份保护装备中"的规则同时用于挂拍和出售。
- [x] **客户端**：`SaveData.skinCounts?: Record<string,number>`（GET /save 自动 join，additive-only 字段，`migrate.ts` 的 `fillDefaults` 自动补 `{}`，未升版本号）；`AuctionScene` picker 的 `listableSkins()` 放宽为"未装备，或有多余份数"；picker 卡片新增"出售"分区（拍卖/出售各占底部一半热区），走 `client.sellSkin()` → `/skins/sell`。
- **验收**：`server/metaserver/test/skin.e2e.test.ts`（15 例，含"装备中的多余份可挂拍/可出售，最后一份仍被拒绝"、`grantSkin` 落地真实例、同一账号两次交易同一 skinId 叠出 2 份实例）+ `economy.e2e.test.ts` 新增断言（重复皮肤真的铸造第二个实例、`skinCounts` 正确、商店/命运点重复兑换同一皮肤也铸造第二实例、老账号 GET /save 自愈幂等不重复补实例）+ `mail-claim.e2e.test.ts` 新增断言（邮件附件重复皮肤同样铸造第二实例）；metaserver 全量 845 例、shared 713 例、auctionsvc 97 例全绿；client `tsc --noEmit` 全绿，UI 套件 1241 例 + 常规套件 1224 例全绿（含 `auctionPickerDedupe.ui.ts` 新增 6 例：放宽后的 listableSkins、"×N"标签、onSell 接线、双击防抖、渲染不崩溃；`api-client.test.ts`/`migrate.test.ts` 各新增 `sellSkin` 请求体 / `skinCounts` 向后兼容补全用例）。

### 任务2：材料实例化（范围最大，依赖任务1的实例化模式跑通后再做）

- [ ] **范围**：`materials: Record<string,number>` + `inventory.items: Record<string,number>` → 每份材料一个独立实例。
- **前置**：任务1完成后，materials 复用同一套"实例化仓库"基础设施（集合 schema 模式、escrow/grant 范式、拍卖挂单范式），避免重复设计。
- **影响面最大**：所有奖励发放入口——战令（`battlepass.ts`）/ 留存签到（`retention.ts`）/ 充值里程碑（`rechargeMilestone.ts`）/ gacha（`gachaCatalog.ts`）/ PvE 掉落 / SLG 大世界资源产出——目前全部是 `{kind:'material', id, count}` 匿名数量增量，要逐一改成"生成N个带来源标签的实例"。库存操作从 Mongo `$inc` 原子加减换成"选择N份实例并原子移除"，需要设计选择策略（扣10个scrap该扣哪10份实例？大概率是"任意选，因为材料同质"，但要写清楚）。
- **性能预算**：材料产出频率远高于装备/卡牌（战斗/签到批量掉落几个到几十个），存档/集合大小要有上限（参考 `deliveredOrders` 的 `DELIVERED_ORDERS_CAP` 踩坑教训，见 `economy.ts` 头部注释），否则重演该性能问题。

### 任务3：称号实例化（无交易需求，优先级最低）

- [x] **范围**：`titles: string[]` → 每个称号一个独立实例（至少补上 `obtainedAt`，`titles.ts` 头部注释已经明确写了"grant time is not persisted"）。✅（2026-08-10）
- **备注**：称号终身不可移除、不可交易，不需要 escrow/grant 那套"实例转移"逻辑，只需要在授予时多存一条 `{titleId, obtainedAt}` 记录（甚至可以只是给 `titles: string[]` 平行加一个 `titleGrants: Record<string, number>` 时间戳映射，不需要完整实例化）。三个任务里工程量最小，但也没有明确的玩法/客服需求驱动，排在最后。
- **落地（2026-08-10）**：采用文档建议的轻量方案，未做完整实例化——新增 `SaveData.titleGrants?: Record<string, number>`（titleId→obtainedAt epoch ms，可选/向后兼容，无需 `SAVE_VERSION` 迁移）。**唯一授予入口** `metaserver/src/titles.ts` 的 `grantTitleToPlayer`（`ladderRoutes.ts`/`ladderSeason.ts`/`achievements.ts`/`save.ts` 的新手赠予等全部调用点都走这一个函数，无需逐一改）在写 `titles` 的同时写 `titleGrants[titleId]`，**幂等**——已存在的 key 不覆盖，防御一次假设性的重复授予把 `obtainedAt` 挪后。`GET /titles`（`service/liveops/profile.ts` `getTitlesHandler`）把两者 join 成 wire 响应，缺失时省略 `obtainedAt` 字段（老账号/该称号早于本次改动授予）。`makeNewSave` 里起始称号同步打上 `obtainedAt`。客户端 `SaveData.ts` 镜像同名字段（只读展示用，非当前任何 UI 强需求）。**影响文件**：`server/shared/src/types.ts`（字段+`makeNewSave`）、`server/shared/src/titles.ts`（注释更新）、`server/metaserver/src/titles.ts`（写入逻辑）、`server/metaserver/src/service/liveops/profile.ts`（join 逻辑）、`client/src/game/meta/SaveData.ts`（镜像）、openapi 契约三处（`openapi.yml`/`paths/liveops.yml`/`schemas.yml`）+ 生成产物。**测试**：`metaserver/test/titles.test.ts`（+2：直接写入的 obtainedAt 正确返回、老账号缺失字段时省略）+ `metaserver/test/starter-title.e2e.test.ts`（+3：grantTitleToPlayer 打时间戳、老账号无 titleGrants 字段不炸且只有新授予的称号有 obtainedAt、重复授予幂等不挪时间）。**验收**：`tsc -b shared metaserver` + client `tsc --noEmit` 全干净；shared 722 测试、metaserver 全量 68 文件 886 测试、client tsc 全绿。

---

## 4. 与其它文档的关系

- [AUCTION_DESIGN.md](AUCTION_DESIGN.md) §2.1/§9：材料/装备/角色卡/皮肤四类可交易品的挂单模型——**皮肤挂单体维持 `{skinId}` 不变**（任务1实现时的决策，见上，未按原计划改成 `{instanceId}`）。
- [EQUIPMENT_DESIGN.md](EQUIPMENT_DESIGN.md) / [CHARACTER_CARDS_DESIGN.md](CHARACTER_CARDS_DESIGN.md)：`sourceType`/`obtainedAt` 字段定义（本文 §2，已实现）。
- [GACHA_DESIGN.md](GACHA_DESIGN.md) §4.3：皮肤"重复抽中"的经济学处理——已改为「真实例 + 玩家主动出售」，见上。
- [DECISIONS.md](../DECISIONS.md) ADR-059 / ADR-061：本文所有结论的决策记录。

# 物品身份基准：唯一id / 状态 / 溯源

> 状态：设计中（第1部分已实现，第2部分为后续待办）· 权威：本文 · 更新：2026-08-04

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

### 任务1：皮肤实例化（范围最小，优先做）

- [ ] **范围**：`inventory.skins: string[]` → 每份皮肤一个独立实例（`SkinInstance{id, skinId, sourceType, obtainedAt}`），仿 `EquipmentInstance` 的模式建 `skinInstances` 集合。
- **必须先定案的经济学问题**：皮肤实例化后，gacha 抽到"重复"皮肤该怎么处理——现状 `markDuplicates`（`server/metaserver/src/economy.ts`）对重复皮肤是纯 no-op（不生成新实例，不补偿），设计文档里"重复转化待S5"的待办（`economy.ts` 头部注释）尚未排期。若要让"卖掉多余的皮肤"这个用户诉求真正成立，重复抽中必须真的生成一份新实例（而不是被丢弃），这个决策要先过一遍 [GACHA_DESIGN.md](GACHA_DESIGN.md)/[ECONOMY_BALANCE.md](ECONOMY_BALANCE.md) 的经济验证流程（参考 [SLG_ECONOMY_CHECK.md](SLG_ECONOMY_CHECK.md) 的核验方法），不能悄悄改。
- **影响面**：`server/metaserver/src/skin.ts`（`escrowSkin`/`grantSkin` 整个从"字符串增删"改成"实例增删"）、`server/shared/src/types.ts`/`mongo.ts`、`server/auctionsvc/src/auctionService.ts` 的 skin 分支（挂单体从 `{skinId}` 改成 `{instanceId}`，仿装备/卡牌）、`client/src/scenes/AuctionScene/*`（本次刚接入的 skin picker 要跟着改）、皮肤装备槽逻辑（`equipped['skin:<UnitType>']` 现在存的是 skinId，要改存 instanceId 还是保留 skinId+另查一份"当前实例"，需要设计）、`design/game/GACHA_DESIGN.md` 的重复处理章节。

### 任务2：材料实例化（范围最大，依赖任务1的实例化模式跑通后再做）

- [ ] **范围**：`materials: Record<string,number>` + `inventory.items: Record<string,number>` → 每份材料一个独立实例。
- **前置**：任务1完成后，materials 复用同一套"实例化仓库"基础设施（集合 schema 模式、escrow/grant 范式、拍卖挂单范式），避免重复设计。
- **影响面最大**：所有奖励发放入口——战令（`battlepass.ts`）/ 留存签到（`retention.ts`）/ 充值里程碑（`rechargeMilestone.ts`）/ gacha（`gachaCatalog.ts`）/ PvE 掉落 / SLG 大世界资源产出——目前全部是 `{kind:'material', id, count}` 匿名数量增量，要逐一改成"生成N个带来源标签的实例"。库存操作从 Mongo `$inc` 原子加减换成"选择N份实例并原子移除"，需要设计选择策略（扣10个scrap该扣哪10份实例？大概率是"任意选，因为材料同质"，但要写清楚）。
- **性能预算**：材料产出频率远高于装备/卡牌（战斗/签到批量掉落几个到几十个），存档/集合大小要有上限（参考 `deliveredOrders` 的 `DELIVERED_ORDERS_CAP` 踩坑教训，见 `economy.ts` 头部注释），否则重演该性能问题。

### 任务3：称号实例化（无交易需求，优先级最低）

- [ ] **范围**：`titles: string[]` → 每个称号一个独立实例（至少补上 `obtainedAt`，`titles.ts` 头部注释已经明确写了"grant time is not persisted"）。
- **备注**：称号终身不可移除、不可交易，不需要 escrow/grant 那套"实例转移"逻辑，只需要在授予时多存一条 `{titleId, obtainedAt}` 记录（甚至可以只是给 `titles: string[]` 平行加一个 `titleGrants: Record<string, number>` 时间戳映射，不需要完整实例化）。三个任务里工程量最小，但也没有明确的玩法/客服需求驱动，排在最后。

---

## 4. 与其它文档的关系

- [AUCTION_DESIGN.md](AUCTION_DESIGN.md) §2.1/§9：材料/装备/角色卡/皮肤四类可交易品的挂单模型（本文任务1完成后，皮肤挂单体从 `{skinId}` 改为 `{instanceId}`，需要同步改 AUCTION_DESIGN 的标的表）。
- [EQUIPMENT_DESIGN.md](EQUIPMENT_DESIGN.md) / [CHARACTER_CARDS_DESIGN.md](CHARACTER_CARDS_DESIGN.md)：`sourceType`/`obtainedAt` 字段定义（本文 §2，已实现）。
- [GACHA_DESIGN.md](GACHA_DESIGN.md)：皮肤"重复抽中"的经济学处理（本文任务1的前置决策）。
- [DECISIONS.md](../DECISIONS.md) ADR-059：本文所有结论的决策记录。

# 装备系统 — 参数表 / defId 目录 / 接口 / 埋点 / 美术需求（§15–§20）

> 从 [`EQUIPMENT_DESIGN.md`](EQUIPMENT_DESIGN.md) 拆出（2026-08-17，原文件 1016 行）。**小节编号沿用原文**——`EQUIPMENT_DESIGN.md §N` 引用照旧有效。
> 数字不在设计文档定，去 [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) §5；分册总览见 [`EQUIPMENT_DESIGN.md`](EQUIPMENT_DESIGN.md)。
> 本册是**查表面**：开放问题、可调参数集中表、装备定义表（defId 目录）、工程契约、埋点、美术资源清单（含 §18、§20.2 —— 均被源码直接引用）。

---

## 15. 开放问题

- [ ] 词条数值区间/权重定档（结构已定 §7，数字归 ECONOMY_NUMBERS §5）。
- [x] ~~洗练模式：全部重 roll vs 锁定 1 条重洗其余~~ → **技能槽 0–2（多数0/部分1/极少2）；2 条时可花金币锁 1 条重洗另一条，或全随机更便宜**（ADR-017，§7.8）。
- [x] 暴击引擎机制（trait T3 / 饰品主词条 `m_crit` / 副词条 `s_critmult` 共用）已落地（B 方案，feat/equip-crit）。
- [ ] 特技 proc 框架（开刃/嗜血/回响/倒刺需 on-kill / on-spawn / on-hit 钩子）引擎工作量评估。
- [x] ~~抽卡：装备独立池 vs 与皮肤共池~~ → **与皮肤共池，且主产出是材料**（装备成品仅低概率彩头，ADR-017，§6）；保底（pity）规则待定。
- [ ] 是否加"掉级/碎裂"硬档（更狠氪向）+ 保护道具——现为温和"只损材料"基线（ECONOMY_NUMBERS §10 待办）。
- [ ] 分解/转化渠道（缓解满级膨胀），后期视通胀加。
- [ ] 阶段二「按兵种独立装备」的开启时机与 UI 成本。
- [ ] 装备系统**解锁章节号**（暂定第 2 章，§4）+ 引导脚本，待战役节奏定档。
- [x] ~~背包上限具体值~~ → **硬上限 1000 实例**（ADR-012，[ADR-064](../DECISIONS.md) 2026-08-10 由 300 扩容，§3.3）；逼近上限的引导/清理 UX 待细化。
- [ ] 分解 70% 返还的"打造基础成本"口径需与 ECONOMY_NUMBERS §5 配方表对齐（§6.3）。
- [x] ~~流拍溢出暂存区的领取 UI~~ → **改为 escrow-out + 系统邮件退回**（放弃暂存区），✅ 已落地（见 §13 实现记录）。剩：拍卖挂单时效（24–48h）落地。
- [x] ~~装备定义 `defId` 表~~ → 已补 §17。

---

## 16. 可调参数集中表（指针）

| 参数 | 权威位置 |
|---|---|
| 强化成功率曲线 | ECONOMY_NUMBERS §5.2 |
| 合成配方/成本 | ECONOMY_NUMBERS §5 |
| 关卡装备掉率 | `server/shared/pveRewards.ts` |
| 战力占比上限 35% / 1.5× | ECONOMY_BALANCE §5.5.1 |
| 词条池结构（主/副/特技、稀有度档） | 本文 §7（机制权威） |
| 词条加成数值/区间/权重、强化系数 | ECONOMY_NUMBERS §5（待铺） |
| 装备基础属性 / `applyEquipment` 乘加算 | `@nw/engine/balance/`（待建） |
| 装备定义目录（defId/槽位/稀有度/媒材） | 本文 §17（机制权威；属性区间→ECONOMY_NUMBERS §5） |
| 库存硬上限 / 分解返还% / 分解等级门槛 / 分解稀有度门槛 | 1000（ADR-064，2026-08-10 由 300 扩容） / 70% / +5 / 史诗永不可分解（本文 §3.3 / §6.3，ADR-012 / ADR-050） |
| 同时挂拍上限 / 挂单时效 | 5 件 / 24–48h（本文 §13，ADR-012） |

---

## 17. 装备定义表（defId 目录）— DRAFT

> 机制权威 = 本节（每件基础装备"是什么"）；具体属性区间/掉率/配方 = ECONOMY_NUMBERS §5 + `pveRewards`。
> **模型**：`defId` = 一件固定 (槽位 × 稀有度 × 媒材) 的基础装备模板（§3.1）。**稀有度写死在 defId 上**，开出后只能强化 +级、洗练副词条，不能变稀有度。

### 17.1 命名规范

`<slot 前缀>_<媒材>`，前缀：`wp_` 武器 / `ar_` 护具 / `tk_` 饰品。媒材即稀有度皮（§2）。

### 17.2 v1 目录（3 槽 × 4 稀有度 = 12 件）

| defId | 槽位 | 稀有度 | 媒材皮（文具） | 主词条候选（§7.4） | 主来源 |
|---|---|---|---|---|---|
| `wp_pencil` | weapon | 普通 | 铅笔 | 攻击% | 关卡常掉 / 合成 |
| `wp_pen` | weapon | 精良 | 钢笔 | 攻击% / 攻速% | 中期关 / 合成 |
| `wp_marker` | weapon | 稀有 | 马克笔 | 攻击% / 攻速% | Boss / 后期关 / 抽卡 |
| `wp_highlighter` | weapon | 史诗 | 荧光笔（烫金） | 攻击% / 攻速% | 抽卡 / 极后期 |
| `ar_draft` | armor | 普通 | 草稿纸 | 生命% | 关卡常掉 / 合成 |
| `ar_cardstock` | armor | 精良 | 卡纸 | 生命% / 护甲 | 中期关 / 合成 |
| `ar_leather` | armor | 稀有 | 皮面封皮 | 生命% / 护甲 | Boss / 后期关 / 抽卡 |
| `ar_foil` | armor | 史诗 | 烫金封皮 | 生命% / 护甲 | 抽卡 / 极后期 |
| `tk_clip` | trinket | 普通 | 回形针 | 移速% | 关卡常掉 / 合成 |
| `tk_bookmark` | trinket | 精良 | 书签 | 移速% / 攻速% | 中期关 / 合成 |
| `tk_sticker` | trinket | 稀有 | 贴纸 | 移速% / 暴击% | Boss / 后期关 / 抽卡 |
| `tk_seal` | trinket | 史诗 | 火漆印 | 暴击% / 移速% | 抽卡 / 极后期 |

> 饰品主词条在「移速 / 暴击率」二候选中开出时定 1 个（§7.4）。暴击机制已落地（trait T3 同款引擎字段 `critPct`/`critMult`）。
> 媒材皮 ↔ bone slot 绘制映射见 [`art-direction.md`](../product/art-direction.md) §9.2 + animator 骨架；本表只定数据侧 `defId`。

### 17.3 扩展位（后期，不进 v1）

- **同槽多 variant**：同稀有度多套外观（如史诗武器荧光笔/烫金笔/钢制笔尖），`defId` 加 variant 后缀，纯美术差异、共用数值骨架。
- **套装效果（set bonus）**：同媒材族 2/3 件触发额外加成——大 R 深度，需进 §7.7 同一套封顶管理（防套装+词条+trait 叠爆）。
- **SLG 专属媒材**：赛季限定文具皮，复用同骨架。

---

## 18. 接口与工程契约（草图，落地进 SERVER_API.md）

> 全部走 **meta 服务、服务器权威**（L2）；客户端只发意图、读回执。正式契约（字段/错误码/proto/DB）落地时进 [`SERVER_API.md`](SERVER_API.md)。

### 18.1 端点（REST，需鉴权）

| 端点 | 入参 | 回执 | 服务器职责 |
|---|---|---|---|
| `POST /equipment/craft` ✅ | `{ defId, idempotencyKey }` | `{ save, instance }` | 校验+扣材料，产 0 级基础装备（本切片产独立实例；堆叠优化待 E 后续） |
| `POST /equipment/enhance` ✅ | `{ instanceId, idempotencyKey }` | `{ success, instance, save }` | **服务器掷骰**（成功率表）、扣材料 + 金币（commercial.spend），成功则 level+1、回执 |
| `POST /equipment/salvage` ✅ | `{ instanceIds[], idempotencyKey }` | `{ refunded, save }` \| `NOT_SALVAGEABLE` | 分解回收：返 70% 打造材料，+5↑ 或史诗（不论等级）拒（§6.3，ADR-012/ADR-050）；批量整批校验、穿戴/锁定拒 |
| `POST /equipment/reforge` | `{ instanceId, fuelInstanceId, lockedIndex?, idempotencyKey }` | `{ instance, consumed }` | 校验燃料（低一级同类）、扣金币、重 roll 副词条/特技（E6 待做） |
| `POST /equipment/equip` ✅ | `{ slot, instanceId\|null, unitType? }` | `{ save }` | 改穿戴状态（纯状态，无随机，无 idem）；槽位与 def 不符 → INVALID_SLOT |

- 穿戴 `/equip` 因影响 SLG 战力，**不并进 `PUT /save`**（§3.1 `SyncPatch` 已收窄）。

### 18.2 幂等与事务（防资损，最深氪点必备）⚠️

- **所有变更类端点带 `idempotencyKey`**（客户端生成）：服务器记最近 (key→结果) 账本，**重复请求重放首次结果**，不二次扣料、不二次掷骰。范式借 commercial `deliveredOrders`（`$addToSet` + `$ne` 守卫，META_DESIGN §S5-5）。
- **enhance 的随机数绑定到首次执行**：同一 key 的成功/失败结果固定，杜绝"网络重试改命"。掷骰用服务器种子，不接受客户端随机源。
- **扣料 + 改实例 + 写账本单事务**（Mongo 事务或乐观锁 + `rev` 守卫），失败整体回滚，不留半完成态。

### 18.3 存储

- v1：`equipmentInv` 内嵌 SaveData 文档（小体量）。
- 膨胀后：迁独立集合 `equipment`（索引 `accountId`、`accountId+instanceId`），堆叠件存计数表（§3.3）。
- 幂等账本：账号维度 TTL 集合或 capped map（保留近 N 条/24h）。

---

## 19. 埋点与可观测（analyticsvc）

> 强化是**最深氪点**，调平衡与防资损都靠数据 —— 第一版就埋。事件走 analyticsvc（`ANALYTICS_DESIGN.md` 事件规约）。

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `equip_craft` | `defId, rarity, materials_spent` | 合成 faucet 流量 |
| `equip_enhance` | `defId, from_level, success, materials_spent, coins_spent` | **核心**：各级成功率实测 vs 配置、失败损耗、各级停留分布、金币 sink 量 |
| `equip_reforge` | `defId, coins_spent, fuel_defId` | 大 R 行为、洗练吞装备量 |
| `equip_equip` | `slot, defId, rarity` | 穿戴率/最热配置 |

- **运营看板**：强化漏斗（+N→+N+1 实际成功率）、金币/材料 sink 总量、背包逼近上限比例、装备战力分布 vs 35% 目标。
- **风控联动**：异常强化频率、拍卖对敲（§13）入 ops 风控面（OPS_DESIGN）。

---

## 20. 美术资源需求（盘点）

> **2026-06-29 方向调整**：图标由「程序绘制」改为「AI 生成位图 + 程序叠加稀有度边框 / 等级指示器」；战斗内 bone-slot 装备叠加（§20.4）**已移除**（角色本身已有武器视觉，再叠装备 glyph 会冲突）。下文以新方向为准，§20.3 / §20.4 保留为历史实现记录。

### 20.1 装备规模

3 槽 × 4 稀有度 = **12 个 `defId`**（§17.2）。每个 defId 对应一件具体文具（铅笔 / 钢笔 / 马克笔 / 荧光笔 / 草稿纸 / 卡纸 / 皮封皮 / 烫金封皮 / 回形针 / 书签 / 贴纸 / 火漆印），文具本身视觉差异足够大，**AI 逐件出图 12 张**，不走「3 张 + 参数」路线。

### 20.2 资源清单（新方向）

| 项目 | 性质 | 说明 | 落点 |
|---|---|---|---|
| 12 件装备图标 | **AI 生成位图** | 每件文具独立插画，扁平手绘风，见 [`EQUIPMENT_ICON_PROMPTS.md`](EQUIPMENT_ICON_PROMPTS.md) | `client/assets/equipment/` |
| 稀有度边框 | **程序绘制** | 图标外围彩色边框 + 背景底色（4 档色见下），SketchPen 笔触，复用 `RARITY_COLOR` | `EquipmentScene` / `equipmentGlyph.ts` |
| 强化等级指示器 | **程序绘制** | 图标下方单符号 3 阶系统（见 §20.6） | `equipmentGlyph.ts` 扩展 |
| 词条统计 / 材料 / 金币图标 | **程序绘制（✅ 已落地 §20.5）** | 8 个手绘小图标 | `client/src/render/icons.ts` |
| 战斗内装备叠加 | ~~程序绘制~~ **已移除** | bone-slot glyph 叠加与角色武器视觉冲突，取消 | ~~`StickmanRuntime`~~ |

**稀有度边框色**（沿用现有编码）：

| 稀有度 | 边框色 | 背景底色 |
|---|---|---|
| Common 普通 | `#9aa0a6` 铅笔灰 | 透明/极浅灰 |
| Fine 精良 | `#4477cc` 墨蓝 | 极浅蓝 |
| Rare 稀有 | `#e08a2c` 马克橙 | 极浅橙 |
| Epic 史诗 | `#aa55cc` 荧光紫 + `#d9b44a` 烫金 双色边框 | 极浅紫 |

### 20.6 强化等级指示器设计（3 阶 × 3 级）

图标下方预留约 1/5 高度的小条区域，放置单个符号。**阶段跳变用形态区分（圆→星→印章），阶内进度用填充程度区分**：

| 阶段 | 等级 | 符号形态 | 填充状态 | 文具隐喻 |
|---|---|---|---|---|
| 初阶 | +1 | 圆圈 ○ | 空心 | 铅笔点 |
| 初阶 | +2 | 圆圈 ◑ | 半实 | |
| 初阶 | +3 | 圆圈 ● | 全实 | |
| 中阶 | +4 | 五角星 ☆ | 空心 | 批改红星 |
| 中阶 | +5 | 五角星 | 半实 | |
| 中阶 | +6 | 五角星 ★ | 全实 | |
| 满阶 | +7 | 六边印章 ◇ | 空心 | 盖章认证 |
| 满阶 | +8 | 六边印章 | 半实 | |
| 满阶 | +9 | 六边印章 ◆ | 全实 + 淡发光 | |

- **0 级**（未强化）：不显示符号，保持空白。
- 符号用 `SketchPen` 程序绘制，保持手绘风；史诗装备 +9 可加极轻描边发光（与边框色同色调）。
- 实现落点：`drawEquipmentGlyph` 新增 `level` 参数，按上表选形/填充。

### 20.6b 实现记录（2026-07-20，✅）— 强化等级改为星级展示

§20.6 的图标符号方案未落地；实际实现此前是纯文字 `"{名称} +{等级}"`（`itemLabel()`），玩家反馈数字后缀不够醒目、易与名称混读。改为与卡牌/英雄等级一致的**金色星星行**（每级 1 颗，最多 9 颗，超宽自动缩放填满可用宽度），复用 `buildIcon('star', …)`：

- 背包/已装备大卡片（`EquipmentScene/inventory.ts` `renderInstanceCell`）：名称行下方单独一行星星，卡片头部区随星星行按需从 32px 加到 40px。
- Loadout 三槽预览（`renderLoadout`）：名称居中一行 + 星星居中一行（更小尺寸）。
- 详情弹窗标题（`EquipmentScene/detail.ts` `openDetail`）：星星紧跟名称，挤在名称与稀有度标签之间的空档里。
- `itemLabel()` 仍保留，但改为向文本星号 `★`（非彩色图标）——只用于嵌在翻译句子里、无法放置图形节点的场景（锻造/重铸候选行、指派提示语等）。
- 新增 `EquipmentSceneBase.buildLevelStars(level, maxW, size?, gap?)` 共享辅助方法。
- 0 级不显示任何符号（与旧的省略 "+0" 后缀语义一致）。
- 用假 `save`/`cb` 构造 `EquipmentScene` 两次 `app.renderer.render` 后 `toDataURL` 截图验证（背包卡片、loadout 预览、详情弹窗三处），`tsc --noEmit` 通过。

### 20.6c 实现记录（2026-07-25，✅）— 满级星星左右翻转动画

强化到 `EQUIP_MAX_LEVEL`（满级）的星星行现在持续播放左右翻转动画，与其余等级的静态星星行区分，一眼认出满级装备。

- `buildLevelStars()`：仅当 `starN === EQUIP_MAX_LEVEL` 时，把每颗星星图标的 pivot 移到自身中心（否则 `scale.x` 翻转会带偏位置），并把它连同一个按下标错开的相位一起登记进 `EquipmentSceneBase.flipStars`。
- `update(dt)`：对 `flipStars` 中的精灵按 `scale.x = cos(t·STAR_FLIP_SPEED + phase)` 逐帧驱动（约 2.6s 一个完整翻转周期，相邻星星错相位形成波纹感，而非齐刷刷同步闪烁），与既有的 scrollDirty/忙碌指示器重绘互不影响——直接改精灵属性，不触发整帧重绘。
- 每帧顺带过滤掉 `obj.destroyed` 的精灵（PIXI `destroy()` 后 `transform` 置空，再写 `scale.x` 会抛错）：背包网格滚动出屏、详情弹窗关闭重开都会拆旧建新，这样自愈式清理即可，不需要在每个调用点手动清空 `flipStars`。
- 落点：`EquipmentScene/base.ts`（`buildLevelStars`/`update`/两个新增模块常量 `STAR_FLIP_SPEED`/`STAR_FLIP_STAGGER`）；背包卡片、详情弹窗两处星星行共用同一份逻辑，无需改动 `inventory.ts`/`detail.ts` 调用点。`tsc --noEmit` + 相关 `equipment*` vitest 套件通过。

### 20.6d 实现记录（2026-07-26，✅）— 满级星星改为间歇扫光

玩家反馈 §20.6c 的常驻逐帧翻转在一屏多个满级装备同时出现时"眼花"——每颗星星永远在小幅抖动，视觉噪音大于信息量。改为**大部分时间静止金色，每隔几秒整排快速扫一次**，满级装备依旧一眼可辨，但不再持续动。

- 常量替换：`STAR_FLIP_SPEED`/`STAR_FLIP_STAGGER`（rad/s、弧度相位）→ `STAR_SWEEP_INTERVAL`（两次扫光间隔，6s）/`STAR_SWEEP_DURATION`（单颗星星扫光时长，0.7s）/`STAR_SWEEP_STAGGER`（相邻星星扫光起始的秒级延迟，0.08s，形成左→右波纹）。
- `update(dt)`：`flipT % STAR_SWEEP_INTERVAL` 得到本轮周期内的位置 `cyclePos`；每颗星星 `localT = cyclePos - phase` 落在 `[0, STAR_SWEEP_DURATION)` 内时才播放 `scale.x = cos((localT/STAR_SWEEP_DURATION)·2π)`（从 1 平滑扫到 1，无跳变），否则 `scale.x = 1`（静止）。`buildLevelStars()` 登记进 `flipStars` 的逻辑不变，仅 `phase` 单位从弧度改为秒。
- 用 Node 脚本离线模拟该公式（7 颗星、60fps 步进 13 秒）验证：每个周期内约 1.18s 处于扫光窗口、其余时间恒为 1，扫光起止都平滑落在 1，周期性正确；`tsc --noEmit` 通过。未能在本机走完整后端+登录截图核对（需 11 个服务全起来才能到装备格子界面），纯数学公式改动，走查+离线模拟确认。

### 20.6e 实现记录（2026-08-01，✅）— Loadout 星星挤到边框线上

玩家反馈截图：Loadout 三槽预览（`renderLoadout`）里已强化装备的星星行紧贴/压住了槽位卡片自己的边框线，看起来很奇怪。根因是星星纵坐标按格高百分比算（`cy + cellH * 0.86`），没算进星星图标自身约 10px 的高度——在旧 `LOADOUT_H`（78）算出的 `cellH`（50）下，星星行底边比格子边框还低几 px，直接压线。

- `LOADOUT_H`：78 → 90，给图标+名称+星星三行多留一点纵向空间。
- `renderLoadout()`：图标/名称锚点相应上移（0.4→0.34、0.72→0.66）；星星改为**贴底锚定**（`cy + cellH - starSize - 4`，固定留 4px 净空），不再是 cellH 的百分比——今后哪怕再调 `LOADOUT_H`/星星尺寸也不会重犯。
- 回归测试：`client/test/ui/equipmentLoadoutStarClipping.ui.ts`（横屏+竖屏各一例）——定位 loadout 星星行容器，断言其底边不超出槽位格子的下边界；改回旧公式复测确认会失败（越界约 1.8px），验证测试本身有效。
- `tsc --noEmit` 通过；未能在本机走通登录到装备格子界面截图核对（预览面板本次未能显示画面），走查+新增单测确认。

落地 = 新建 `client/src/render/equipmentGlyph.ts`（`drawEquipmentGlyph(g, slot, rarity, size, seed)` + `MEDIA` 媒材色表，用 `SketchPen` 画 3 类基形：weapon=笔杆+笔尖 / armor=封皮+书脊 / trinket=小配件，稀有度色驱动填充与点缀）+ 接入 `EquipmentScene`（loadout 三槽、背包实例行、锻造行把原"纯文字"替换为程序图标）。零位图资产，`tsc --noEmit` + webpack 构建验证。

### 20.4 实现记录（2026-06-24，✅）— 战斗内 bone-slot 立绘叠加

§2/§11 的「把装备画到角色身上」已在**战斗渲染**层落地，按 `gear` 给 weapon/armor/trinket 槽沿骨骼挂 §20.3 同款 SketchPen glyph。

**渲染（`StickmanRuntime`）**：新增 `gearLayer`（位于骨骼之上、命中描边之下）+ `setGear(specs)`。glyph 几何体按 `${slot}:${rarity}`（12 组合）全局共享一份模板，单位 gear sprite = `new PIXI.Graphics(template.geometry)`（几何体引用计数，销毁单位不毁模板）→ 满屏装备单位只 12 份几何体而非 12×N。定位**复用 `_applyPose` 已算的逐帧 FK**（不额外 `sampleClip`/`computeFK`，不加重 swarm 热路径）：
- 默认骨骼锚点（animator 本地 px）：weapon→右前臂(`r_lower_arm`)末端=持笔的手；armor→脊柱(`spine`)中点=躯干；trinket→头骨(`head`)末端。glyph 仅平移、不随骨骼旋转（盲验路径下最稳，姿态甩动也不会"穿帮"）。
- 美术可在 animator 标注 `gear_<slot>` attachment point（父骨骼+偏移）覆盖默认锚点做精修——当前 .tao 未标注则走默认骨骼，**今天即可见**。
- 无 gear 的单位 `gearSprites` 为空，`_applyPose` 整段跳过 → 不付出任何代价。

**数据流（PvP 硬墙复用）**：`GameScene.opts.equipment`（A5 已是 **PvE-only** 的 `EngineEquipmentInput`）→ `GameRenderer` → `UnitView`。PvP 永不传 equipment → 战斗内永不显装备（与引擎 `buildPvpBlueprints` 无装备参同源）。`UnitView.gearSpecsFor` 按兵种解析 loadout（`byUnit` ∪ `global`）→实例→`defId`→`{slot,rarity}`，仅 `PLAYER_EQUIPPABLE_UNITS`（与 `applyEquipment` §8 同源，避免"哪些兵种吃装备"漂移；为此 `@nw/engine` index 导出该常量）。

**对象池正确性**：池按兵种分桶、不分敌我，同一 runtime 复用时可能换边。故 `setGear` 做**幂等键校验**（`gearKey` 不变即 no-op），`UnitView.applyGear` 在**每次** acquire（新建 + 池复用两条分支）按 `unit.side === localSide` 重申：己方军披玩家 loadout，同型敌军传 `[]` 清掉上一生命残留的装备。常见「同边同型复用」是 no-op，保住池化收益。

**局限（记录待办，非本切片）**：① 精确锚点/旋转需一次有视角的打磨或美术补 `gear_*` 点（本项目不做截图验证，故默认骨骼为保守平移叠加）；② replay/spectator 路径不携带 equipment 输入 → 回放不显装备；③ glyph 不随骨骼旋转（持笔不会随挥击转动），如需"挥笔"需引入随 `wa` 的旋转项。

### 20.5 实现记录（2026-06-27，✅）— 材料/词条图标化

背景：装备页除装备本体 glyph（§20.3）外，材料余额、强化/锻造消耗、词条统计仍是密集纯文本，信息密度高、扫读慢。本切片把这些信息**图标化**，与 §20.3 同走 `SketchPen` 程序绘制 + 纹理缓存，零位图。

落地 = `client/src/render/icons.ts` 扩 8 个手绘图标（沿用现有 `IconKind`/`buildIcon` 缓存框架，headless 自动回退 live draw）：
- **材料**：`scrap`（撕角纸屑+横线）/ `lead`（削尖石墨条）/ `binding`（螺旋装订圈）；金币复用既有 `coin`。
- **词条统计**：`atk`（剑刃）/ `hp`（涂鸦心）/ `armor`（盾）/ `spd`（双向尖角=移速）/ `atkspd`（闪电=攻速）。

接入 `EquipmentScene`（4 处）：
1. 顶部资源条：金币 + 三材料余额 → 图标 + 数量（无 `×`）。
2. 详情模态·强化消耗：`消耗:` + `图标×数量` 链（买不起整体变红，逻辑不变）。
3. 详情模态·词条行：每条属性前置统计图标，主词条墨蓝 / 副词条铅黑（颜色语义沿用）。
4. 锻造行·配方成本：材料文字 → `图标×数量`。

实现细节：① 新增共享方法 `drawCostChips(parent, x, midY, mats, coins, color, size, prefix)` 统一画消耗组，**未知材料/词条自动回退文字标签**（健壮，不因新增材料 id 漏图标而崩）；② 材料墨色 `MAT_COLOR`（纸灰/石墨/墨蓝）+ 映射函数 `matIconKind`/`affixIconKind`；③ i18n（`material.*`/`affix.*`）全保留——图标是文字的前缀增强，词条数值文字仍在；④ 删去因此变成死代码的 `enhanceCostStr()`。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**美术铁律遵守**：装备本体 glyph（§20.3）与角色立绘叠加（§20.4）不动；新图标全部手绘笔触、平面无渐变，符合 art-direction「三笔语言 + 程序优先」。

### 20.7 实现记录（2026-07-02，✅）— 立绘叠加接通 per-card 数据源 + 战斗接线收尾

背景：§20.4（2026-06-24）落地了战斗内 bone-slot 叠加，但当时读的是旧「`byUnit ∪ global`」loadout。角色卡重构（CHARACTER_CARDS_DESIGN CC-1，2026-07-01）把装备移到 `CardInstance.gear`（per-card），引擎 + 存档 + UI + 测试全迁移，**却漏了客户端战斗入口**：`createAppCore.goCampaign` 仍传旧模型 `unitLevels:{} / equipment:{gear:{},inv}`（`gear` 恒空），从不传 `cardInstances`。后果=引擎实跑 `buildCampaignBlueprints([], undefined)` 裸蓝图，**卡等级/装备对战斗数值零作用**，`UnitView.gearSpecsFor` 读废弃字段 → **立绘永远画不出装备**（旧字段靠对象展开绕过 TS 多余属性检查，编译期无警告）。

落地（纯客户端）：
- `cardDefs.ts` 新增 `toEngineCardInstances(cardInv)`：`SaveData.cardInv` → `EngineCardInstance[]`，由 defId 经 `CARD_DEFS` 解析 unitType，转发 level + gear。
- `matchEngine.ts` / `GameScene.ts`：opts 去掉废弃的 `pveUpgrades/unitLevels/equipment(EngineEquipmentInput)`，改 `cardInstances`+`equipmentInv`，一路转发给引擎（数值）与 renderer（叠加）。
- `createAppCore.goCampaign`：传 `cardInstances: toEngineCardInstances(save.cardInv)` + `equipmentInv: save.equipmentInv`（PvE-only；PvP/tutorial/goGame 不传 → 硬墙不变）。
- `GameRenderer` / `UnitView`：字段由 `EngineEquipmentInput` 迁到 `cardInstances`+`equipmentInv`；`gearSpecsFor` **镜像引擎选卡规则**（`buildCampaignBlueprints` 同兵种取最高等级卡）后读该卡 per-card gear → `{slot,rarity}`，保证画出的装备与实际生效的词条一致。仍限 `PLAYER_EQUIPPABLE_UNITS`，仍 memoize。
- 测试 harness `HeadlessAppViews.showGame` 同步转发新字段。

废弃：旧 `byUnit/global` loadout 概念随本切片彻底作废（per-card 取代，穿戴 UI 已在 CC-3 的 CardScene/EquipmentScene）；`EngineEquipmentInput` 仅保留为向后兼容类型别名，新代码不用。验证：client `tsc --noEmit`(含 test) + webpack 生产构建全绿；equipment/hardwall/progression 单测 38 全过。

### 20.8 实现记录（2026-07-17，✅）— 装备图标统一出处（buildEquipIcon）

背景：§20.2 引入了 AI 位图图集（`client/src/assets/equipment/equipment.{png,json}`，12 帧按 defId 命名，boot 时经 `bootManifest.ts` 的 `equip:atlas` 加载），`getEquipIconTexture(defId)` 解析。但各界面**各自决定用图集还是 §20.3 手绘 glyph**：只有 `EquipmentScene`/`CardScene` 走「图集优先→glyph 兜底」，而**抽卡（结果卡+概率表）、拍卖行（列表+挂单选择器）直接调 `drawEquipmentGlyph`**，从不查图集。`drawEquipmentGlyph` 只认 slot+rarity、无视 defId，导致同一件装备在装备包显示专属位图、在抽卡/拍卖显示同槽位同稀有度的通用草图——**同物不同图**。

落地（纯客户端，零新资产）：`render/atlas/equipmentAtlas.ts` 新增唯一解析器 `buildEquipIcon(defId, slot, rarity, size, seed): PIXI.Container`——图集就绪且 defId 已知返回 `Sprite`（anchor 0.5、scale `size/128`），否则返回 §20.3 procedural glyph；原点居中，调用方只设 `x/y/alpha`。全部 5 处图标绘制统一走它：`GachaScene.drawEntryPicture`、`AuctionScene` list/picker、`EquipmentScene.addGlyph`、`CardScene` detail（后两者删去各自重复的图集处理代码）。

铁律：今后任何装备图标绘制点**必须调 `buildEquipIcon`**，禁止直接 `drawEquipmentGlyph`。`EquipDef.media` 字段对渲染是死字段（无解析器读它）。验证：client `tsc --noEmit` + webpack 构建全绿（因后端未起未做游戏内截图；渲染路径与既有可用的装备包一致）。

### 20.9 实现记录（2026-07-17，✅）— 锻造格按稀有度分组

背景：`craftableDefs()`（`client/src/game/meta/equipmentDefs.ts`）此前按 `EQUIPMENT_DEFS` 声明顺序返回（先按槽位 weapon/armor/trinket 分组，槽位内再按稀有度），锻造 tab（`EquipmentScene/craft.ts`）不做二次排序、直接按数组顺序铺格子——4 列网格下第一行变成「铅笔(普通/武器)、钢笔(精良/武器)、马克笔(稀有/武器)、稿纸(普通/防具)」，稀有度视觉上没有分组，用户截图指出与预期不符。

落地：`craftableDefs()` 加一次按稀有度的**稳定排序**（`common→fine→rare→epic`，与 `RARITY_COLOR` 键序一致），槽位内原顺序不变。9 件可锻造装备现按 3 普通/3 精良/3 稀有连续输出，4 列网格下每行稀有度一致。新增 `client/test/equipmentDefs.test.ts` 固化排序 + craftCost 过滤两条不变量。验证：client `tsc --noEmit` 全绿 + 新测试通过；因本机会话无后端未做游戏内截图，改动本身是纯数据排序，用脚本直接打印排序结果核对。

### 20.10 实现记录（2026-07-18，✅）— 材料图标位图化（scrap/lead/binding）

背景：§20.5 把材料（scrap/lead/binding）图标做成 `SketchPen` **程序绘制、零位图**。但装备本体早已在 §20.2 换成 AI 位图图集（`buildEquipIcon`，§20.8 统一出处），导致装备页里「装备本体是彩色位图、三个材料余额却是灰扑扑的程序 glyph」的观感割裂——抽卡结果卡/概率表里材料同样只有 glyph。用户走查确认「位图缺失」。

资产：3 张 AI 手绘位图（notebook 风、透明底、墨线描边）——scrap=撕纸+铅笔屑、lead=三根石墨条捆麻绳、binding=紫色螺旋线圈。源图放 `art/ui/material/`，`build-atlas.js`（仿 `art/ui/equipment/build-atlas.js`，`sharp` 先 `.trim()` 去透明边再 `contain` 到 128²）打成 `client/src/assets/material/material.{png,json}`（384×128，3×1，frame 名 = `scrap`/`lead`/`binding`，即 EquipmentScene 短 id、也是 `GachaScene.MATERIAL_ICON` 的目标 kind）。

接线（纯客户端）：新增 `client/src/render/atlas/materialAtlas.ts`——`loadMaterialAtlas()`（boot `material:atlas` 步，非致命）+ `getMaterialIconTexture(kind)` + `buildMaterialIcon(kind,size,color)`（图集就绪返回 `Sprite`，否则回退 §20.5 的 `buildIcon` glyph，与 `buildEquipIcon` 同款「位图优先→glyph 兜底」契约，原点为左上角 `size×size`）。三处调用改走它：`GachaScene.drawEntryPicture`（材料分支）、`EquipmentScene/base.ts` 的 `renderMaterialsBand`（顶部余额条）与成本 chip 闭包（coin 仍走 `buildIcon`）。

验证：client `tsc --noEmit` + 生产 webpack 构建全绿；dev server（9090）运行态经 webpack chunk 反射拿到 PIXI `TextureCache`，确认 `scrap/lead/binding` 三帧 `valid` 且 128²、源图 384×128、逐帧非空（scrap 68 色/luma 9–255 证明是真插画非纯色块）。因材料图标深藏抽卡/装备页需登录+后端，用运行态贴图内省替代逐屏截图。

### 20.11 实现记录（2026-07-18，✅）— 材料图标接入奖励类场景

背景：用户截图关卡结算（Level 18）奖励行，三个材料图标（scrap≈书签/lead≈铅笔/binding≈螺旋）显示为灰扑扑手绘 glyph，怀疑图标管理不统一。排查发现 §20.10 的 `buildMaterialIcon` 铁律当时只接了 3 处（GachaScene、EquipmentScene），关卡结算（`LevelPrepScene.drawRewards`）、每日签到（`DailyScene.rewardIcon` 消费点）、活动兑换（`EventScene` 积分商店卡片）、通行证（`BattlePassScene` 关卡奖励行）四处仍直连 `buildIcon`，同一材料在这些场景永远显示程序 glyph 而非位图——铁律未覆盖全部调用点，非新 bug。

落地：四处对 `scrap/lead/binding` 的图标绘制改为 `buildMaterialIcon`（`coin`/`skin`/`card`/`equipment`/`star` 等非材料 kind 不变，仍走 `buildIcon`/`buildCoinIcon`）。`materialAtlas.ts` 顶部注释同步扩充覆盖范围说明。

验证：client `tsc --noEmit` + 生产 webpack 构建全绿。四场景均无既有单测覆盖；因需登录+后端进入关卡结算/签到/活动/通行证界面，未做游戏内截图核对，改动为同签名图标构建函数替换，风险低。

### 20.12 实现记录（2026-07-19，✅）— 材料图标 `scrap` 重绘（单体剪影替换堆叠碎片）

背景：用户走查每日签到日历，指出 `scrap`（碎屑）图标在商店里就偏花哨，缩小到签到格子（~28px）后糊成一团。对比同组 `lead`/`binding`（单体、单色调、强轮廓）确认问题只出在 `scrap`——原图（"一堆撕纸+铅笔屑+散落黑点"）是多形状堆叠+两种撞色，天生难以在小尺寸下保持可读剪影。

处理：AI 重新出图两轮收敛——第一轮改「单张折角撕边纸」剪影（去掉多体堆叠），验证轮廓在缩小后清晰，但是纯黑白线稿、无色彩，与 `lead`（灰阶+棕绳）/`binding`（紫圈+灰杆）的上色处理不一致；第二轮加回暖色调（米黄纸面+蓝色横线+橙色页边线+棕色阴影，明确要求匹配同组明暗处理）确认通过。新 prompt 记录在 `design/product/gacha-art-prompts.md` §`mat_scrap` 专用 prompt。

资产整理：三张源图重命名为 `scrap.png`/`lead.webp`/`binding.webp`（原为 AI 工具生成的随机编码文件名），`build-atlas.js` 的 `ENTRIES` 同步更新为新文件名，重新打包 `material.png/json`（384×128，帧名不变）。

验证：`node build-atlas.js` 打包成功；用 sharp 把 `scrap` 帧缩到 28×28（对齐签到格子实际图标尺寸 `ch*0.26`）人工核对，折角撕边纸的剪影清晰可辨，未再糊成色块。client `tsc --noEmit` 未跑（仅素材/构建脚本变更，无 TS 改动）。

### 20.13 实现记录（2026-07-29，✅）— 空槽图标改为镂空 + 号（不再是暗淡实心 glyph）

背景：用户看 Hero Roster 网格截图，把某几张卡底部的槽位图标误认成"已装备的低阶道具"，实际是空槽——`buildEquipIcon`（§20.8）里空槽走的是 `drawEquipmentGlyph(slot, rarity='common', ...)` 再由调用方把 `icon.alpha` 压到 0.3～0.4，本质上仍是一件"变暗的 common 稀有度实心装备"，与真实穿戴的 common 装备只有透明度这一个区分维度，density 高的网格里很容易看漏。

拍板（用户）：槽位形状提示要保留（玩家仍需一眼看出这是武器/护甲/饰品槽），但空槽必须与"任何真实装备"在观感上分类不同，不能靠透明度这种容易被忽略的弱信号；且优先级明确——**能程序绘制满足需求就用程序绘制，只有程序绘制明显拉低品质时才考虑额外出图**（复杂度/工作量让位于游戏品质，但不是无条件加美术资源）。

落地（纯客户端，零新资产，仍在 `equipmentGlyph.ts` 程序绘制范畴内）：
- 新增 `drawEmptySlotGlyph(g, slot, size, seed)`：复用各槽位的基础形状（武器=斜置笔形、护甲=矩形书封、饰品=打孔挂牌），但**不填充**、描边统一用与稀有度无关的中性灰 `EMPTY_INK`（0xb0aaa0），中心叠加一个不透明的"+"。
- `buildEquipIcon`（§20.8 的唯一装备图标出处）新增分支：`defId` 为 `undefined`（即真正的空槽）时直接返回 `drawEmptySlotGlyph`，不再退化成"稀有度 common 的实心 glyph + 调用方自行调透明度"；`defId` 有值但图集贴图缺失（图集未加载完/未知 id，极少见）时仍走原 §20.3 实心 glyph 兜底——语义上这仍是"一件真实装备，只是位图还没出来"，与"空槽"是两回事，不能混用同一条兜底路径。
- 三处调用点（`CardScene/list.ts` 网格、`CardScene/detail.ts` 详情弹窗、`EquipmentScene/inventory.ts` 背包格）删掉各自「`inst ? 1 : 0.3～0.4`」的透明度分支，统一 `alpha = 1`——镂空+加号本身已经是区分信号，不需要再叠一层透明度。

验证：client `tsc --noEmit` 全绿；`npm run test:ui` 中 equipment/roster 相关既有套件（`equipmentGridLayout`/`equipmentAssignGrid`/`cardRosterApplyCardState` 等）全绿，其余 50 个套件失败是本机已知的 `jsonwebtoken` workspace 链接缺口（详见 `claudedocs/worktrees.md` 陷阱记录），与本次改动无关。因后端未起无法走完整登录截图 Hero Roster，改用 `?equipDemo` 临时调试入口（`entries/web.ts` 分支 + 一次性 demo 模块，验证后已删除）直接构造 `PIXI.Application` 调用 `drawEmptySlotGlyph`/`drawEquipmentGlyph` 网格渲染，肉眼确认三个槽位的镂空+加号版本与 common/fine/rare/epic 实心版本能一眼区分。

### 20.14 实现记录（2026-08-04，✅）— 商店材料档补齐位图图标 + 每日限购进度显示（ECONOMY_NUMBERS §6.5 UI 缺口）

背景：用户截图商店「Scraps ×10 / Lead ×3」两档，指出两处问题：①图标不对；②写着"每日限购次数有限"却不显示已购/上限次数。排查确认①与 §20.11 同一 bug 家族——`buildMaterialIcon` 铁律当时覆盖了 GachaScene/EquipmentScene/LevelPrepScene/DailyScene/EventScene/BattlePassScene 六处，唯独 §6.5（2026-08-03 才新增）的 `ShopScene` 材料直购档从建立起就没接入，材料图标走的是 `buildCoinIcon`→`buildIcon` 程序 glyph 回退路径（scrap 撕纸剪影在截图里读成"书签"、lead 削尖石墨条读成"羽毛笔"），并非本次改动引入的新回归，是功能补齐时漏掉的一个调用点。②是纯粹的信息缺口——`MATERIAL_SHOP_DAILY_CAP` 早已存在（ECONOMY_NUMBERS §6.5），但服务端从未把当日已购次数吐给客户端，商店只能写死一句静态提示。

落地：
- **图标**：`ShopScene/base.ts` `CardSpec` 新增 `materialKind?: MaterialKind` 字段，`drawCard` 材料分支优先按它走 `buildMaterialIcon`（早于 `artUrl` 缺失时的 `buildCoinIcon` 兜底）；`ShopScene/shop.ts` 材料循环设置 `materialKind: item.grants`。
- **限购进度**：`ShopItem` schema（`contracts/openapi/schemas.yml`）新增 `dailyLimit`/`purchasedToday`（非限购商品整体省略，与既有 `qty` 字段同一约定），`server/metaserver/src/service/economy.ts` `getShopItems` 用 `readCounterField`（只读快照，不占用 `bumpCappedCounter` 的写路径）现算当日已购次数。客户端状态行改渲染"今日已购 {used}/{limit}"（`shop.item.material.limit`，替换掉原静态 `shop.item.material.desc`），到量后 Buy 按钮置灰、文案变"今日已达上限"（`shop.item.material.capReached`）；`onBuy` 购买成功后重新拉取 `/shop/items` 让计数实时刷新，不必等下次进商店。
- 详见 ECONOMY_NUMBERS.md §6.5 "2026-08-04 修复" 条目（数值/字段设计记在那边，本节只记图标/UI 实现）。

验证：server `@nw/shared`/`@nw/metaserver` 构建 + `tsc --noEmit` 全绿；`economy.e2e.test.ts` 新增一条覆盖 dailyLimit/purchasedToday 随购买递增 + 非限购商品不带这两个字段，40/40 全绿（真实 Mongo）。client `tsc --noEmit` + `webpack build:web` 全绿；`shopScene.ui.ts` 更新/新增两条覆盖限购进度行渲染 + 封顶态按钮置灰，35/35 全绿；`shopGroupTabs`/`shopCoinsScrollBound`/`coinHeaderDisplay`/`shopNav-*` 相关既有套件全绿。因后端（mongo/redis/metaserver/commercial）本次会话未起，且浏览器面板当前无法截图（compositing 环境限制），材料位图本身的最终视觉效果沿用 §20.10/20.11 已验证过的 `buildMaterialIcon`（本次只是让 ShopScene 调用同一条已验证路径），未重复登录截图确认。

### 20.15 实现记录（2026-08-10，✅）— 锻造按钮置灰补充提示（满仓 vs 材料不足）

背景：用户截图锻造 tab，材料（碎屑）明显充足却见「锻造」按钮置灰，一时看不出原因。排查 `renderCraftCell`（`EquipmentScene/craft.ts`）确认 `enabled = affordable && !full && !this.bt.busy`——`affordable`（材料不足）已经有红色成本 chip 作视觉提示，但 `full`（装备背包 `equipmentInv` 达 `EQUIPMENT_INV_CAP`=300 上限）在卡片本身毫无提示，唯一线索是头部一个容易忽略的小号 `count/300` 计数（`base.ts` `renderHeaderCurrency`，满时变红）。用户实际情况正是背包已超过 300 上限（截图头部 `475/300`），锻造 tab 内所有卡片按钮因此同时置灰，误以为是铅笔单独的问题。

落地：置灰按钮不再是死区——`renderCraftCell` 给按钮补一条禁用态命中区（`owner: defId`，供测试按 defId 定位），点按后 `showToast` 弹出对应原因：满仓→`equip.err.full`（"背包已满（300）"，与服务器 `INVENTORY_FULL` 错误码复用同一 i18n key，见 `app/nav/game.ts` 的错误码映射），未满但材料不足→`equip.err.materials`（与 chip 变红的提示重复，但补上一次明确文案，不新增 key）。启用态按钮命中区同步打上 `owner: defId`（原先没有），纯测试可定位性增强，不改行为。

验证：client `tsc --noEmit` 全绿。`test/ui/scenes.ui.ts` 新增一条覆盖：把 `equipmentInv` 填到 300 上限后渲染锻造 tab，按 `owner === 'wp_pencil'` 取到禁用态命中区，触发后断言 `cb.craft` 未被调用、`showToastMessage` 以 `'error'` kind 调用——120/120（含既有两条 craft-tab 用例）全绿。因触发条件需要背包恰好达 300 上限，本机会话后端未起也无法快速摆出这一存档态，浏览器面板 compositing 也不可用（同 §20.14），未做游戏内截图，改用同一份 headless PIXI 场景测试覆盖渲染＋点击＋toast 全链路作为等价验证。

### 20.16 实现记录（2026-08-13，✅）— `scrap` 改名「碎屑→旧纸片」+ `lead` 改名「铅芯→铅笔芯」

背景：用户反馈最低档通用材料 `scrap` 中文名「碎屑」偏负面，让最便宜材料显得一文不值；且该材料美术图早已是「一张旧的小纸片」，名字与图不符。

落地：仅改三语显示名，不改材料 id / 数值 / 图标：
- `scrap`：中 碎屑→**旧纸片**；英 Scraps→**Tatter**；德 Schnipsel→**Fetzen**（三者都取「旧/边角料」而非「垃圾残渣」的调性，且与既有美术一致）。
- `lead`：中 铅芯→**铅笔芯**，更明确对应「铅笔」这一文具原型；英文 `Lead`、德文 `Blei` 本身在各自语言里已经是「铅笔芯」的惯用说法（英语 "pencil lead" 口语径直简称 lead；德语 `Bleistift`＝铅笔，字面即「铅芯棒」），故未改动。
- `binding`（装订线）本次不涉及，维持原名。
- 同步更新本文档 §5 材料表（[EQUIPMENT_DESIGN.md:151-152](../../design/game/EQUIPMENT_DESIGN.md)）与 `ECONOMY_BALANCE.md` §5.2 材料说明。

验证：纯 i18n 字符串 + 文档改动，不涉及逻辑；`client tsc --noEmit` 全绿。

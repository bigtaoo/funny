# 决策日志（ADR）

> 状态：实现中 · 权威：本文 · 更新：2026-08-18

记录**会造成文档间漂移**的关键拍板：改数值口径、改命名、改架构、废弃旧方案。
每条 ADR 注明：日期、决策、影响的文档、为什么。新拍板追加在末尾，不改旧条目（要改就加一条新的 *Supersedes*）。

格式：`ADR-NNN 标题 — 状态(Accepted/Superseded) — 日期`（`Proposed` = 已登记、未拍板的候选提案，不代表当前实现，实施前需另开确认）
> **2026-08-17 拆分**：原文件 803 行，ADR 正文按编号搬进两个分册，本文保留索引。编号/标题/锚点全部未变。
> **新拍板追加到 [`DECISIONS_ADR-041-onward.md`](DECISIONS_ADR-041-onward.md) 末尾**，并在下表补一行。

---

## ADR 索引（共 69 条）

| 编号 | 决策 | 状态 | 日期 |
|---|---|---|---|
| [ADR-001](DECISIONS_ADR-001-040.md#adr-001-战斗数值单一可信源--configts--accepted--2026-06-21) | 战斗数值单一可信源 = `config.ts` | Accepted | 2026-06-21 |
| [ADR-002](DECISIONS_ADR-001-040.md#adr-002-局内货币重命名-coins--ink--accepted--2026-06-13) | 局内货币重命名 `coins → ink` | Accepted | 2026-06-13 |
| [ADR-003](DECISIONS_ADR-001-040.md#adr-003-阵营色--我蓝敌红v03--accepted--2026-06-14) | 阵营色 = 我蓝敌红（v0.3） | Accepted | 2026-06-14 |
| [ADR-004](DECISIONS_ADR-001-040.md#adr-004-服务端进程拆分gateway--matchsvc-独立--accepted--2026-06-14s1-m5) | 服务端进程拆分（gateway / matchsvc 独立） | Accepted | 2026-06-14 |
| [ADR-005](DECISIONS_ADR-001-040.md#adr-005-应用进程口径--8-个--accepted--2026-06-21) | 应用进程口径 = 8 个 | Accepted | 2026-06-21 |
| [ADR-006](DECISIONS_ADR-001-040.md#adr-006-pve-数据走服务器权威方案-b--accepted--2026-06-pve_integrity_plan-8) | PvE 数据走服务器权威（方案 B） | Accepted | 2026-06 |
| [ADR-007](DECISIONS_ADR-001-040.md#adr-007-slg-围攻--双方预布兵确定性自动战斗--accepted--2026-06-20g3) | SLG 围攻 = 双方预布兵确定性自动战斗 | Accepted | 2026-06-20 |
| [ADR-008](DECISIONS_ADR-001-040.md#adr-008-叙事铁律两本笔记本东西不混搭--accepted) | 叙事铁律：两本笔记本，东西不混搭 | Accepted | — |
| [ADR-009](DECISIONS_ADR-001-040.md#adr-009-经济养成体系体力--合成树--等值广告金币--accepted--2026-06-21) | 经济/养成体系：体力 + 合成树 + 等值广告金币 | Accepted | 2026-06-21 |
| [ADR-010](DECISIONS_ADR-001-040.md#adr-010-装备升级--概率强化取代5-件确定性合成升级--accepted--2026-06-21) | 装备升级 = 概率强化（取代"5 件确定性合成升级"） | Accepted | 2026-06-21 |
| [ADR-011](DECISIONS_ADR-001-040.md#adr-011-留存系统--不新增金币龙头--accepted--2026-06-21) | 留存系统 = 不新增金币龙头 | Accepted | 2026-06-21 |
| [ADR-012](DECISIONS_ADR-001-040.md#adr-012-装备生命周期有限回收--库存上限--3-槽确认--accepted--2026-06-21) | 装备生命周期：有限回收 + 库存上限 + 3 槽确认 | Accepted | 2026-06-21 |
| [ADR-013](DECISIONS_ADR-001-040.md#adr-013-合规拆分为-global--cn-两份海外先行--accepted--2026-06-21) | 合规拆分为 Global / CN 两份，海外先行 | Accepted | 2026-06-21 |
| [ADR-014](DECISIONS_ADR-001-040.md#adr-014-活动live-ops--叠加既有系统的受控容器不新增金币龙头--accepted--2026-06-21) | 活动/Live-ops = 叠加既有系统的受控容器，不新增金币龙头 | Accepted | 2026-06-21 |
| [ADR-015](DECISIONS_ADR-001-040.md#adr-015-文档缺口补全实现前收口--accepted--2026-06-21) | 文档缺口补全（实现前收口） | Accepted | 2026-06-21 |
| [ADR-016](DECISIONS_ADR-001-040.md#adr-016-角色卡--6-张涛3现有兵转具名锚点--anna3新画变体--accepted--2026-06-21) | 角色卡 = 6 张（涛3＝现有兵转具名·锚点 + Anna3＝新画变体） | Accepted | 2026-06-21 |
| [ADR-017](DECISIONS_ADR-001-040.md#adr-017-装备洗练--技能槽-02--2-条可锁定重洗抽卡与皮肤共池--accepted--2026-06-21) | 装备洗练 = 技能槽 0–2 + 2 条可锁定重洗；抽卡与皮肤共池 | Accepted | 2026-06-21 |
| [ADR-018](DECISIONS_ADR-001-040.md#adr-018-海外分级自定为-13不面向儿童--accepted--2026-06-21) | 海外分级自定为 13+（不面向儿童） | Accepted | 2026-06-21 |
| [ADR-019](DECISIONS_ADR-001-040.md#adr-019-多区域部署--meta-共享--对战层按区隔离--中国独立--accepted--2026-06-23) | 多区域部署 = Meta 共享 + 对战层按区隔离 + 中国独立 | Accepted | 2026-06-23 |
| [ADR-020](DECISIONS_ADR-001-040.md#adr-020-跨平台账号钱包隔离边界--accepted--2026-06-23) | 跨平台账号/钱包隔离边界 | Accepted | 2026-06-23 |
| [ADR-021](DECISIONS_ADR-001-040.md#adr-021-独立-socialsvc--第五公网面推翻-soc1--accepted--2026-06-28) | 独立 socialsvc = 第五公网面，推翻 SOC1 | Accepted | 2026-06-28 |
| [ADR-022](DECISIONS_ADR-001-040.md#adr-022-slg-主城建筑系统--仿三战书桌内政资源--4-地块--1-铜币建筑赛季清空--accepted--2026-06-30) | SLG 主城建筑系统 = 仿三战书桌内政；资源 = 4 地块 + 1 铜币；建筑赛季清空 | Accepted | 2026-06-30 |
| [ADR-023](DECISIONS_ADR-001-040.md#adr-023-服务端契约从运行时解析改为构建期代码生成--accepted--2026-06-30) | 服务端契约从「运行时解析」改为「构建期代码生成」 | Accepted | 2026-06-30 |
| [ADR-024](DECISIONS_ADR-001-040.md#adr-024-slg-世界地图配色--纸底地形--motif-载类型归属只用彩色描边wash--accepted--2026-07-01) | SLG 世界地图配色 = 纸底地形 + motif 载类型；归属只用彩色描边/wash | Accepted | 2026-07-01 |
| [ADR-025](DECISIONS_ADR-001-040.md#adr-025-slg-主城--真占-339-格实体封路--一体防守--计-9-格--accepted--2026-07-02) | SLG 主城 = 真占 3×3=9 格实体（封路 + 一体防守 + 计 9 格） | Accepted | 2026-07-02 |
| [ADR-026](DECISIONS_ADR-001-040.md#adr-026-slg-建筑攻防--血量--逐队守军波次--攻城值延迟结算--accepted--2026-07-02) | SLG 建筑攻防 = 血量 + 逐队守军波次 + 攻城值延迟结算 | Accepted | 2026-07-02 |
| [ADR-026b](DECISIONS_ADR-001-040.md#adr-026b-拍卖物品交割退回--escrow-out--系统邮件废弃溢出暂存区--accepted--2026-07-02) | 拍卖物品交割/退回 = escrow-out + 系统邮件（废弃"溢出暂存区"） | Accepted | 2026-07-02 |
| [ADR-027](DECISIONS_ADR-001-040.md#adr-027-品牌-logo--盾徽--文具三笔蓝主导--无字大小双版本--accepted--2026-07-02) | 品牌 Logo = 盾徽 + 文具三笔（蓝主导 / 无字）；大小双版本 | Accepted | 2026-07-02 |
| [ADR-028](DECISIONS_ADR-001-040.md#adr-028-盲盒进阶变现--软保底--限定池-5050-歪命运点--月卡新手包--accepted--2026-07-02) | 盲盒进阶变现 = 软保底 + 限定池 50/50 歪+命运点 + 月卡/新手包 | Accepted | 2026-07-02 |
| [ADR-029](DECISIONS_ADR-001-040.md#adr-029-slg-世界地图渲染从正交方格改为等距菱形投影--accepted--2026-07-02) | SLG 世界地图渲染从正交方格改为等距菱形投影 | Accepted | 2026-07-02 |
| [ADR-030](DECISIONS_ADR-001-040.md#adr-030-深化金币-sink洗练金币化--slg-便利--外观广度-pve-多人副本--slg-新手区毕业软过渡--accepted--2026-07-03) | 深化金币 sink（洗练金币化 / SLG 便利 / 外观广度）+ PvE 多人副本 + SLG 新手区毕业软过渡 | Accepted | 2026-07-03 |
| [ADR-031](DECISIONS_ADR-001-040.md#adr-031-订阅卡全局单卡门控--年卡九折-商店图标卡网格--accepted--2026-07-03) | 订阅卡全局单卡门控 + 年卡（九折）+ 商店图标卡网格 | Accepted | 2026-07-03 |
| [ADR-032](DECISIONS_ADR-001-040.md#adr-032-slg-大地图尺寸-500500--地块等级-1-10--取消无产出中立地--accepted--2026-07-04) | SLG 大地图尺寸 500×500 + 地块等级 1-10 + 取消无产出中立地 | Accepted | 2026-07-04 |
| [ADR-033](DECISIONS_ADR-001-040.md#adr-033-slg-国家版图三战式环带布局--等级险地与国家身份绑定--superseded-by-adr-034--2026-07-05) | SLG 国家版图三战式环带布局 + 等级/险地与「国家身份」绑定 | Superseded by ADR-034 | 2026-07-05 |
| [ADR-034](DECISIONS_ADR-001-040.md#adr-034-slg-国家版图改为环形分层结构6-出生州3-资源州1-核心州-地形隔离城池体系拍板--accepted--2026-07-05) | SLG 国家版图改为环形分层结构（6 出生州+3 资源州+1 核心州）+ 地形隔离/城池体系拍板 | Accepted | 2026-07-05 |
| [ADR-035](DECISIONS_ADR-001-040.md#adr-035-地图编辑器游戏渲染对齐河山可分--城池按级出图与占地--accepted--2026-07-06) | 地图编辑器/游戏渲染对齐：河/山可分 + 城池按级出图与占地 | Accepted | 2026-07-06 |
| [ADR-036](DECISIONS_ADR-001-040.md#adr-036-场景切换动画收窄到进出对局进出-slg四处--遮罩改纸色调--accepted--2026-07-12) | 场景切换动画收窄到「进出对局/进出 SLG」四处 + 遮罩改纸色调 | Accepted | 2026-07-12 |
| [ADR-037](DECISIONS_ADR-001-040.md#adr-037-占领行军接入-pve-战斗--占领倒计时延迟落地镜像-adr-026--accepted--2026-07-13) | 占领行军接入 PvE 战斗 + 占领倒计时（延迟落地，镜像 ADR-026） | Accepted | 2026-07-13 |
| [ADR-038](DECISIONS_ADR-001-040.md#adr-038-废弃-collectionscene皮肤装备关系从全局单槏位改为逐卡独立--accepted--2026-07-13) | 废弃 `CollectionScene`，皮肤装备关系从全局单槏位改为逐卡独立 | Accepted | 2026-07-13 |
| [ADR-039](DECISIONS_ADR-001-040.md#adr-039-slg-连地占领硬性规则宗门级判定含首府桥栈道-accepted--2026-07-14) | SLG 连地占领硬性规则（宗门级判定，含首府/桥栈道） | Accepted | 2026-07-14 |
| [ADR-040](DECISIONS_ADR-001-040.md#adr-040-metaserver-openapiyml-按域拆分为-fragment合并生成服务不拆-accepted--2026-07-14) | metaserver `openapi.yml` 按域拆分为 fragment，合并生成（服务不拆） | Accepted | 2026-07-14 |
| [ADR-041](DECISIONS_ADR-041-onward.md#adr-041-主城点击直达-desk去掉城池菜单弹窗-清理主城手动防守配置残留--accepted--2026-07-18) | 主城点击直达 Desk（去掉城池菜单弹窗）+ 清理主城「手动防守配置」残留 | Accepted | 2026-07-18 |
| [ADR-042](DECISIONS_ADR-041-onward.md#adr-042-家族加入改为需-leaderelder-审批解决-social_svc_design-8-o1-accepted--2026-07-18) | 家族加入改为需 leader/elder 审批（解决 SOCIAL_SVC_DESIGN §8 O1） | Accepted | 2026-07-18 |
| [ADR-043](DECISIONS_ADR-041-onward.md#adr-043-角色卡升级从连续-xp-曲线改为离散五合一融合--背包-150500-扩容--accepted--2026-07-19) | 角色卡升级从连续 XP 曲线改为离散五合一融合 + 背包 150→500 扩容 | Accepted | 2026-07-19 |
| [ADR-044](DECISIONS_ADR-041-onward.md#adr-044-cityscenehome-desk开关改为-scenemanager-覆盖层不再重建-worldmapscene--accepted--2026-07-20) | CityScene（Home Desk）开关改为 SceneManager 覆盖层，不再重建 WorldMapScene | Accepted | 2026-07-20 |
| [ADR-045](DECISIONS_ADR-041-onward.md#adr-045-累计充值商城可见自主领取非静默邮件-退款扣计数器--不回填历史--accepted--2026-07-21) | 累计充值：商城可见自主领取（非静默邮件）+ 退款扣计数器 + 不回填历史 | Accepted | 2026-07-21 |
| [ADR-046](DECISIONS_ADR-041-onward.md#adr-046-slg-覆盖层扩展到全部子界面从世界地图打开的任何界面返回时都不重建地图--accepted--2026-07-21) | SLG 覆盖层扩展到全部子界面：从世界地图打开的任何界面返回时都不重建地图 | Accepted | 2026-07-21 |
| [ADR-047](DECISIONS_ADR-041-onward.md#adr-047-行军疲劳绑定行军实例非队伍-只做距离消耗不做静止回复--accepted--2026-07-21) | 行军疲劳：绑定行军实例（非队伍）+ 只做距离消耗，不做静止回复 | Accepted | 2026-07-21 |
| [ADR-048](DECISIONS_ADR-041-onward.md#adr-048-slg-兵力池统一basetroopstock-并入-playerworldtroops补记-adr--accepted--2026-07-22) | SLG 兵力池统一：`baseTroopStock` 并入 `playerWorld.troops`（补记 ADR） | Accepted | 2026-07-22 |
| [ADR-049](DECISIONS_ADR-041-onward.md#adr-049-slg-地图尺寸-500500--15001500对齐主流-slg-accepted--2026-07-22) | SLG 地图尺寸 500×500 → 1500×1500（对齐主流 SLG） | Accepted | 2026-07-22 |
| [ADR-050](DECISIONS_ADR-041-onward.md#adr-050-装备分解新增稀有度门槛史诗-epic-永不可分解不论等级--accepted--2026-07-22) | 装备分解新增稀有度门槛：史诗 Epic 永不可分解，不论等级 | Accepted | 2026-07-22 |
| [ADR-051](DECISIONS_ADR-041-onward.md#adr-051-slg-实时野战遭遇系统停留驻扎拆分--redis-逐格行军--玩家建筑层--accepted--2026-07-24) | SLG 实时野战遭遇系统：停留/驻扎拆分 + Redis 逐格行军 + 玩家建筑层 | Accepted | 2026-07-24 |
| [ADR-052](DECISIONS_ADR-041-onward.md#adr-052-f2p-月度金币产出基线从-300-重定为-29008700补跑总产出核算--accepted--2026-07-27) | F2P 月度金币产出基线从 "~300" 重定为 "~2,900–8,700"（补跑总产出核算） | Accepted | 2026-07-27 |
| [ADR-053](DECISIONS_ADR-041-onward.md#adr-053-行军疲劳预算改为地图比率制修复-adr-047-vs-adr-049-的漂移--accepted--2026-07-27) | 行军疲劳预算改为地图比率制，修复 ADR-047 vs ADR-049 的漂移 | Accepted | 2026-07-27 |
| [ADR-054](DECISIONS_ADR-041-onward.md#adr-054-slg-险地持久材料掉率下调408级修复-adr-049-引入的经济稀释破线--accepted--2026-07-27) | SLG 险地持久材料掉率下调（4→0.8/级）修复 ADR-049 引入的经济稀释破线 | Accepted | 2026-07-27 |
| [ADR-055](DECISIONS_ADR-041-onward.md#adr-055-工具协作方向改为-electron-桌面壳--本地-git取代-animator-云工作区同步桥--accepted--2026-07-28) | 工具协作方向改为 Electron 桌面壳 + 本地 git，取代 animator 云工作区同步桥 | Accepted | 2026-07-28 |
| [ADR-056](DECISIONS_ADR-041-onward.md#adr-056-equippedflags-改全服务器权威put-save-整个下线--accepted--2026-07-28) | `equipped`/`flags` 改全服务器权威，`PUT /save` 整个下线 | Accepted | 2026-07-28 |
| [ADR-057](DECISIONS_ADR-041-onward.md#adr-057-内容治理体系敏感词归一化--词库外部化--举报处理闭环--信誉分分级处罚--审核申诉后台--accepted--2026-07-29) | 内容治理体系（敏感词归一化 + 词库外部化 + 举报处理闭环 + 信誉分分级处罚 + 审核/申诉后台） | Accepted | 2026-07-29 |
| [ADR-058](DECISIONS_ADR-041-onward.md#adr-058-客户端出站请求全局限速-5秒--补齐-metaserver-超时--三个-slg-社群场景补齐-busy-锁按钮置灰--accepted--2026-08-01) | 客户端出站请求全局限速 5/秒 + 补齐 metaserver 超时 + 三个 SLG 社群场景补齐 busy 锁/按钮置灰 | Accepted | 2026-08-01 |
| [ADR-059](DECISIONS_ADR-041-onward.md#adr-059-物品唯一id溯源范围--装备角色卡补溯源字段材料皮肤称号维持数量计数去重集合--accepted--2026-08-04) | 物品唯一id/溯源范围 — 装备/角色卡补溯源字段，材料/皮肤/称号维持数量计数/去重集合 | Accepted | 2026-08-04 |
| [ADR-060](DECISIONS_ADR-041-onward.md#adr-060-slg-世界地图新增两档归属色宗门成员紫-盟友宗门琥珀--accepted--2026-08-08) | SLG 世界地图新增两档归属色：宗门成员（紫）/ 盟友宗门（琥珀） | Accepted | 2026-08-08 |
| [ADR-061](DECISIONS_ADR-041-onward.md#adr-061-皮肤实例化落地item_identity_designmd-任务1真实例--玩家主动出售拍卖挂单契约不变--accepted--2026-08-08) | 皮肤实例化落地（ITEM_IDENTITY_DESIGN.md 任务1）：真实例 + 玩家主动出售，拍卖挂单契约不变 | Accepted | 2026-08-08 |
| [ADR-062](DECISIONS_ADR-041-onward.md#adr-062-pvp-攻打真人领地复用占领倒计时不再即时易主-修复已占领地块的资源类型不显示--accepted--2026-08-09) | PvP 攻打真人领地复用占领倒计时（不再即时易主）+ 修复已占领地块的资源类型不显示 | Accepted | 2026-08-09 |
| [ADR-063](DECISIONS_ADR-041-onward.md#adr-063-装备强化主词条倍率改非线性递增表--78-引入掉级风险--accepted--2026-08-10) | 装备强化：主词条倍率改非线性递增表 + +7/+8 引入掉级风险 | Accepted | 2026-08-10 |
| [ADR-064](DECISIONS_ADR-041-onward.md#adr-064-装备背包库存硬上限由-300-提升至-1000--accepted--2026-08-10) | 装备背包库存硬上限由 300 提升至 1000 | Accepted | 2026-08-10 |
| [ADR-065](DECISIONS_ADR-041-onward.md#adr-065-引擎战斗数值全面定点化所有连续型战斗数值-fp_scale1000统一复用现有定点域--accepted--2026-08-12) | 引擎战斗数值全面定点化（所有连续型战斗数值 ×FP_SCALE=1000，统一复用现有定点域） | Accepted | 2026-08-12 |
| [ADR-066](DECISIONS_ADR-041-onward.md#adr-066-8-个-cd-workflow-改为依赖-ciworkflow_run不再与-ciyml-并行竞速--accepted--2026-08-12) | 8 个 CD workflow 改为依赖 CI（`workflow_run`），不再与 `ci.yml` 并行竞速 | Accepted | 2026-08-12 |
| [ADR-067](DECISIONS_ADR-041-onward.md#adr-067-设计文档单文件-500-行上限--hub-索引--分册结构--accepted--2026-08-17) | 设计文档单文件 500 行上限 + 「hub 索引 / 分册」结构 | Accepted | 2026-08-17 |
| [ADR-068](DECISIONS_ADR-041-onward.md#adr-068-融合面板目标意图契约取代自动换目标--自动连续融合--accepted--2026-08-18) | 融合面板：目标意图契约取代自动换目标 / 自动连续融合 | Accepted | 2026-08-18 |
| [ADR-069](DECISIONS_ADR-041-onward.md#adr-069-slg-攻城值随携带兵力缩放破城不再有12-卡硬顶-npcbasehp-重校准-4060--accepted--2026-08-19) | SLG 攻城值随携带兵力缩放（破城不再有「12 卡硬顶」）+ npcBaseHp 重校准 40→60 | Accepted | 2026-08-19 |
| [ADR-070](DECISIONS_ADR-041-onward.md#adr-070-tools-覆盖率口径-scoped-include-与-reported-not-gated-过渡--accepted--2026-08-20) | `tools/` 覆盖率口径：scoped include + 「reported, not gated」过渡 | Accepted | 2026-08-20 |
| [ADR-071](DECISIONS_ADR-041-onward.md#adr-071-门禁盲区收口--非-workspace-包接进-ci--desktop-shell-接进可达性--客户端覆盖率-scope-扩到已测模块--accepted--2026-08-21) | 门禁盲区收口：非 workspace 包接进 CI、`desktop-shell` 接进可达性、客户端覆盖率 scope 扩到已测模块 | Accepted | 2026-08-21 |
| [ADR-072](DECISIONS_ADR-041-onward.md#adr-072-装备页改为卡背包之上的-overlay--adr-044-的模式下沉到成长组--accepted--2026-08-25) | 装备页改为卡背包之上的 overlay：卡背包不再重建，滚动位置与详情弹窗跨岔路留存 | Accepted | 2026-08-25 |
| [ADR-073](DECISIONS_ADR-041-onward.md#adr-073-整页-bake-按上屏缩放定分辨率--横屏宽高比上限--纹理字节口径--accepted--2026-08-25) | 整页 bake 按上屏缩放定分辨率（修手机整页纹理 111 MB/张）+ 横屏 2.4:1 宽高比上限 + 纹理字节口径 | Accepted | 2026-08-25 |

---

## 分册

| 范围 | 文件 |
|---|---|
| ADR-001 ~ ADR-040 | [`DECISIONS_ADR-001-040.md`](DECISIONS_ADR-001-040.md) |
| ADR-041 起（**新增写这里**） | [`DECISIONS_ADR-041-onward.md`](DECISIONS_ADR-041-onward.md) |

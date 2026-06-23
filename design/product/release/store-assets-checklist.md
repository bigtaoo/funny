# 应用商店素材 + 分级 + 健康忠告清单（四渠道）

> 创建：2026-06-23。Track 3 L3-3 产出。
> **本文是上架素材的单一清单**：逐项列出每个发布渠道所需的图标、截图、描述、分级问卷答案、隐私标签、健康忠告文案。
> ⚠️ 隐私标签/数据安全表的答案必须与 [`privacy-policy.zh.md §2`](../legal/privacy-policy.zh.md) 及 [`COMPLIANCE_GLOBAL.md §3.2`](../../game/COMPLIANCE_GLOBAL.md) 的数据清单**逐项一致**（三处口径不得打架）。
> 美术素材未就位的标 **「待美术」**；文案三语随附。
> 对外产品名：**Nivara**（开发代号 Notebook Wars）。

---

## 0. 通用素材池（各渠道复用）

### 0.1 产品文案（三语）

| 字段 | 中文 | English | Deutsch |
|---|---|---|---|
| 名称 | Nivara | Nivara | Nivara |
| 副标题/一句话 | 笔记本里的回合策略战争 | Turn-based strategy in a notebook | Rundenstrategie im Notizbuch |
| 简短描述 | 在手绘笔记本世界里排兵布阵，东西两本笔记的策略对决。战役 PvE + 实时联机 PvP + 大世界 SLG。 | Command armies in a hand-drawn notebook world — an East-meets-West strategy duel. Campaign PvE + real-time PvP + open-world SLG. | Befehlige Armeen in einer handgezeichneten Notizbuchwelt — ein Strategieduell zwischen Ost und West. Kampagne-PvE + Echtzeit-PvP + Open-World-SLG. |

> 长描述（每渠道字数上限不同）以简短描述为基底扩写，强调：手绘笔记本美术、回合策略深度、战役剧情（陶 vs Anna 东西碰撞）、联机对战、养成（不破坏 PvP 公平）。**避免**「赌博/博彩」类措辞（盲盒措辞统一为「付费随机道具」并指向概率公示）。

### 0.2 关键词 / 标签（待各渠道适配）
策略, 回合制, 联机对战, 笔记本, 手绘, 战棋 / strategy, turn-based, multiplayer, notebook, hand-drawn, tactics / Strategie, rundenbasiert, Mehrspieler, Notizbuch, Taktik

### 0.3 数据收集口径（隐私标签/数据安全表统一来源）
以 [`privacy-policy §2`](../legal/privacy-policy.zh.md) 为准，简表：

| 数据 | 是否收集 | 关联身份 | 是否用于跟踪 | 用途 |
|---|---|---|---|---|
| 设备 ID（deviceId） | 是 | 是 | 否 | 账号/防作弊 |
| 邮箱/登录 ID | 可选 | 是 | 否 | 账号/云存档 |
| 昵称 | 可选 | 是 | 否 | 社交展示 |
| 购买记录 | 是（充值时） | 是 | 否 | 内购履约 |
| 行为埋点 | 是（EU/UK 需同意） | 假名化 | 否 | 运营分析 |
| 私聊/通信 | 是（用社交时） | 是 | 否 | 通讯/治理 |
| 精确位置/通讯录/相机/麦克风 | **否** | — | — | — |
| 跨 App 广告跟踪标识 | **否**（不做 ATT 跟踪） | — | — | — |

---

## 1. Apple App Store（iOS）

### 1.1 图标 / 截图规格
| 素材 | 规格 | 状态 |
|---|---|---|
| App 图标 | 1024×1024 PNG（无圆角、无 alpha） | 待美术 |
| iPhone 6.7" 截图 | 1290×2796（或 1284×2778），最少 3 张、最多 10 张 | 待美术 |
| iPhone 6.5" 截图 | 1242×2688 | 待美术 |
| iPad 12.9"（如支持） | 2048×2732 | 待美术 / 视是否支持 iPad |
| App 预览视频（可选） | 各设备分辨率，15–30s | 待美术（可选） |

### 1.2 元数据
- 名称（≤30 字符）、副标题（≤30）、描述、关键词（≤100 字符逗号分隔）、推广文本——三语（见 §0.1）。
- 隐私政策 URL：`{{PRIVACY_POLICY_URL}}`（必填）。
- 支持 URL / 营销 URL。

### 1.3 年龄分级（Apple 自有问卷）
如实勾选（拉高分级但漏报=下架风险）：
- **模拟赌博 / 含随机付费道具（gacha）**：是（频繁/强烈视实际）。
- **用户互动 / 不受限网络访问（社交、私聊）**：是。
- 预期落点：**12+ / Teen 档**（以问卷结果为准；不得勾成全年龄/儿童，见 [`COMPLIANCE_GLOBAL §3.4`](../../game/COMPLIANCE_GLOBAL.md)）。

### 1.4 隐私营养标签（Privacy Nutrition Label）
按 §0.3 填写：
- **Data Used to Track You**：无（声明不做跨 App 跟踪 → 免 ATT 弹窗）。
- **Data Linked to You**：标识符（设备 ID）、联系信息（邮箱，可选）、用户内容（昵称/私聊）、购买、使用数据（埋点）。
- **Data Not Linked to You**：诊断（如崩溃日志，假名化）。
- 是否加密传输：是；是否可请求删除：是（应用内删除账号）。

### 1.5 合规硬门（上架前必过，见 COMPLIANCE_GLOBAL §8 iOS 专属）
- [ ] 平台 IAP 接入（替换 dev 桩）+ 服务端票据校验
- [ ] 应用内删除账号入口（5.1.1(v)）——Track 1 L1-2 已实现
- [ ] 抽卡概率公示页（3.1.1）——Track 1 L1-3
- [ ] 隐私政策 URL 可点（登录/设置页）

---

## 2. Google Play（Android）

### 2.1 图标 / 截图 / 图形
| 素材 | 规格 | 状态 |
|---|---|---|
| 应用图标 | 512×512 PNG（32-bit, alpha） | 待美术 |
| 特征图（Feature Graphic） | 1024×500 | 待美术 |
| 手机截图 | 16:9 或 9:16，最少 2 张（建议 4–8），1080p+ | 待美术 |
| 平板截图（如支持） | 7"/10" 各一组 | 待美术 / 视支持 |
| 宣传视频（可选） | YouTube 链接 | 可选 |

### 2.2 元数据
- 应用名称（≤30）、简短描述（≤80）、完整描述（≤4000）——三语（见 §0.1）。
- 隐私政策 URL：`{{PRIVACY_POLICY_URL}}`（必填）。

### 2.3 年龄分级（IARC 问卷）
- 含**随机付费道具（gacha）/ 模拟赌博**：如实勾。
- 含**用户互动 / 可分享内容 / 用户间通信**：是。
- 预期：**Teen / PEGI 12** 档（以问卷为准）。

### 2.4 数据安全表（Data Safety）
按 §0.3 声明：收集项、是否加密传输（是）、是否可请求删除（是）、是否与第三方共享（IAP/分析/广告 SDK，见隐私政策 §5）、是否用于跟踪（否）。

### 2.5 合规硬门（COMPLIANCE_GLOBAL §8 Google Play 专属）
- [ ] Play Billing 接入 + 校验
- [ ] 数据安全表填写（对齐 §0.3）
- [ ] IARC 分级问卷
- [ ] 删除账号入口（Apple 已要求，Play 跟进）

---

## 3. 微信小游戏（中国大陆）

> ⚠️ 中国区受版号/实名/防沉迷约束，**跟版号流程走**，海外测试期不阻断（见 [`COMPLIANCE_CN.md`](../../game/COMPLIANCE_CN.md)）。本节列素材需求；版号相关合规项另由 Track 2 L2-4 实现。

### 3.1 素材规格
| 素材 | 规格 | 状态 |
|---|---|---|
| 小游戏图标 | 192×192 + 圆形版本 | 待美术 |
| 分享图 | 5:4（建议 500×400） | 待美术 |
| 截图 | 按微信后台要求 | 待美术 |
| 小游戏名称/简介 | 中文 | 见 §0.1 中文 |

### 3.2 资质 / 合规（中国区硬门，依版号流程）
- [ ] **网络游戏版号（ISBN）**——前置一切（Track 2 L2-4 / 发行方）。
- [ ] 实名认证接入。
- [ ] 未成年人防沉迷限时（时段+时长）。
- [ ] 分龄充值限额（<8 拒付 / 8–16 / 16–18 上限）。
- [ ] 抽卡概率公示页。
- [ ] **健康游戏忠告 + 适龄提示标识**（见 §5）。
- [ ] 微信支付接入（非 Apple/Google IAP）。
- [ ] 隐私政策（中国区版本，含 PIPL 条款）。

### 3.3 分级 / 适龄提示
- 适龄提示标识（8+/12+/16+，依《网络游戏适龄提示》团标，落点待评估，预期 **12+**）。

---

## 4. CrazyGames（Web 聚合平台）

### 4.1 素材规格
| 素材 | 规格 | 状态 |
|---|---|---|
| 缩略图 | 按 CrazyGames 开发者要求（通常 16:9，建议 1280×720） | 待美术 |
| 游戏标题/描述 | 英文（见 §0.1 EN） | — |
| 操作说明 | 鼠标/触屏操作说明 | 待补 |

### 4.2 合规 / 平台要求（COMPLIANCE_GLOBAL §8 Web 专属）
- [ ] 隐私政策 URL 可访问 + 客户端可点。
- [ ] cookie/同意条（若用分析 cookie）+ EU/UK 同意弹层（Track 1 L1-1）。
- [ ] 支付渠道合规 + 虚拟道具条款（见用户协议 §5/§6）。
- [ ] CrazyGames 内容政策逐条核对（含广告 SDK 兼容、外链限制）。
- [ ] 抽卡概率公示页可达。

---

## 5. 健康游戏忠告 / 适龄提示 文案

### 5.1 中国区「健康游戏忠告」（标准文案，启动页/设置页展示）
> 抵制不良游戏，拒绝盗版游戏。注意自我保护，谨防受骗上当。
> 适度游戏益脑，沉迷游戏伤身。合理安排时间，享受健康生活。

- 配套展示：实名/防沉迷规则说明、适龄提示标识（预期 12+）、抽卡概率入口。

### 5.2 全球版「健康提示」（轻量，设置页/首启可选展示）

| 语言 | 文案 |
|---|---|
| 中文 | 温馨提示：适度游戏，合理安排时间，注意休息。本游戏含付费随机道具，概率详情见游戏内公示。 |
| English | A friendly reminder: play in moderation, take breaks, and manage your time. This game includes paid random items; see in-game odds disclosure for details. |
| Deutsch | Freundlicher Hinweis: Spielen Sie in Maßen, machen Sie Pausen und teilen Sie Ihre Zeit gut ein. Dieses Spiel enthält kostenpflichtige Zufallsgegenstände; Einzelheiten zur Wahrscheinlichkeit finden Sie in der In-Game-Offenlegung. |

---

## 6. 上架前总核对（汇总）

| 渠道 | 素材就绪 | 分级问卷 | 隐私标签/数据表 | 合规硬门 | 健康忠告 |
|---|---|---|---|---|---|
| iOS | 待美术 | §1.3 待填 | §1.4 待填 | §1.5 | 全球版 §5.2 |
| Google Play | 待美术 | §2.3 待填 | §2.4 待填 | §2.5 | 全球版 §5.2 |
| 微信小游戏 | 待美术 | §3.3 待评估 | 隐私政策(CN) | §3.2（依版号） | 中国区 §5.1 |
| CrazyGames | 待美术 | 平台要求 | 隐私政策 | §4.2 | 全球版 §5.2 |

> **依赖提醒**：截图/图标统一「待美术」；隐私标签答案依赖 §0.3 定稿（已与隐私政策对齐）；中国区整块依赖版号流程（Track 2 L2-4）。

# Notebook Wars — 海外合规设计（Web / iOS / Google Play）

> 状态：设计中 · 权威：本文（海外三渠道合规的单一入口）· 更新：2026-06-21
>
> ⚠️ **本文是工程侧合规映射，不是法律意见。** 涉及隐私政策文本、年龄分级问卷答案、未成年人判定阈值等，最终以平台审核要求与法务/律师确认为准。本文负责的是「把合规义务翻译成代码/配置/上架清单上的 TODO」。

---

## 1. 范围与定位

- **覆盖渠道（本次海外测试 + 首发）**：①网页（自有域名 / CrazyGames 等聚合平台）；②iOS App Store；③Google Play。
- **不覆盖**：中国大陆上架（版号 / 实名 / 防沉迷 / PIPL / 分龄充值限额）——那是**另一套、跟着版号流程走**，见占位 [`COMPLIANCE_CN.md`](COMPLIANCE_CN.md)（尚未建，版号启动时再写）。两份解耦：海外测试**不**需要中国那套。
- **决策依据**：见 [`../DECISIONS.md`](../DECISIONS.md) ADR-013（合规拆分为 Global / CN 两份）。

> 一句话原则：**海外没有"防沉迷"，但有隐私、年龄分级、抽卡概率公示、平台支付/数据表四道硬门**——其中**抽卡概率公示**和**平台内购强制**最容易在审核时卡你。

---

## 2. 法规 / 平台政策矩阵

| 义务 | 来源 | 适用渠道 | 命中我们的系统 | 现状 |
|---|---|---|---|---|
| 隐私政策（公开链接） | 三大平台 + 各地区法律 | Web / iOS / Android | 全局 | ❌ 待写 |
| GDPR / UK GDPR（同意、数据权利、删除） | 欧盟 / 英国 | 全（有 EU/UK 玩家即触发） | account / analyticsvc / commercial | 🟡 部分（analytics §10 有删除钩子） |
| COPPA（13 岁以下儿童） | 美国 | 全 | account（年龄门）/ analyticsvc | ❌ 待定年龄策略 |
| 年龄分级（IARC / ESRB / PEGI / Apple） | 平台 | iOS / Android（+ 部分 web 平台） | 含 gacha/社交需如实勾选 | ❌ 待填问卷 |
| **抽卡概率公示（odds disclosure）** | **Apple 3.1.1 / Google Play / 多地区法律** | **全** | **commercial GachaPool weight + pity** | 🟡 数据已在 commercial，缺公示页 |
| 平台内购强制（数字商品只能用平台 IAP） | Apple 3.1.1 / Google Play Payments | iOS / Android | commercial 充值 / `iapVerify` | 🟡 客户端有 dev 桩，待接真 SDK |
| iOS 隐私营养标签 + ATT | Apple | iOS | analyticsvc 采集项 | ❌ 待填 |
| Google Play 数据安全表 | Google | Android | analyticsvc 采集项 | ❌ 待填 |
| 应用内删除账号入口 | Apple 5.1.1(v)（有注册即强制） | iOS（Android 跟进） | account / save / commercial | ❌ 待建 |
| UGC 治理（昵称 / 私聊） | 平台 + 各地区 | 全 | social 私聊 / displayName | 🟡 有基础敏感词，缺举报 |

---

## 3. 隐私合规（GDPR / COPPA / 通用）

### 3.1 隐私政策
- **必须有一个公开可访问的隐私政策页**（自有域名 URL），三大平台上架表单都要填。内容至少覆盖：收集了哪些数据、用途、第三方共享（CrazyGames/广告/分析）、留存期、用户权利、联系方式。
- 客户端在**登录/注册界面**与**设置页**给出可点链接（`LoginScene` / `SettingsScene` 加入口）。

### 3.2 数据清单（先盘清"到底收了什么"，分级才填得对）
| 数据 | 来源系统 | 是否个人信息 | 备注 |
|---|---|---|---|
| deviceId（设备 UUID） | account（`getOrCreateDeviceId`） | 是（标识符） | 匿名账号底座 |
| 邮箱 / loginId | account（密码注册） | 是 | 可选，单机/匿名不收 |
| displayName | account | 用户自填 | UGC，需治理（§7） |
| 充值票据 / 订单 | commercial | 是（交易） | 平台 IAP 回执 |
| 行为埋点事件 | analyticsvc | 假名化 user_id | 见 ANALYTICS §10 |
| 私聊文本 | social | 是（通信） | 敏感词过滤 |

### 3.3 同意与撤回
- **EU/UK 玩家**：埋点/广告类非必要数据采集需**事先同意**（opt-in），不能默认开。复用 `analyticsvc` 顶层 `enabled` 开关（ANALYTICS §10）作为撤回闸门——但需在前端补**首次同意弹窗**（按地区/IP 粗判是否弹）。
- Web 端如用 cookie/localStorage 做分析，需 cookie 同意条。
- **撤回 = 关采集 + 可请求删除**：analyticsvc 已支持按 `user_id` 批删事件;account/save/commercial 侧的删除走 §3.5。

### 3.4 儿童（COPPA / GDPR-K）
- **决策待定**：是否面向 13 岁以下？建议**自我定级为「13+ / 不面向儿童」**，规避 COPPA/家长同意的重负担。
- 落地：注册/进入时**年龄声明门**（neutral age gate，不诱导）；分级问卷如实勾选；不投放面向儿童的定向广告。
- ⚠️ 若分级勾成全年龄/含儿童，则触发一整套家长同意 + 数据最小化义务——**测试期明确不走这条**。

### 3.5 数据权利与删除账号
- **Apple 5.1.1(v) 强制**：凡支持账号注册的 App，**必须提供应用内删除账号入口**（不能只让发邮件）。
- 落地：`SettingsScene` 加「删除账号」→ 二次确认 → 调新端点 `POST /account/delete`（meta 编排：删/匿名化 saves + 通知 commercial 处理钱包/交易留存 + analyticsvc 按 user_id 删事件 + social 解好友关系）。**契约待补进 [`SERVER_API.md`](SERVER_API.md)**。
- GDPR 数据导出（DSAR）：测试期可走人工，正式期再做自助导出。

---

## 4. 抽卡概率公示（最硬的一条）

> 我们有盲盒（`GachaScene` + commercial RNG），这条**中外通吃**：Apple 3.1.1、Google Play 都强制付费随机道具**公示各结果掉率**;部分地区已立法。

- **数据源已就位**：掉率 = commercial `GachaPool` 的 `weight`（COMMERCIAL §3）；保底 = `pity`。**不要在文档/客户端另写一套概率**——从配置算、单一来源。
- **待建：概率公示页**。在 `GachaScene` 给每个卡池一个「概率详情」入口，列出：
  - 每个稀有度 / 物品的**精确百分比**（由 weight 归一化算出）；
  - **保底规则**（多少抽必出 X）的明示文字；
  - 十连等捆绑的综合说明。
- **可由服务器下发**：commercial/meta 在 `getGachaPools` 回执里带归一化后的 `displayRates`，客户端纯展示（防止客户端口径漂移、便于审核取证）。
- i18n：`gacha.odds.*` 全语种。

---

## 5. 内购与支付

- **铁律**：iOS/Android 上**数字商品（金币/皮肤/抽卡）只能走平台 IAP**（Apple IAP / Google Play Billing），不得引导外部支付或暗示更便宜的站外购买（Apple 3.1.1 / 3.1.3 反引导条款）。
- **现状**：客户端 `iapVerify('dev-<ts>', tier)` 是 dev 桩（S2-6 / ECONOMY），上线**必须换成平台 SDK 回执**，服务端 `commercial` 校验真票据。
- **Web 端**：可用网页支付渠道（如自有 + 第三方），但若同一账号跨端，注意各端定价/到账一致。
- 虚拟货币需在商店页**标注为虚拟道具、不可退现、账号绑定**等条款（平台与消费者保护要求）。

---

## 6. 年龄分级 与 平台数据表

### 6.1 分级
- **IARC 问卷**（Google Play / 多数 web 平台共用）+ **Apple 自有分级**。如实勾选：含**模拟赌博 / 随机付费道具（gacha）**、**用户互动（社交/私聊）**——这两项会拉高分级，但**漏报 = 下架风险**，必须如实。
- 预期落点：**12+ / Teen 档**（含 gacha + 社交），具体以问卷结果为准。

### 6.2 平台数据表（与 §3.2 数据清单对齐，别两处打架）
- **iOS 隐私营养标签（Privacy Nutrition Label）** + 如有跨 App 跟踪需 **ATT 弹窗**（我们若不做定向广告跟踪，可声明「不跟踪」省掉 ATT）。
- **Google Play 数据安全表**：声明收集项、是否加密传输、是否可删除。
- 三处（隐私政策 / iOS 标签 / Play 表）**口径必须一致**，全部以 §3.2 清单为准。

---

## 7. UGC 治理（昵称 / 私聊）

- 平台对**用户可输入内容**（displayName、私聊）要求有治理手段，否则社交类分级 + 审核风险上升。
- **现状**：SOCIAL §敏感词——私聊一期做**发送端 meta 侧基础敏感词过滤**（替换/拒发）；displayName 改名也应过同一过滤。
- **测试期最低线**：①昵称/私聊敏感词过滤;②**举报 + 拉黑**入口（拉黑 social 已有，**举报待补**）。完整人工审核/分级后置。

---

## 8. 上架前渠道 Checklist

### 通用（三渠道都要）
- [ ] 隐私政策页上线（公开 URL）+ 客户端登录页/设置页可点
- [ ] 抽卡概率公示页（§4）
- [ ] 删除账号入口 + `POST /account/delete`（§3.5）
- [ ] 昵称/私聊敏感词 + 举报/拉黑（§7）
- [ ] EU/UK 同意弹窗 + 撤回开关（§3.3）

### iOS 专属
- [ ] 平台 IAP 接入（替换 dev 桩）+ 票据服务端校验
- [ ] 隐私营养标签填写（对齐 §3.2）
- [ ] ATT 处理（不跟踪则声明不跟踪）
- [ ] Apple 分级问卷（如实勾 gacha + 社交）
- [ ] 删除账号入口（5.1.1(v) 强制）

### Google Play 专属
- [ ] Play Billing 接入 + 校验
- [ ] 数据安全表填写（对齐 §3.2）
- [ ] IARC 分级问卷

### Web 专属
- [ ] cookie/同意条（若用分析 cookie）
- [ ] 聚合平台（CrazyGames 等）的隐私/内容要求逐条核对
- [ ] 支付渠道合规 + 虚拟道具条款

---

## 9. 实现挂钩与缺口

| 项 | 已有 | 待建 |
|---|---|---|
| 埋点同意/删除 | analyticsvc `enabled` 开关 + 按 user_id 删（ANALYTICS §10） | 首次同意弹窗（按地区） |
| 抽卡掉率数据 | commercial `GachaPool.weight` + pity | 公示页 + `displayRates` 回执字段 + i18n |
| 内购 | `iapVerify` dev 桩 | 平台 IAP/Billing SDK + 真票据校验 |
| 账号删除 | account 模型 | `POST /account/delete` 编排（SERVER_API 待补） |
| UGC | social 敏感词 + 拉黑 | 举报入口 + displayName 过滤接管 |
| 隐私政策入口 | — | LoginScene / SettingsScene 链接 |

---

## 10. 待办（开发顺序建议）

1. **隐私政策文本 + 上线 URL**（法务/模板，最先，三渠道表单都要填它）。
2. **抽卡概率公示页**（审核最易卡，且数据已就位，工程量小）。
3. **删除账号入口 + 端点**（iOS 强制）。
4. **平台 IAP/Billing 接入**（替换 dev 桩——变现前必须）。
5. **EU/UK 同意弹窗**（地区粗判 + 复用 analytics 开关）。
6. **举报入口 + displayName 过滤**（社交治理补齐）。
7. 分级问卷 / 数据表 / 隐私标签填写（上架表单阶段，依赖 §3.2 定稿）。

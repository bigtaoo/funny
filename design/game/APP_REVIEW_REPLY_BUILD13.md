# App Review 回复草稿：build 12 拒审（3.1.1 + 1.2）

> 状态：**草稿，待核对后发送**（2026-09-29 起草）。Submission ID `ed186ff4-7b13-4c46-b5ca-5063de561f1f`。
> 背景与实现见 `IOS_RELEASE.md §9.2 / §9.3`、`CONTENT_MODERATION_DESIGN.md §9.6`。

## 发送前检查

- [ ] 服务端已部署，VPS 上 socialsvc 已配 `NW_ALERT_WEBHOOK_URL`，发一条测试举报确认告警能到群里
- [ ] build 13 已上传并在 ASC 里替换 build 12
- [ ] 真机录屏已完成，链接可公开访问（不需要登录）
- [ ] 录屏链接同时写进 ASC「App Review Information → Notes」（以后每次提审都保留）
- [ ] 把下面英文稿里的 `[link]` 换成录屏链接

## 录屏脚本（真机）

1. 删掉 App 重装 → 首次启动出现 EULA 同意页，停留到能看清「Terms of Use (EULA)」和零容忍字样 → 同意
2. 登录页：展示表单下方「登录即同意 Terms of Use」那一行，点开链接看到 §7 零容忍条款 → 返回，用 demo 账号登录
3. 进私聊或世界聊天 → 点一条别人的消息 → Report → 选分类 → 提交，看到提示
4. 同一玩家 → Block → 确认 → 该玩家的消息立即从聊天里消失
5. 设置 → Help → Blocked players：看到刚屏蔽的人，可解除

## 英文回复（发给 Apple）

> Hello,
>
> Thank you for the review. We have addressed both issues in build 13:
>
> **Guideline 3.1.1**: Promo-code redemption has been removed from the iOS app entirely, and our server now rejects redemption requests from iOS clients. Any future promotions on iOS will use App Store Offer Codes.
>
> **Guideline 1.2**:
> - Users must agree to our Terms of Use (EULA) before registering or logging in. The terms state that there is zero tolerance for objectionable content or abusive users.
> - Chat, announcements, mail and friend-request messages are filtered for objectionable content.
> - Users can report any message or player from every chat channel, mail and profile, choosing a reason category.
> - Users can block abusive users. Blocking immediately removes that user's content from the blocker's feed and notifies our moderation team.
> - Every report and block alerts our team in real time. We act within 24 hours by removing the content and ejecting the offending user.
>
> A screen recording on a physical device, showing the EULA before login, flagging content and blocking a user, is here: [link]
>
> Best regards

## 中文对照（仅供核对，不发送）

> 您好，感谢审核。两个问题已在 build 13 中解决：
>
> **3.1.1**：iOS 应用中的兑换码功能已完全移除，服务端也会拒绝来自 iOS 客户端的兑换请求。今后 iOS 上的促销将使用 App Store Offer Codes。
>
> **1.2**：
> - 用户注册或登录前必须同意我们的使用条款（EULA），条款写明对不良内容和滥用用户零容忍。
> - 聊天、公告、邮件和好友申请附言都会过滤不良内容。
> - 用户可以在所有聊天频道、邮件和个人资料中举报任意消息或玩家，并选择举报类别。
> - 用户可以屏蔽滥用者；屏蔽后对方内容立即从屏蔽者的信息流中移除，并通知我们的审核团队。
> - 每次举报和屏蔽都会实时通知团队，我们会在 24 小时内处理：删除内容并驱逐违规用户。
>
> 真机录屏（展示登录前的 EULA、举报内容、屏蔽用户）：[link]

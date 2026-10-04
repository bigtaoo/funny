# App Review 回复草稿：build 12 拒审（3.1.1 + 1.2）

> 状态：**已发送并重新提交，2026-10-04 Waiting for Review**（2026-09-29 起草，2026-10-04 改为 build 19：兑换码已全平台移除、录屏已上线）。Submission ID `ed186ff4-7b13-4c46-b5ca-5063de561f1f`。
> 背景与实现见 `IOS_RELEASE.md §9.2 / §9.3`、`CONTENT_MODERATION_DESIGN.md §9.6`。

## 发送前检查

- [x] 服务端已部署，VPS 上 socialsvc 已配 `NW_ALERT_WEBHOOK_URL`，发一条测试举报确认告警能到群里（2026-09-30，Discord）
- [x] build 19 已上传，ASC 版本已换成 build 19（2026-10-04）
- [x] 真机录屏已完成，随官网部署公开发布：https://nivara.gamestao.com/review/app-review-build19.mp4（源文件 `client/public/web/review/`；以后新录屏换新文件名，不覆盖旧链接）
- [x] 录屏链接同时写进 ASC「App Review Information → Notes」（2026-10-04，整段新 Notes 见 `store-assets-checklist §1.2b`；以后每次提审都保留）
- [x] 回复已发，版本已 Resubmit，状态 Waiting for Review（2026-10-04）
- [ ] 未确认：ASC 英文 Description 末尾的 EULA 链接仍是 Apple 标准 EULA，而回复/Notes 说的是我们自己的零容忍条款；若再因 1.2 被问，改成 `https://nivara.gamestao.com/terms`（前提是该页覆盖订阅条款）
- [x] 下面英文稿里的录屏链接已填好

## 录屏脚本（真机）

1. 删掉 App 重装 → 首次启动出现 EULA 同意页，停留到能看清「Terms of Use (EULA)」和零容忍字样 → 同意
2. 登录页：展示表单下方「登录即同意 Terms of Use」那一行，点开链接看到 §7 零容忍条款 → 返回，用 demo 账号登录
3. 进私聊或世界聊天 → 点一条别人的消息 → Report → 选分类 → 提交，看到提示
4. 同一玩家 → Block → 确认 → 该玩家的消息立即从聊天里消失
5. 设置 → Help → Blocked players：看到刚屏蔽的人，可解除

## 英文回复（发给 Apple）

> Hello,
>
> Thank you for the review. We have addressed both issues in build 19:
>
> **Guideline 3.1.1**: Promo-code redemption has been removed from the app on every platform, and the redemption endpoint no longer exists on our server. Any future promotions on iOS will use App Store Offer Codes.
>
> **Guideline 1.2**:
> - Users must agree to our Terms of Use (EULA) before registering or logging in. The terms state that there is zero tolerance for objectionable content or abusive users.
> - Chat, announcements, mail and friend-request messages are filtered for objectionable content.
> - Users can report any message or player from every chat channel, mail and profile, choosing a reason category.
> - Users can block abusive users. Blocking immediately removes that user's content from the blocker's feed and notifies our moderation team.
> - Every report and block alerts our team in real time. We act within 24 hours by removing the content and ejecting the offending user.
>
> A screen recording on a physical device, showing the EULA before login, flagging content and blocking a user, is here: https://nivara.gamestao.com/review/app-review-build19.mp4
>
> Best regards

## 中文对照（仅供核对，不发送）

> 您好，感谢审核。两个问题已在 build 19 中解决：
>
> **3.1.1**：兑换码功能已在所有平台移除，服务端的兑换接口也已删除。今后 iOS 上的促销将使用 App Store Offer Codes。
>
> **1.2**：
> - 用户注册或登录前必须同意我们的使用条款（EULA），条款写明对不良内容和滥用用户零容忍。
> - 聊天、公告、邮件和好友申请附言都会过滤不良内容。
> - 用户可以在所有聊天频道、邮件和个人资料中举报任意消息或玩家，并选择举报类别。
> - 用户可以屏蔽滥用者；屏蔽后对方内容立即从屏蔽者的信息流中移除，并通知我们的审核团队。
> - 每次举报和屏蔽都会实时通知团队，我们会在 24 小时内处理：删除内容并驱逐违规用户。
>
> 真机录屏（展示登录前的 EULA、举报内容、屏蔽用户）：https://nivara.gamestao.com/review/app-review-build19.mp4

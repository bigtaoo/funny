// 社交系统常量 + 视图类型单一来源（SOCIAL_DESIGN.md，S6-0）。
// 纯数据，无 DB / 无 PIXI。meta 用它做好友/私聊/邮件的服务端校验；客户端 REST DTO
// 由 openapi-typescript 从 openapi.yml 生成（与此处保持语义一致）。
// 集合文档形状（FriendEdgeDoc/ConversationDoc/MailDoc…）在 mongo.ts，同既有 SaveDoc 约定。

// ── 上限 / 配额 ──────────────────────────────────────
/** 好友数上限（达上限申请/同意拒绝，SOC6）。 */
export const FRIEND_CAP = 100;
/** 好友申请附言最大长度。 */
export const FRIEND_REQUEST_MESSAGE_MAX = 200;

/** 私聊消息保留时长（秒）；ChatMessageDoc 的 TTL 索引用（SOC4）。 */
export const CHAT_RETENTION_SEC = 30 * 24 * 3600;
/** 单条私聊正文最大长度。 */
export const CHAT_BODY_MAX = 500;
/** 私聊发送限流：每账号每分钟最多发条数（RATE_LIMITED，SOC2）。 */
export const CHAT_SEND_RATE_PER_MIN = 30;
/** 拉历史单页最大条数。 */
export const CHAT_HISTORY_PAGE_MAX = 50;

/** 邮件默认有效期（秒）；MailDoc.expireAt 缺省 = now + 此值，TTL 自动回收（SOC5）。 */
export const MAIL_DEFAULT_TTL_SEC = 30 * 24 * 3600;
export const MAIL_SUBJECT_MAX = 80;
export const MAIL_BODY_MAX = 2000;

// ── 确定性 id 推导（无需查表，双端任一可算）──────────────
/**
 * 私聊会话 id：两个 accountId 排序后拼接（SOC4）。双方任一端可推出同一 convId，
 * 无需先查表建会话。
 */
export function conversationId(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** 有向好友边 id（owner 视角；双向好友 = 两条边，SOC6）。 */
export function friendEdgeId(owner: string, friend: string): string {
  return `${owner}:${friend}`;
}

/** 有向拉黑边 id。 */
export function blockId(owner: string, target: string): string {
  return `${owner}:${target}`;
}

// ── 视图类型（REST 响应；openapi schema 与此同义）────────────
/** 公开资料（按 publicId 搜索 / 资料卡）。绝不含 accountId。 */
export interface ProfileView {
  publicId: string;
  displayName: string;
  rank?: string;
}

export interface FriendView {
  publicId: string;
  displayName: string;
  online: boolean;
  rank?: string;
  /** owner 私有备注名。 */
  alias?: string;
}

export interface FriendRequestView {
  requestId: string;
  fromPublicId: string;
  fromName: string;
  toPublicId: string;
  message?: string;
  createdAt: number;
}

export interface ConversationView {
  convId: string;
  /** 对端公开资料。 */
  peer: ProfileView;
  lastBody?: string;
  lastFrom?: string;
  lastTs: number;
  unread: number;
}

export interface ChatMessageView {
  messageId: string;
  convId: string;
  fromPublicId: string;
  body: string;
  kind: 'text' | 'system';
  ts: number;
}

// 'material' = 养成材料（scrap/lead/binding），发到 SaveData.materials 统一池（PvE/装备/拍卖共用，
// SLG8 材料统一流转）；'item' 进 inventory.items 泛用桶。两者刻意分桶，材料不混入泛用物品。
export type MailAttachmentKind = 'coins' | 'item' | 'skin' | 'material';
export interface MailAttachmentView {
  kind: MailAttachmentKind;
  id?: string;
  count?: number;
}

export interface MailView {
  mailId: string;
  from: 'system' | string; // 'system' 或发件人 publicId
  fromName?: string;
  subject: string;
  body: string;
  attachments?: MailAttachmentView[];
  createdAt: number;
  expireAt: number;
  read: boolean;
  claimed: boolean;
}

/**
 * 离线红点聚合（SOCIAL_DESIGN §6 UI「顶部/底栏未读总红点」，SOC8）。登录后拉一次，
 * 之后由 social push（friend_request / chat_message / mail_new）在客户端做增量更新。
 * 各项为「点数」语义而非消息总数：`friendRequests`=待处理收到的申请数、`chat`=有未读的会话数、
 * `mail`=未读且未过期的邮件数；`total` 为三者之和，供单一总红点显示。
 * 走轻量聚合查询（countDocuments），不拉好友/会话/邮件全量列表。
 */
export interface SocialBadges {
  friendRequests: number;
  chat: number;
  mail: number;
  total: number;
}

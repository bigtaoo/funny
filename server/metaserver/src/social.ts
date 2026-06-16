// 社交服务（S6-1 好友 / 后续 S6-2 私聊 / S6-3 邮件）。
// meta = 数据唯一权威（SOC1）：好友边 / 申请 / 拉黑都经此处的鉴权写操作。
// 实时投递（friend_request / friend_update / friend_presence）由 MetaService 调 GatewayClient.push
// 走 gateway /gw/push 定向下发，离线丢弃（数据已落库，下次登录拉）。
import { randomUUID } from 'node:crypto';
import type {
  Collections,
  FriendView,
  FriendRequestView,
  ProfileView,
  ConversationView,
  ChatMessageView,
} from '@nw/shared';
import {
  FRIEND_CAP,
  friendEdgeId,
  blockId,
  eloToRank,
  INITIAL_ELO,
  conversationId,
  CHAT_BODY_MAX,
  CHAT_HISTORY_PAGE_MAX,
  censorChat,
  type ChatRegion,
} from '@nw/shared';

/** 业务错误码（与 ErrorCode 子集对齐，service 层据此映射 HTTP 状态）。 */
export type SocialError =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'ALREADY_FRIEND'
  | 'FRIEND_CAP_REACHED'
  | 'NOT_FRIEND'
  | 'BLOCKED';

/** accountId → 公开资料（publicId / displayName）。无 publicId（未生成）视为不可见。 */
export async function profileOf(cols: Collections, accountId: string): Promise<ProfileView | null> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  if (!doc?.publicId) return null;
  const save = await cols.saves.findOne({ _id: accountId }, { projection: { 'save.pvp.elo': 1 } });
  const elo = save?.save.pvp.elo ?? INITIAL_ELO;
  return {
    publicId: doc.publicId,
    displayName: doc.displayName ?? `玩家${doc.publicId.slice(-4)}`,
    rank: eloToRank(elo),
  };
}

/** 反查：publicId → accountId（+ 资料）。不存在 → null。 */
export async function resolveByPublicId(
  cols: Collections,
  publicId: string,
): Promise<{ accountId: string; profile: ProfileView } | null> {
  const doc = await cols.accounts.findOne({ publicId });
  if (!doc?.publicId) return null;
  const profile = await profileOf(cols, doc._id);
  if (!profile) return null;
  return { accountId: doc._id, profile };
}

/** 我的好友 accountId 列表（内部端点 / presence 广播范围用）。 */
export async function friendAccountIds(cols: Collections, me: string): Promise<string[]> {
  const edges = await cols.friendEdges.find({ owner: me }).toArray();
  return edges.map((e) => e.friend);
}

/** 是否有向拉黑（owner 拉黑了 target）。 */
async function hasBlock(cols: Collections, owner: string, target: string): Promise<boolean> {
  return !!(await cols.blocks.findOne({ _id: blockId(owner, target) }));
}

/** 是否已是好友（owner→friend 边存在）。 */
async function isFriend(cols: Collections, owner: string, friend: string): Promise<boolean> {
  return !!(await cols.friendEdges.findOne({ _id: friendEdgeId(owner, friend) }));
}

/**
 * 好友列表（含在线态）。online 由调用方注入（meta 向 gateway 查 presence），此处先全 false，
 * service 层补在线 flag。
 */
export async function getFriends(cols: Collections, me: string): Promise<FriendView[]> {
  const edges = await cols.friendEdges.find({ owner: me }).sort({ since: -1 }).toArray();
  const out: FriendView[] = [];
  for (const e of edges) {
    const p = await profileOf(cols, e.friend);
    if (!p) continue; // 对方账号异常（无 publicId）跳过
    out.push({
      publicId: p.publicId,
      displayName: p.displayName,
      online: false,
      ...(p.rank ? { rank: p.rank } : {}),
      ...(e.alias ? { alias: e.alias } : {}),
    });
  }
  return out;
}

/** 待处理申请（收到 + 发出）。 */
export async function listRequests(
  cols: Collections,
  me: string,
): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
  const [incomingDocs, outgoingDocs] = await Promise.all([
    cols.friendRequests.find({ to: me, status: 'pending' }).sort({ createdAt: -1 }).toArray(),
    cols.friendRequests.find({ from: me, status: 'pending' }).sort({ createdAt: -1 }).toArray(),
  ]);
  const toView = async (d: {
    _id: string;
    from: string;
    to: string;
    message?: string;
    createdAt: number;
  }): Promise<FriendRequestView | null> => {
    const [fromP, toP] = await Promise.all([profileOf(cols, d.from), profileOf(cols, d.to)]);
    if (!fromP || !toP) return null;
    return {
      requestId: d._id,
      fromPublicId: fromP.publicId,
      fromName: fromP.displayName,
      toPublicId: toP.publicId,
      ...(d.message ? { message: d.message } : {}),
      createdAt: d.createdAt,
    };
  };
  const incoming = (await Promise.all(incomingDocs.map(toView))).filter(
    (v): v is FriendRequestView => v !== null,
  );
  const outgoing = (await Promise.all(outgoingDocs.map(toView))).filter(
    (v): v is FriendRequestView => v !== null,
  );
  return { incoming, outgoing };
}

export type RequestResult =
  | { kind: 'ok'; requestId: string; to: string; fromProfile: ProfileView; message?: string }
  | { kind: 'error'; error: SocialError };

/**
 * 发好友申请（凭 publicId）。校验：目标存在 / 非自己 / 未互相拉黑 / 未已是好友 / 未超上限。
 * 已有同向 pending 申请 → 幂等返回该 requestId（不重复发推送）。
 */
export async function requestFriend(
  cols: Collections,
  me: string,
  publicId: string,
  message: string | undefined,
  now: number,
): Promise<RequestResult> {
  const target = await resolveByPublicId(cols, publicId);
  if (!target) return { kind: 'error', error: 'NOT_FOUND' };
  const to = target.accountId;
  if (to === me) return { kind: 'error', error: 'BAD_REQUEST' };
  if (await isFriend(cols, me, to)) return { kind: 'error', error: 'ALREADY_FRIEND' };
  // 任一方向拉黑 → 不可申请。
  if ((await hasBlock(cols, to, me)) || (await hasBlock(cols, me, to))) {
    return { kind: 'error', error: 'BLOCKED' };
  }
  const myFriendCount = await cols.friendEdges.countDocuments({ owner: me });
  if (myFriendCount >= FRIEND_CAP) return { kind: 'error', error: 'FRIEND_CAP_REACHED' };

  const fromProfile = await profileOf(cols, me);
  if (!fromProfile) return { kind: 'error', error: 'BAD_REQUEST' };

  // 同向已有 pending → 幂等。
  const existing = await cols.friendRequests.findOne({ from: me, to, status: 'pending' });
  if (existing) {
    return { kind: 'ok', requestId: existing._id, to, fromProfile, message: existing.message };
  }
  const requestId = randomUUID();
  await cols.friendRequests.insertOne({
    _id: requestId,
    from: me,
    to,
    status: 'pending',
    ...(message ? { message } : {}),
    createdAt: now,
  });
  return { kind: 'ok', requestId, to, fromProfile, message };
}

export type RespondResult =
  | { kind: 'ok'; accepted: boolean; otherAccountId: string; meProfile: ProfileView; otherProfile: ProfileView }
  | { kind: 'error'; error: SocialError };

/**
 * 同意 / 拒绝好友申请。accept → 建双向边（两条有向边）+ 标 accepted。
 * 仅申请的收件人（to=me）可响应；非 pending / 不存在 → NOT_FOUND。
 */
export async function respondFriend(
  cols: Collections,
  me: string,
  requestId: string,
  accept: boolean,
  now: number,
): Promise<RespondResult> {
  const reqDoc = await cols.friendRequests.findOne({ _id: requestId });
  if (!reqDoc || reqDoc.to !== me || reqDoc.status !== 'pending') {
    return { kind: 'error', error: 'NOT_FOUND' };
  }
  const other = reqDoc.from;
  // 原子置 accepted/rejected（防并发重复响应）。
  const claimed = await cols.friendRequests.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    { $set: { status: accept ? 'accepted' : 'rejected', resolvedAt: now } },
  );
  if (!claimed) return { kind: 'error', error: 'NOT_FOUND' };

  const [meProfile, otherProfile] = await Promise.all([profileOf(cols, me), profileOf(cols, other)]);
  if (!meProfile || !otherProfile) return { kind: 'error', error: 'BAD_REQUEST' };

  if (accept) {
    // 上限兜底：双方任一超上限则不建边（申请已 accepted，但实际未加——返回 cap 错误）。
    const [cntMe, cntOther] = await Promise.all([
      cols.friendEdges.countDocuments({ owner: me }),
      cols.friendEdges.countDocuments({ owner: other }),
    ]);
    if (cntMe >= FRIEND_CAP || cntOther >= FRIEND_CAP) {
      return { kind: 'error', error: 'FRIEND_CAP_REACHED' };
    }
    await Promise.all([
      cols.friendEdges.updateOne(
        { _id: friendEdgeId(me, other) },
        { $setOnInsert: { _id: friendEdgeId(me, other), owner: me, friend: other, since: now } },
        { upsert: true },
      ),
      cols.friendEdges.updateOne(
        { _id: friendEdgeId(other, me) },
        { $setOnInsert: { _id: friendEdgeId(other, me), owner: other, friend: me, since: now } },
        { upsert: true },
      ),
    ]);
  }
  return { kind: 'ok', accepted: accept, otherAccountId: other, meProfile, otherProfile };
}

/** 删好友（双向）。返回被删方 accountId（在线则 push friend_update REMOVED）。 */
export async function removeFriend(
  cols: Collections,
  me: string,
  publicId: string,
): Promise<{ otherAccountId: string } | null> {
  const target = await resolveByPublicId(cols, publicId);
  if (!target) return null;
  const other = target.accountId;
  await Promise.all([
    cols.friendEdges.deleteOne({ _id: friendEdgeId(me, other) }),
    cols.friendEdges.deleteOne({ _id: friendEdgeId(other, me) }),
  ]);
  return { otherAccountId: other };
}

/** 拉黑（删双向好友 + 撤销双方 pending 申请 + 记有向拉黑边）。 */
export async function blockUser(
  cols: Collections,
  me: string,
  publicId: string,
  now: number,
): Promise<{ otherAccountId: string } | null> {
  const target = await resolveByPublicId(cols, publicId);
  if (!target) return null;
  const other = target.accountId;
  if (other === me) return null;
  await Promise.all([
    cols.friendEdges.deleteOne({ _id: friendEdgeId(me, other) }),
    cols.friendEdges.deleteOne({ _id: friendEdgeId(other, me) }),
    cols.friendRequests.updateMany(
      {
        $or: [
          { from: me, to: other, status: 'pending' },
          { from: other, to: me, status: 'pending' },
        ],
      },
      { $set: { status: 'cancelled', resolvedAt: now } },
    ),
    cols.blocks.updateOne(
      { _id: blockId(me, other) },
      { $setOnInsert: { _id: blockId(me, other), owner: me, target: other, ts: now } },
      { upsert: true },
    ),
  ]);
  return { otherAccountId: other };
}

/** 取消拉黑。 */
export async function unblockUser(cols: Collections, me: string, publicId: string): Promise<boolean> {
  const target = await resolveByPublicId(cols, publicId);
  if (!target) return false;
  await cols.blocks.deleteOne({ _id: blockId(me, target.accountId) });
  return true;
}

// ── 私聊（S6-2，SOC4）。会话 id 确定性派生；发送须互为好友且未互相拉黑；敏感词打码。──

export type SendChatResult =
  | {
      kind: 'ok';
      messageId: string;
      ts: number;
      convId: string;
      to: string;
      fromProfile: ProfileView;
      /** 已过敏感词打码的正文（push 用，与落库一致）。 */
      body: string;
    }
  | { kind: 'error'; error: SocialError };

/**
 * 发私聊：校验目标存在 / 非自己 / 互为好友 / 未互相拉黑 / 正文非空且不超长 → 敏感词打码 →
 * 插消息（ts 存 BSON Date 供 TTL）+ bump 会话末条摘要 + 收件方 unread+1（单文档原子）。
 * 限流（每分钟条数）由 service 层维护（meta 进程内滑窗），此处只做内容/关系校验。
 */
export async function sendMessage(
  cols: Collections,
  me: string,
  toPublicId: string,
  bodyRaw: string,
  region: ChatRegion,
  now: number,
): Promise<SendChatResult> {
  const target = await resolveByPublicId(cols, toPublicId);
  if (!target) return { kind: 'error', error: 'NOT_FOUND' };
  const to = target.accountId;
  if (to === me) return { kind: 'error', error: 'BAD_REQUEST' };
  const trimmed = (bodyRaw ?? '').trim();
  if (!trimmed || trimmed.length > CHAT_BODY_MAX) return { kind: 'error', error: 'BAD_REQUEST' };
  // 拉黑优先（拉黑会删好友边，故 BLOCKED 比 NOT_FRIEND 更准确地说明原因）。
  if ((await hasBlock(cols, to, me)) || (await hasBlock(cols, me, to))) {
    return { kind: 'error', error: 'BLOCKED' };
  }
  if (!(await isFriend(cols, me, to))) return { kind: 'error', error: 'NOT_FRIEND' };
  const fromProfile = await profileOf(cols, me);
  if (!fromProfile) return { kind: 'error', error: 'BAD_REQUEST' };

  const body = censorChat(trimmed, region).text;
  const convId = conversationId(me, to);
  const messageId = randomUUID();
  await cols.chatMessages.insertOne({
    _id: messageId,
    convId,
    from: me,
    body,
    kind: 'text',
    ts: new Date(now),
  });
  // 会话 upsert：写末条摘要 + 收件方未读 +1（自己未读保持/归零由 read 端点管）。
  await cols.conversations.updateOne(
    { _id: convId },
    {
      $setOnInsert: { _id: convId, members: [me < to ? me : to, me < to ? to : me] as [string, string] },
      $set: { lastBody: body, lastFrom: me, lastTs: now },
      $inc: { [`unread.${to}`]: 1 },
    },
    { upsert: true },
  );
  return { kind: 'ok', messageId, ts: now, convId, to, fromProfile, body };
}

/** 会话列表（含对端资料 + 自己未读数）。按末条时间倒序。`lastFrom`=末条发送者 publicId（UI 判向）。 */
export async function getConversations(cols: Collections, me: string): Promise<ConversationView[]> {
  const docs = await cols.conversations.find({ members: me }).sort({ lastTs: -1 }).toArray();
  const myProfile = await profileOf(cols, me);
  const myPid = myProfile?.publicId ?? '';
  const out: ConversationView[] = [];
  for (const d of docs) {
    const peerId = d.members[0] === me ? d.members[1] : d.members[0];
    const peer = await profileOf(cols, peerId);
    if (!peer) continue; // 对端账号异常跳过
    out.push({
      convId: d._id,
      peer,
      ...(d.lastBody ? { lastBody: d.lastBody } : {}),
      ...(d.lastFrom ? { lastFrom: d.lastFrom === me ? myPid : peer.publicId } : {}),
      lastTs: d.lastTs,
      unread: d.unread?.[me] ?? 0,
    });
  }
  return out;
}

/**
 * 拉会话历史（按时间倒序分页）。仅会话成员可拉（防越权）。`before`=epoch ms 游标（取更早的）。
 * 返回的 `fromPublicId` 由两成员资料映射；非成员 / 会话不存在 → null。
 */
export async function getMessages(
  cols: Collections,
  me: string,
  convId: string,
  before: number | undefined,
  limit: number,
): Promise<ChatMessageView[] | null> {
  const conv = await cols.conversations.findOne({ _id: convId });
  if (!conv || !conv.members.includes(me)) return null;
  const lim = Math.min(CHAT_HISTORY_PAGE_MAX, Math.max(1, Math.floor(limit) || 30));
  const q: Record<string, unknown> = { convId };
  if (before !== undefined && Number.isFinite(before)) q.ts = { $lt: new Date(before) };
  const docs = await cols.chatMessages.find(q).sort({ ts: -1 }).limit(lim).toArray();
  // accountId → publicId（仅两成员）。
  const pid = new Map<string, string>();
  for (const mId of conv.members) {
    const p = await profileOf(cols, mId);
    if (p) pid.set(mId, p.publicId);
  }
  return docs.map((d) => ({
    messageId: d._id,
    convId: d.convId,
    fromPublicId: pid.get(d.from) ?? '',
    body: d.body,
    kind: d.kind,
    ts: d.ts instanceof Date ? d.ts.getTime() : Number(d.ts),
  }));
}

/** 标记会话已读（清自己的未读计数）。非成员 no-op。 */
export async function markConversationRead(cols: Collections, me: string, convId: string): Promise<void> {
  await cols.conversations.updateOne(
    { _id: convId, members: me },
    { $set: { [`unread.${me}`]: 0 } },
  );
}

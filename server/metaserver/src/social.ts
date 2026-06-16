// 社交服务（S6-1 好友 / 后续 S6-2 私聊 / S6-3 邮件）。
// meta = 数据唯一权威（SOC1）：好友边 / 申请 / 拉黑都经此处的鉴权写操作。
// 实时投递（friend_request / friend_update / friend_presence）由 MetaService 调 GatewayClient.push
// 走 gateway /gw/push 定向下发，离线丢弃（数据已落库，下次登录拉）。
import { randomUUID } from 'node:crypto';
import type { Collections, FriendView, FriendRequestView, ProfileView } from '@nw/shared';
import { FRIEND_CAP, friendEdgeId, blockId, eloToRank, INITIAL_ELO } from '@nw/shared';

/** 业务错误码（与 ErrorCode 子集对齐，service 层据此映射 HTTP 状态）。 */
export type SocialError =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'ALREADY_FRIEND'
  | 'FRIEND_CAP_REACHED'
  | 'BLOCKED';

/** accountId → 公开资料（publicId / displayName）。无 publicId（未生成）视为不可见。 */
async function profileOf(cols: Collections, accountId: string): Promise<ProfileView | null> {
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

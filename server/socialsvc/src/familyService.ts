// 家族业务层（SOCIAL_SVC_DESIGN §3/§4，SS2/SS3）。
// 家族是全局持久实体（无 worldId），TAG 全库唯一。
// 玩家同时只能属于一个家族（FamilyMemberDoc._id = accountId）。
// 成员上限 FAMILY_CAP=30；三层权限：leader > elder > member。
import {
  FAMILY_CAP,
  FAMILY_MSG_BODY_MAX,
  SlgError,
  type FamilyRole,
} from '@nw/shared';
import type { SocialCollections, FamilyDoc, FamilyMemberDoc, FamilyMessageDoc } from './db';
import type { SocialGatewayClient } from './gatewayClient';
import { nullSocialGatewayClient } from './gatewayClient';

export interface FamilyView {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  prosperity: number;
  announcement?: string;
}

export interface FamilyDetailView extends FamilyView {
  members: FamilyMemberView[];
}

export interface FamilyMemberView {
  accountId: string;
  role: FamilyRole;
  joinedAt: number;
}

export interface FamilyMessageView {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number;
}

export interface FamilyServiceDeps {
  cols: SocialCollections;
  now: () => number;
  gateway?: SocialGatewayClient;
}

/** 进程内单调序号，防同毫秒多条消息 id 撞键。 */
let msgSeq = 0;

function makeFamilyId(tag: string): string {
  return `fam:${tag.toUpperCase()}`;
}

function docToView(doc: FamilyDoc): FamilyView {
  return {
    familyId: doc._id,
    name: doc.name,
    tag: doc.tag,
    leaderId: doc.leaderId,
    memberCount: doc.memberCount,
    prosperity: doc.prosperity,
    ...(doc.announcement ? { announcement: doc.announcement } : {}),
  };
}

export class FamilyService {
  private readonly gateway: SocialGatewayClient;

  constructor(private readonly deps: FamilyServiceDeps) {
    this.gateway = deps.gateway ?? nullSocialGatewayClient;
  }

  /** 查玩家所在家族（含成员列表）。未加入则返回 null。 */
  async getMyFamily(accountId: string): Promise<FamilyDetailView | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    if (!mem) return null;
    return this.getFamily(mem.familyId);
  }

  /** 按 familyId 查详情（含成员列表）。 */
  async getFamily(familyId: string): Promise<FamilyDetailView | null> {
    const doc = await this.deps.cols.families.findOne({ _id: familyId });
    if (!doc) return null;
    const memberDocs = await this.deps.cols.familyMembers.find({ familyId }).toArray();
    const members: FamilyMemberView[] = memberDocs.map((m) => ({
      accountId: m.accountId,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
    return { ...docToView(doc), members };
  }

  /** 按 TAG 搜索家族（精确，大小写不敏感）。 */
  async searchByTag(tag: string): Promise<FamilyView | null> {
    const doc = await this.deps.cols.families.findOne({ tag: tag.toUpperCase() });
    return doc ? docToView(doc) : null;
  }

  /** 创建家族。TAG 全库唯一；创建者成为 leader；不能已在其他家族。 */
  async createFamily(
    leaderId: string,
    name: string,
    tag: string,
  ): Promise<FamilyDetailView> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    const existing = await cols.familyMembers.findOne({ _id: leaderId });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    const tagUpper = tag.toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tagUpper)) throw new SlgError('BAD_REQUEST');
    if (!name || name.length < 2 || name.length > 20) throw new SlgError('BAD_REQUEST');

    const fid = makeFamilyId(tagUpper);

    const familyDoc: FamilyDoc = {
      _id: fid,
      name,
      tag: tagUpper,
      leaderId,
      memberCount: 1,
      prosperity: 0,
      prosperityUpdatedAt: now,
      activity: 0,
      createdAt: now,
      rev: 1,
    };
    try {
      await cols.families.insertOne(familyDoc);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new SlgError('ALREADY_IN_FAMILY');
      throw e;
    }

    const memberDoc: FamilyMemberDoc = {
      _id: leaderId,
      familyId: fid,
      accountId: leaderId,
      role: 'leader',
      joinedAt: now,
    };
    await cols.familyMembers.insertOne(memberDoc);

    return {
      ...docToView(familyDoc),
      members: [{ accountId: leaderId, role: 'leader', joinedAt: now }],
    };
  }

  /** 加入家族（直接加入，上限 30 人；不能已在家族）。 */
  async joinFamily(accountId: string, familyId: string): Promise<void> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    const existing = await cols.familyMembers.findOne({ _id: accountId });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    const res = await cols.families.findOneAndUpdate(
      { _id: familyId, memberCount: { $lt: FAMILY_CAP } },
      { $inc: { memberCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!res) {
      const fam = await cols.families.findOne({ _id: familyId });
      if (!fam) throw new SlgError('NOT_FOUND');
      throw new SlgError('FAMILY_FULL');
    }

    const memberDoc: FamilyMemberDoc = {
      _id: accountId,
      familyId,
      accountId,
      role: 'member',
      joinedAt: now,
    };
    await cols.familyMembers.insertOne(memberDoc);
  }

  /** 离开家族（leader 须先转让或 dissolve）。 */
  async leaveFamily(accountId: string): Promise<void> {
    const cols = this.deps.cols;
    const memDoc = await cols.familyMembers.findOne({ _id: accountId });
    if (!memDoc) throw new SlgError('NOT_IN_FAMILY');
    if (memDoc.role === 'leader') throw new SlgError('BAD_REQUEST');

    await cols.familyMembers.deleteOne({ _id: accountId });
    await cols.families.updateOne({ _id: memDoc.familyId }, { $inc: { memberCount: -1 } });
  }

  /** 踢出成员（leader 可踢全部，elder 只能踢 member）。 */
  async kickMember(requesterId: string, targetId: string): Promise<void> {
    if (requesterId === targetId) throw new SlgError('BAD_REQUEST');
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem) throw new SlgError('NOT_IN_FAMILY');

    const targetMem = await cols.familyMembers.findOne({ _id: targetId });
    if (!targetMem || targetMem.familyId !== requesterMem.familyId) throw new SlgError('NOT_FOUND');
    if (targetMem.role === 'leader') throw new SlgError('NO_PERMISSION');
    if (requesterMem.role === 'elder' && targetMem.role === 'elder') throw new SlgError('NO_PERMISSION');
    if (requesterMem.role === 'member') throw new SlgError('NO_PERMISSION');

    await cols.familyMembers.deleteOne({ _id: targetId });
    await cols.families.updateOne({ _id: requesterMem.familyId }, { $inc: { memberCount: -1 } });
  }

  /** 设置成员角色（仅 leader 可操作）。 */
  async setRole(requesterId: string, targetId: string, role: FamilyRole): Promise<void> {
    if (requesterId === targetId) throw new SlgError('BAD_REQUEST');
    if (role === 'leader') throw new SlgError('BAD_REQUEST');
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem || requesterMem.role !== 'leader') throw new SlgError('NO_PERMISSION');

    const targetMem = await cols.familyMembers.findOne({ _id: targetId });
    if (!targetMem || targetMem.familyId !== requesterMem.familyId) throw new SlgError('NOT_FOUND');

    await cols.familyMembers.updateOne({ _id: targetId }, { $set: { role } });
  }

  /** 解散家族（仅 leader）。清除所有成员记录、消息、家族文档。 */
  async dissolveFamily(requesterId: string): Promise<void> {
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: requesterId });
    if (!requesterMem || requesterMem.role !== 'leader') throw new SlgError('NO_PERMISSION');

    const fid = requesterMem.familyId;
    await cols.familyMembers.deleteMany({ familyId: fid });
    await cols.familyMessages.deleteMany({ familyId: fid });
    await cols.families.deleteOne({ _id: fid });
  }

  /** 更新公告（leader / elder）。 */
  async setAnnouncement(requesterId: string, announcement: string): Promise<void> {
    if (announcement.length > 200) throw new SlgError('BAD_REQUEST');
    const mem = await this.deps.cols.familyMembers.findOne({ _id: requesterId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (mem.role === 'member') throw new SlgError('NO_PERMISSION');
    await this.deps.cols.families.updateOne({ _id: mem.familyId }, { $set: { announcement } });
  }

  /** 发送家族频道消息。实时推送给所有其他在线成员。 */
  async sendMessage(
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<FamilyMessageView> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: accountId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const ts = this.deps.now();
    const seq = ++msgSeq;
    const msgId = `fm:${mem.familyId}:${ts}:${seq}`;

    const msgDoc: FamilyMessageDoc = {
      _id: msgId,
      familyId: mem.familyId,
      senderId: accountId,
      senderName,
      body,
      ts: new Date(ts),
    };
    await cols.familyMessages.insertOne(msgDoc);

    // 推送给所有其他成员（O(n)，≤30 人）
    const otherMembers = await cols.familyMembers
      .find({ familyId: mem.familyId, _id: { $ne: accountId } })
      .toArray();
    await this.gateway.pushMany(
      otherMembers.map((m) => m.accountId),
      { kind: 'family_msg', familyId: mem.familyId, fromAccountId: accountId, fromName: senderName, body, ts },
    );

    return { id: msgId, senderId: accountId, senderName, body, ts };
  }

  /** 获取频道历史（按时间倒序分页，`before` 为 ms epoch 游标，limit ≤50）。 */
  async getChannel(
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<FamilyMessageView[]> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: accountId });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { familyId: mem.familyId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.familyMessages
      .find(query)
      .sort({ ts: -1 })
      .limit(realLimit)
      .toArray();

    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      body: d.body,
      ts: d.ts instanceof Date ? d.ts.getTime() : (d.ts as unknown as number),
    }));
  }

  /** 内部接口：查玩家当前所在的 familyId（worldsvc 调用）。 */
  async getFamilyIdByAccount(accountId: string): Promise<string | null> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: accountId });
    return mem ? mem.familyId : null;
  }

  /** 内部接口：worldsvc 调增活跃度（占领/战斗 +1）。 */
  async bumpActivity(familyId: string, delta = 1): Promise<void> {
    await this.deps.cols.families.updateOne(
      { _id: familyId },
      { $inc: { activity: delta } },
    );
  }
}

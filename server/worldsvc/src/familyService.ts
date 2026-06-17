// 家族业务层（S8-4）。
// 三层权限：leader（踢人/解散/设防守）/ elder（审批加入/公告）/ member（普通）。
// 上限 FAMILY_CAP=30；TAG 全大写唯一缩写（2–5 字符），worldId 内唯一（families._id = f:{worldId}:{TAG}）。
// 频道消息持久化（TTL 7 天），实时推送经 gateway /gw/push 定向各成员（O(n)，≤30 人可接受）。
import {
  familyId as makeFamilyId,
  familyMemberId,
  FAMILY_CAP,
  FAMILY_MSG_BODY_MAX,
  SlgError,
  type FamilyRole,
} from '@nw/shared';
import type { WorldCollections, FamilyDoc, FamilyMemberDoc, FamilyMessageDoc } from './db';
import type { WorldGatewayClient } from './gatewayClient';
import { nullWorldGatewayClient } from './gatewayClient';

export interface FamilyView {
  familyId: string;
  worldId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  territoryCount: number;
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
  ts: number; // ms epoch
}

export interface FamilyServiceDeps {
  cols: WorldCollections;
  now: () => number;
  gateway?: WorldGatewayClient;
}

/** 进程内单调序号，防同毫秒多条消息 id 撞键。 */
let msgSeq = 0;

function docToView(doc: FamilyDoc): FamilyView {
  return {
    familyId: doc._id,
    worldId: doc.worldId,
    name: doc.name,
    tag: doc.tag,
    leaderId: doc.leaderId,
    memberCount: doc.memberCount,
    territoryCount: doc.territoryCount,
  };
}

export class FamilyService {
  private readonly gateway: WorldGatewayClient;

  constructor(private readonly deps: FamilyServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
  }

  /** 列出世界内所有家族（按成员数降序，上限 50）。 */
  async listFamilies(worldId: string): Promise<FamilyView[]> {
    const docs = await this.deps.cols.families
      .find({ worldId })
      .sort({ memberCount: -1 })
      .limit(50)
      .toArray();
    return docs.map(docToView);
  }

  /** 获取家族详情（含成员列表）。 */
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

  /** 创建家族。TAG 在世界内唯一；创建者成为 leader；玩家不能已在其他家族。 */
  async createFamily(
    worldId: string,
    leaderId: string,
    name: string,
    tag: string,
  ): Promise<FamilyDetailView> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    // 校验：已在家族？
    const existing = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, leaderId) });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    // 校验：name / tag 格式
    const tagUpper = tag.toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tagUpper)) throw new SlgError('BAD_REQUEST');
    if (!name || name.length < 2 || name.length > 20) throw new SlgError('BAD_REQUEST');

    const fid = makeFamilyId(worldId, tagUpper);

    // 写家族文档（唯一 _id 防并发重复）
    const familyDoc: FamilyDoc = {
      _id: fid,
      worldId,
      name,
      tag: tagUpper,
      leaderId,
      memberCount: 1,
      territoryCount: 0,
      rev: 1,
    };
    try {
      await cols.families.insertOne(familyDoc);
    } catch (e) {
      // duplicate key → tag taken
      if ((e as { code?: number }).code === 11000) throw new SlgError('ALREADY_IN_FAMILY');
      throw e;
    }

    // 写 leader 成员记录
    const memberDoc: FamilyMemberDoc = {
      _id: familyMemberId(worldId, leaderId),
      worldId,
      accountId: leaderId,
      familyId: fid,
      role: 'leader',
      joinedAt: now,
    };
    await cols.familyMembers.insertOne(memberDoc);

    // 同步玩家世界文档的 familyId
    await cols.playerWorld.updateOne(
      { _id: familyMemberId(worldId, leaderId) },
      { $set: { familyId: fid } },
    );

    return {
      ...docToView(familyDoc),
      members: [{ accountId: leaderId, role: 'leader', joinedAt: now }],
    };
  }

  /** 加入家族（直接加入，上限 30 人；不能已在家族）。 */
  async joinFamily(worldId: string, accountId: string, familyId: string): Promise<void> {
    const cols = this.deps.cols;
    const now = this.deps.now();

    const existing = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, accountId) });
    if (existing) throw new SlgError('ALREADY_IN_FAMILY');

    // 原子 $inc memberCount + 上限守卫
    const res = await cols.families.findOneAndUpdate(
      { _id: familyId, worldId, memberCount: { $lt: FAMILY_CAP } },
      { $inc: { memberCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!res) {
      const fam = await cols.families.findOne({ _id: familyId });
      if (!fam) throw new SlgError('NOT_FOUND');
      throw new SlgError('FAMILY_FULL');
    }

    const memberDoc: FamilyMemberDoc = {
      _id: familyMemberId(worldId, accountId),
      worldId,
      accountId,
      familyId,
      role: 'member',
      joinedAt: now,
    };
    await cols.familyMembers.insertOne(memberDoc);
    await cols.playerWorld.updateOne(
      { _id: familyMemberId(worldId, accountId) },
      { $set: { familyId } },
    );
  }

  /** 离开家族（leader 须先转让或 dissolve）。 */
  async leaveFamily(worldId: string, accountId: string): Promise<void> {
    const cols = this.deps.cols;
    const memDoc = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, accountId) });
    if (!memDoc) throw new SlgError('NOT_IN_FAMILY');
    if (memDoc.role === 'leader') throw new SlgError('BAD_REQUEST'); // leader 须先转让

    await cols.familyMembers.deleteOne({ _id: familyMemberId(worldId, accountId) });
    await cols.families.updateOne({ _id: memDoc.familyId }, { $inc: { memberCount: -1 } });
    await cols.playerWorld.updateOne(
      { _id: familyMemberId(worldId, accountId) },
      { $unset: { familyId: '' } },
    );
  }

  /** 踢出成员（leader 可踢全部，elder 只能踢 member）。 */
  async kickMember(worldId: string, requesterId: string, targetId: string): Promise<void> {
    if (requesterId === targetId) throw new SlgError('BAD_REQUEST'); // 不能踢自己
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, requesterId) });
    if (!requesterMem) throw new SlgError('NOT_IN_FAMILY');

    const targetMem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, targetId) });
    if (!targetMem || targetMem.familyId !== requesterMem.familyId) {
      throw new SlgError('NOT_FOUND');
    }
    if (targetMem.role === 'leader') throw new SlgError('NO_PERMISSION');
    if (requesterMem.role === 'elder' && targetMem.role === 'elder') {
      throw new SlgError('NO_PERMISSION');
    }
    if (requesterMem.role === 'member') throw new SlgError('NO_PERMISSION');

    await cols.familyMembers.deleteOne({ _id: familyMemberId(worldId, targetId) });
    await cols.families.updateOne({ _id: requesterMem.familyId }, { $inc: { memberCount: -1 } });
    await cols.playerWorld.updateOne(
      { _id: familyMemberId(worldId, targetId) },
      { $unset: { familyId: '' } },
    );
  }

  /** 设置成员角色（仅 leader 可操作；不能改自身；不能设他人为 leader，转让用 dissolve+重建 or 后续接口）。 */
  async setRole(worldId: string, requesterId: string, targetId: string, role: FamilyRole): Promise<void> {
    if (requesterId === targetId) throw new SlgError('BAD_REQUEST'); // 不能改自身角色
    if (role === 'leader') throw new SlgError('BAD_REQUEST'); // leader 转让不走此接口
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, requesterId) });
    if (!requesterMem || requesterMem.role !== 'leader') throw new SlgError('NO_PERMISSION');

    const targetMem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, targetId) });
    if (!targetMem || targetMem.familyId !== requesterMem.familyId) {
      throw new SlgError('NOT_FOUND');
    }

    await cols.familyMembers.updateOne(
      { _id: familyMemberId(worldId, targetId) },
      { $set: { role } },
    );
  }

  /** 解散家族（仅 leader）。清除所有成员记录、家族文档；成员 playerWorld.familyId 清除。 */
  async dissolveFamily(worldId: string, requesterId: string): Promise<void> {
    const cols = this.deps.cols;

    const requesterMem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, requesterId) });
    if (!requesterMem || requesterMem.role !== 'leader') throw new SlgError('NO_PERMISSION');

    const fid = requesterMem.familyId;

    // 取所有成员 accountId，批量清 playerWorld.familyId
    const members = await cols.familyMembers.find({ familyId: fid }).toArray();
    const memberIds = members.map((m) => m._id);
    if (memberIds.length > 0) {
      await cols.playerWorld.updateMany({ _id: { $in: memberIds } }, { $unset: { familyId: '' } });
    }

    await cols.familyMembers.deleteMany({ familyId: fid });
    await cols.familyMessages.deleteMany({ familyId: fid });
    await cols.families.deleteOne({ _id: fid });
  }

  /** 发送家族频道消息。仅家族成员可发。推送给所有其他在线成员。 */
  async sendMessage(
    worldId: string,
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<FamilyMessageView> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, accountId) });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');

    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const ts = this.deps.now();
    const seq = ++msgSeq;
    const msgId = `fm:${mem.familyId}:${ts}:${seq}`;

    const msgDoc: FamilyMessageDoc = {
      _id: msgId,
      worldId,
      familyId: mem.familyId,
      senderId: accountId,
      senderName,
      body,
      ts: new Date(ts), // BSON Date for TTL index
    };
    await cols.familyMessages.insertOne(msgDoc);

    // 推送给所有其他在线成员（O(n)，≤30 人）
    const otherMembers = await cols.familyMembers
      .find({ familyId: mem.familyId, accountId: { $ne: accountId } })
      .toArray();
    await Promise.allSettled(
      otherMembers.map((m) =>
        this.gateway.push(m.accountId, {
          kind: 'family_msg',
          familyId: mem.familyId,
          fromPublicId: accountId, // 暂用 accountId，publicId 解析待后补
          fromName: senderName,
          body,
          ts,
        }),
      ),
    );

    return { id: msgId, senderId: accountId, senderName, body, ts };
  }

  /** 获取频道历史（按时间倒序分页，`before` 为 ms epoch 游标，limit ≤50）。 */
  async getChannel(
    worldId: string,
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<FamilyMessageView[]> {
    const cols = this.deps.cols;

    const mem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, accountId) });
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
}

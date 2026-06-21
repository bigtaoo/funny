// 宗门业务层（S8-4b，SLG_DESIGN §2.1/§8.2）。
// 宗门 = 大区内由「家族」组成的势力组织；成员单位是家族（不是个人），由 family.sectId 指向本门。
// 门主 = leaderFamily 的 leader 账号。绝大多数操作要求请求者是「家族族长」（familyMembers.role==='leader'），
// 代表整个家族加入/退出宗门。
//   - 建立：花 SECT_CREATE_COST 金币（走 commercial），族长创建，其家族成为门主家族。
//   - 加入/退出：族长操作；门主家族不能直接退（须解散或经投票换届）。
//   - 联盟：门主发起，双向加 allySectIds，双方各 ≤ SECT_ALLY_CAP。
//   - 换届：族长投票罢免门主 + 提名，票数/家族数 ≥ SECT_REMOVAL_VOTE_RATIO 即换届。
//   - 频道：宗门成员发/取消息（持久化 TTL 7 天）；实时推送（sect_broadcast）规模化走 Redis pub/sub，
//     本切片先 REST 轮询（gatewayClient O(n) 直推不适合 ≤900 人，见 SLG_DESIGN §9.3），故不实时推。
import {
  sectId as makeSectId,
  familyMemberId,
  SECT_FAMILY_CAP,
  SECT_CREATE_COST,
  SECT_ALLY_CAP,
  SECT_REMOVAL_VOTE_RATIO,
  FAMILY_MSG_BODY_MAX,
  SECT_FOUND_PROSPERITY_MIN,
  SlgError,
} from '@nw/shared';
import type { WorldCollections, SectDoc, FamilyDoc, SectMessageDoc } from './db';
import { refreshFamilyProsperity } from './prosperity';
import type { WorldCommercialClient } from './commercialClient';
import { nullWorldCommercialClient } from './commercialClient';
import type { WorldGatewayClient } from './gatewayClient';
import { nullWorldGatewayClient } from './gatewayClient';

export interface SectView {
  sectId: string;
  worldId: string;
  name: string;
  tag: string;
  leaderFamilyId: string;
  leaderId: string;
  memberFamilyCount: number;
  allySectIds: string[];
  prosperity: number;
}

export interface SectMemberFamilyView {
  familyId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  territoryCount: number;
}

export interface SectDetailView extends SectView {
  memberFamilies: SectMemberFamilyView[];
  removalVote?: { nomineeFamilyId: string; voteCount: number; needed: number };
}

export interface SectMessageView {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number; // ms epoch
}

export interface SectServiceDeps {
  cols: WorldCollections;
  now: () => number;
  commercial?: WorldCommercialClient;
  /** 实时频道扇出（S8-4b）；缺省 = 无 gateway，仅 REST 轮询。 */
  gateway?: WorldGatewayClient;
}

/** 进程内单调序号，防同毫秒多条消息 id 撞键。 */
let msgSeq = 0;

function docToView(doc: SectDoc): SectView {
  return {
    sectId: doc._id,
    worldId: doc.worldId,
    name: doc.name,
    tag: doc.tag,
    leaderFamilyId: doc.leaderFamilyId,
    leaderId: doc.leaderId,
    memberFamilyCount: doc.memberFamilyCount,
    allySectIds: doc.allySectIds,
    prosperity: doc.prosperity,
  };
}

export class SectService {
  private readonly commercial: WorldCommercialClient;
  private readonly gateway: WorldGatewayClient;

  constructor(private readonly deps: SectServiceDeps) {
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
  }

  /** 取请求者所在家族（要求其为该家族族长），否则抛权限/未入族错误。 */
  private async requireFamilyLeader(worldId: string, accountId: string): Promise<FamilyDoc> {
    const mem = await this.deps.cols.familyMembers.findOne({ _id: familyMemberId(worldId, accountId) });
    if (!mem) throw new SlgError('NOT_IN_FAMILY');
    if (mem.role !== 'leader') throw new SlgError('NO_PERMISSION', '仅族长可代表家族操作宗门');
    const fam = await this.deps.cols.families.findOne({ _id: mem.familyId });
    if (!fam) throw new SlgError('NOT_FOUND', '家族不存在');
    return fam;
  }

  /** 列出世界内所有宗门（按成员家族数降序，上限 50）。 */
  async listSects(worldId: string): Promise<SectView[]> {
    const docs = await this.deps.cols.sects
      .find({ worldId })
      .sort({ memberFamilyCount: -1 })
      .limit(50)
      .toArray();
    return docs.map(docToView);
  }

  /** 宗门详情（含成员家族列表）。 */
  async getSect(sectId: string): Promise<SectDetailView | null> {
    const doc = await this.deps.cols.sects.findOne({ _id: sectId });
    if (!doc) return null;
    const fams = await this.deps.cols.families.find({ sectId }).toArray();
    const memberFamilies: SectMemberFamilyView[] = fams.map((f) => ({
      familyId: f._id,
      name: f.name,
      tag: f.tag,
      leaderId: f.leaderId,
      memberCount: f.memberCount,
      territoryCount: f.territoryCount,
    }));
    const view: SectDetailView = { ...docToView(doc), memberFamilies };
    if (doc.removalVote) {
      view.removalVote = {
        nomineeFamilyId: doc.removalVote.nomineeFamilyId,
        voteCount: doc.removalVote.voterFamilyIds.length,
        needed: Math.ceil(doc.memberFamilyCount * SECT_REMOVAL_VOTE_RATIO),
      };
    }
    return view;
  }

  /** 创建宗门：请求者须为族长且家族未入门；扣 SECT_CREATE_COST 金币；TAG 世界内唯一。 */
  async createSect(worldId: string, requesterId: string, name: string, tag: string): Promise<SectDetailView> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(worldId, requesterId);
    if (fam.sectId) throw new SlgError('ALREADY_IN_SECT');

    const tagUpper = tag.toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tagUpper)) throw new SlgError('BAD_REQUEST', 'tag 须 2–5 位大写字母数字');
    if (!name || name.length < 2 || name.length > 20) throw new SlgError('BAD_REQUEST', 'name 长度 2–20');

    // 建宗门繁荣度中等门槛（G2/§17.4）：先刷新发起家族繁荣度（刚写即无需衰减），不足拒绝。
    const prosperity = await refreshFamilyProsperity(cols, worldId, fam._id, this.deps.now());
    if (prosperity < SECT_FOUND_PROSPERITY_MIN) {
      throw new SlgError('PROSPERITY_TOO_LOW', `家族繁荣度不足（需 ≥ ${SECT_FOUND_PROSPERITY_MIN}，当前 ${prosperity}）`);
    }

    const sid = makeSectId(worldId, tagUpper);

    // 先扣金币（建门成本）。失败 → 抛 INSUFFICIENT_FUNDS（commercial 映射），不写库。
    const orderId = `sect_create:${sid}:${this.deps.now()}`;
    await this.commercial.spend(requesterId, SECT_CREATE_COST, orderId);

    const doc: SectDoc = {
      _id: sid,
      worldId,
      name,
      tag: tagUpper,
      leaderFamilyId: fam._id,
      leaderId: requesterId,
      memberFamilyCount: 1,
      allySectIds: [],
      prosperity: 0,
      rev: 1,
    };
    try {
      await cols.sects.insertOne(doc);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        // TAG 撞键：退款（best-effort），抛已占用。
        await this.commercial.grant(requesterId, SECT_CREATE_COST, `${orderId}:refund`);
        throw new SlgError('ALREADY_IN_SECT', 'tag 已被占用');
      }
      throw e;
    }
    await cols.families.updateOne({ _id: fam._id }, { $set: { sectId: sid } });

    return { ...docToView(doc), memberFamilies: [{
      familyId: fam._id, name: fam.name, tag: fam.tag, leaderId: fam.leaderId,
      memberCount: fam.memberCount, territoryCount: fam.territoryCount,
    }] };
  }

  /** 家族加入宗门（族长操作，上限 SECT_FAMILY_CAP 家族；家族不能已在门）。 */
  async joinSect(worldId: string, requesterId: string, sectId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(worldId, requesterId);
    if (fam.sectId) throw new SlgError('ALREADY_IN_SECT');

    // 原子 $inc + 上限守卫。
    const res = await cols.sects.findOneAndUpdate(
      { _id: sectId, worldId, memberFamilyCount: { $lt: SECT_FAMILY_CAP } },
      { $inc: { memberFamilyCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!res) {
      const exists = await cols.sects.findOne({ _id: sectId });
      if (!exists) throw new SlgError('NOT_FOUND', '宗门不存在');
      throw new SlgError('SECT_FULL');
    }
    await cols.families.updateOne({ _id: fam._id }, { $set: { sectId } });
  }

  /** 家族退出宗门（族长操作）。门主家族不能直接退——须解散或经投票换届。 */
  async leaveSect(worldId: string, requesterId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(worldId, requesterId);
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: fam.sectId });
    if (sect && sect.leaderFamilyId === fam._id) {
      throw new SlgError('BAD_REQUEST', '门主家族须先解散或换届');
    }
    await cols.families.updateOne({ _id: fam._id }, { $unset: { sectId: '' } });
    await cols.sects.updateOne({ _id: fam.sectId }, { $inc: { memberFamilyCount: -1 } });
  }

  /** 解散宗门（仅门主）。清所有成员家族 sectId、双向解盟、删宗门 + 频道。 */
  async dissolveSect(worldId: string, requesterId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(worldId, requesterId);
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: fam.sectId });
    if (!sect) throw new SlgError('NOT_FOUND');
    if (sect.leaderId !== requesterId) throw new SlgError('NO_PERMISSION', '仅门主可解散');

    const sid = sect._id;
    await cols.families.updateMany({ sectId: sid }, { $unset: { sectId: '' } });
    // 从所有盟友的 allySectIds 移除本门。
    for (const ally of sect.allySectIds) {
      await cols.sects.updateOne({ _id: ally }, { $pull: { allySectIds: sid } });
    }
    await cols.sectMessages.deleteMany({ sectId: sid });
    await cols.sects.deleteOne({ _id: sid });
  }

  /** 结盟（门主发起，双向）。各方 ≤ SECT_ALLY_CAP；不能与自身/已盟结。 */
  async allySect(worldId: string, requesterId: string, targetSectId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(worldId, requesterId);
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const self = await cols.sects.findOne({ _id: fam.sectId });
    if (!self) throw new SlgError('NOT_FOUND');
    if (self.leaderId !== requesterId) throw new SlgError('NO_PERMISSION', '仅门主可结盟');
    if (targetSectId === self._id) throw new SlgError('BAD_REQUEST', '不能与自身结盟');

    const target = await cols.sects.findOne({ _id: targetSectId, worldId });
    if (!target) throw new SlgError('NOT_FOUND', '目标宗门不存在');
    if (self.allySectIds.includes(targetSectId)) return; // 幂等：已结盟
    if (self.allySectIds.length >= SECT_ALLY_CAP || target.allySectIds.length >= SECT_ALLY_CAP) {
      throw new SlgError('ALLY_CAP_REACHED');
    }
    await cols.sects.updateOne({ _id: self._id }, { $addToSet: { allySectIds: targetSectId } });
    await cols.sects.updateOne({ _id: target._id }, { $addToSet: { allySectIds: self._id } });
  }

  /** 解盟（门主发起，双向移除）。 */
  async unallySect(worldId: string, requesterId: string, targetSectId: string): Promise<void> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(worldId, requesterId);
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const self = await cols.sects.findOne({ _id: fam.sectId });
    if (!self) throw new SlgError('NOT_FOUND');
    if (self.leaderId !== requesterId) throw new SlgError('NO_PERMISSION', '仅门主可解盟');
    await cols.sects.updateOne({ _id: self._id }, { $pull: { allySectIds: targetSectId } });
    await cols.sects.updateOne({ _id: targetSectId }, { $pull: { allySectIds: self._id } });
  }

  /**
   * 罢免门主投票（族长发起 + 提名新门主家族）。
   * 同提名累计票（家族去重）；票数 ≥ ceil(家族数 × 2/3) → 换届到提名家族。
   * 换提名 → 票数重置为本次投票者。
   * 返回 { passed, voteCount, needed }。
   */
  async voteRemoveLeader(
    worldId: string,
    requesterId: string,
    nomineeFamilyId: string,
  ): Promise<{ passed: boolean; voteCount: number; needed: number }> {
    const { cols } = this.deps;
    const fam = await this.requireFamilyLeader(worldId, requesterId);
    if (!fam.sectId) throw new SlgError('NOT_IN_SECT');
    const sect = await cols.sects.findOne({ _id: fam.sectId });
    if (!sect) throw new SlgError('NOT_FOUND');

    const nominee = await cols.families.findOne({ _id: nomineeFamilyId, sectId: sect._id });
    if (!nominee) throw new SlgError('NOT_FOUND', '提名家族不在本门');

    // 累计 / 重置投票（按提名对象）。
    let voters: string[];
    if (sect.removalVote && sect.removalVote.nomineeFamilyId === nomineeFamilyId) {
      voters = sect.removalVote.voterFamilyIds.includes(fam._id)
        ? sect.removalVote.voterFamilyIds
        : [...sect.removalVote.voterFamilyIds, fam._id];
    } else {
      voters = [fam._id]; // 换提名 → 重置
    }

    const needed = Math.ceil(sect.memberFamilyCount * SECT_REMOVAL_VOTE_RATIO);
    if (voters.length >= needed) {
      // 换届：门主家族 + 门主账号转给提名家族。
      await cols.sects.updateOne(
        { _id: sect._id },
        {
          $set: { leaderFamilyId: nominee._id, leaderId: nominee.leaderId },
          $unset: { removalVote: '' },
          $inc: { rev: 1 },
        },
      );
      return { passed: true, voteCount: voters.length, needed };
    }
    await cols.sects.updateOne(
      { _id: sect._id },
      { $set: { removalVote: { nomineeFamilyId, voterFamilyIds: voters } } },
    );
    return { passed: false, voteCount: voters.length, needed };
  }

  /**
   * 发宗门频道消息（成员可发，持久化 + 实时推送）。落库后把消息经 Redis pub/sub 扇出给宗门内
   * 其他在线成员（≤900 人，worldsvc 只发一条到 GW_PUSH_REDIS_CHANNEL，由各 gateway 据在线成员
   * 扇出；无 Redis → gateway client 降级为 O(n) HTTP push）。离线成员靠 REST 拉历史（TTL 7 天）。
   */
  async sendMessage(
    worldId: string,
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<SectMessageView> {
    const { cols } = this.deps;
    const mem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, accountId) });
    if (!mem) throw new SlgError('NOT_IN_SECT');
    const fam = await cols.families.findOne({ _id: mem.familyId });
    if (!fam?.sectId) throw new SlgError('NOT_IN_SECT');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const sectId = fam.sectId;
    const ts = this.deps.now();
    const seq = ++msgSeq;
    const msgId = `sm:${sectId}:${ts}:${seq}`;
    const msgDoc: SectMessageDoc = {
      _id: msgId,
      worldId,
      sectId,
      senderId: accountId,
      senderName,
      body,
      ts: new Date(ts),
    };
    await cols.sectMessages.insertOne(msgDoc);

    // 实时扇出给宗门内其他在线成员（发送者自己不推——REST 回包即是其本地回显）。
    const recipients = await this.sectMemberAccountIds(sectId, accountId);
    void this.gateway.broadcast(recipients, {
      kind: 'sect_msg',
      sectId,
      fromPublicId: accountId, // 暂用 accountId，publicId 解析待后补
      fromName: senderName,
      body,
      ts,
    });

    return { id: msgId, senderId: accountId, senderName, body, ts };
  }

  /** 取宗门内全部成员 accountId（散在各成员家族里），可选排除某人（如发送者）。 */
  private async sectMemberAccountIds(sectId: string, exclude?: string): Promise<string[]> {
    const fams = await this.deps.cols.families
      .find({ sectId })
      .project<{ _id: string }>({ _id: 1 })
      .toArray();
    const famIds = fams.map((f) => f._id);
    if (famIds.length === 0) return [];
    const members = await this.deps.cols.familyMembers
      .find({ familyId: { $in: famIds } })
      .project<{ accountId: string }>({ accountId: 1 })
      .toArray();
    const ids = members.map((m) => m.accountId).filter((id) => id !== exclude);
    // 去重（同一 accountId 理论上只在一个家族，稳妥起见）。
    return [...new Set(ids)];
  }

  /** 取宗门频道历史（成员可读，按时间倒序分页）。 */
  async getChannel(
    worldId: string,
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<SectMessageView[]> {
    const { cols } = this.deps;
    const mem = await cols.familyMembers.findOne({ _id: familyMemberId(worldId, accountId) });
    if (!mem) throw new SlgError('NOT_IN_SECT');
    const fam = await cols.families.findOne({ _id: mem.familyId });
    if (!fam?.sectId) throw new SlgError('NOT_IN_SECT');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { sectId: fam.sectId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.sectMessages.find(query).sort({ ts: -1 }).limit(realLimit).toArray();
    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      body: d.body,
      ts: d.ts instanceof Date ? d.ts.getTime() : (d.ts as unknown as number),
    }));
  }
}

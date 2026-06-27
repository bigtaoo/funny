// 国家/世界公频服务（B7，§6.4 社交频道）。
// 同 world 内所有玩家均可发言，消息经 Redis pub/sub 扇给各 gateway 在线成员；
// 无 Redis 则降级为 O(n) HTTP push。离线成员靠 REST 拉历史（TTL 7 天）。
import { FAMILY_MSG_BODY_MAX, SlgError } from '@nw/shared';
import type { WorldCollections, NationMessageDoc } from './db';
import type { HttpWorldGatewayClient } from './gatewayClient';
import type { WorldCommercialClient } from './commercialClient';

const WORLD_CHAT_COST = 50;

export interface NationMessageView {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number;
}

interface Deps {
  cols: WorldCollections;
  gateway: HttpWorldGatewayClient;
  commercial: WorldCommercialClient;
  now: () => number;
}

let msgSeq = 0;

export class NationChannelService {
  constructor(private readonly deps: Deps) {}

  /**
   * 发国家/世界公频消息。玩家须已入驻该世界（playerWorld 记录存在），消息持久化后
   * 广播给世界内所有其他在线玩家。
   */
  async sendMessage(
    worldId: string,
    accountId: string,
    senderName: string,
    body: string,
  ): Promise<NationMessageView> {
    const { cols } = this.deps;

    const pw = await cols.playerWorld.findOne({ _id: `${worldId}:${accountId}` });
    if (!pw) throw new SlgError('NOT_IN_WORLD');
    if (!body || body.length > FAMILY_MSG_BODY_MAX) throw new SlgError('BAD_REQUEST');

    const ts = this.deps.now();

    if (this.deps.commercial.available) {
      const orderId = `world_chat:${worldId}:${accountId}:${ts}`;
      await this.deps.commercial.spend(accountId, WORLD_CHAT_COST, orderId);
    }
    const seq = ++msgSeq;
    const msgId = `nm:${worldId}:${ts}:${seq}`;

    const msgDoc: NationMessageDoc = {
      _id: msgId,
      worldId,
      senderId: accountId,
      senderName,
      body,
      ts: new Date(ts),
    };
    await cols.nationMessages.insertOne(msgDoc);

    // 收件人 = 同 world 内所有其他玩家 accountId。
    const recipients = await this.worldMemberAccountIds(worldId, accountId);
    void this.deps.gateway.broadcast(recipients, {
      kind: 'nation_msg',
      worldId,
      fromPublicId: accountId,
      fromName: senderName,
      body,
      ts,
    });

    return { id: msgId, senderId: accountId, senderName, body, ts };
  }

  /**
   * 获取国家/世界公频历史（倒序分页，before 为 ms epoch 游标，limit ≤50）。
   * 玩家须已入驻该世界。
   */
  async getChannel(
    worldId: string,
    accountId: string,
    before?: number,
    limit = 30,
  ): Promise<NationMessageView[]> {
    const { cols } = this.deps;

    const pw = await cols.playerWorld.findOne({ _id: `${worldId}:${accountId}` });
    if (!pw) throw new SlgError('NOT_IN_WORLD');

    const realLimit = Math.min(Math.max(limit, 1), 50);
    const query: Record<string, unknown> = { worldId };
    if (before != null) query['ts'] = { $lt: new Date(before) };

    const docs = await cols.nationMessages
      .find(query)
      .sort({ ts: -1 })
      .limit(realLimit)
      .toArray();

    return docs.map((d) => ({
      id: d._id,
      senderId: d.senderId,
      senderName: d.senderName,
      body: d.body,
      ts: d.ts.getTime(),
    }));
  }

  private async worldMemberAccountIds(worldId: string, exclude: string): Promise<string[]> {
    const members = await this.deps.cols.playerWorld
      .find({ worldId })
      .project<{ accountId: string }>({ accountId: 1 })
      .toArray();
    return members.map((m) => m.accountId).filter((id) => id !== exclude);
  }
}

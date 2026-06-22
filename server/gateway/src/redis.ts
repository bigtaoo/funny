// gateway Redis 订阅端（S8-4b + B7，§8.4 横扩推送）。gateway 订阅 GW_PUSH_REDIS_CHANNEL，
// worldsvc 把「收件人列表 + 一条 push 消息」发到该 channel，本进程收到后只向本机在线的
// 收件人 socket 扇出（routeBroadcast）。多 gateway 实例各自订阅，天然实现跨实例路由（SOC9）。
//
// 掉线重连：ioredis 设 autoResubscribe=true（也是默认值），重连后自动补订阅同一 channel，
// 期间漏掉的 push 消息客户端下次 REST 拉历史补回（REST 是权威，push 是加速）。
//
// 缺省无 Redis URL → 返回 null，频道实时推送关闭（worldsvc 侧降级为 O(n) HTTP 直推兜底，
// 客户端仍可 REST 轮询拉历史）。动态 import ioredis：dev 未安装也能编译（与 worldsvc/redis.ts 同形）。
import { createLogger, GW_PUSH_REDIS_CHANNEL } from '@nw/shared';
import type { PushMsg } from './matchsvcClient';

const log = createLogger('gateway:redis');

/** Redis 上传来的扇出包：一条 push + 它的收件人 accountId 列表。 */
interface BroadcastEnvelope {
  recipients: string[];
  msg: PushMsg;
}

export interface GatewaySubscriber {
  quit(): Promise<void>;
}

/**
 * 连接并订阅 GW_PUSH_REDIS_CHANNEL。每条消息解析为 {recipients, msg}，回调 onBroadcast
 * 由 Gateway.routeBroadcast 消费（只推本机在线者）。连接失败 → 返回 null（实时推送降级）。
 * autoResubscribe=true 保证 Redis 重连后自动补订阅（B7 验收项）。
 */
export async function connectGatewaySubscriber(
  url: string | undefined,
  onBroadcast: (recipients: string[], msg: PushMsg) => void,
): Promise<GatewaySubscriber | null> {
  if (!url) return null;
  try {
    const spec = 'ioredis';
    const mod: any = await import(spec);
    const Redis = mod.default ?? mod;
    const client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      autoResubscribe: true, // 重连后自动补订阅（ioredis 默认已是 true，显式声明便于审计）
    });
    client.on('error', (e: Error) => log.error('redis error', { err: e.message }));
    client.on('ready', () => log.info('redis ready / resubscribed', { channel: GW_PUSH_REDIS_CHANNEL }));
    client.on('message', (_channel: string, payload: string) => {
      try {
        const env = JSON.parse(payload) as BroadcastEnvelope;
        if (Array.isArray(env.recipients) && env.msg) onBroadcast(env.recipients, env.msg);
      } catch (e) {
        log.warn('bad broadcast payload', { err: (e as Error).message });
      }
    });
    await client.subscribe(GW_PUSH_REDIS_CHANNEL);
    log.info('subscribed', { channel: GW_PUSH_REDIS_CHANNEL });
    return { quit: () => client.quit().then(() => undefined) };
  } catch (e) {
    log.error('subscribe failed; channel real-time push disabled', { url, err: (e as Error).message });
    return null;
  }
}

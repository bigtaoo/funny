// worldsvc Redis 接入（S8-0，首次引入 Redis；META_DESIGN §6.7 / SOCIAL_DESIGN SOC7）。
// S8-0 仅建立可选连接骨架——真正用途（行军调度 ZSET `world:{w}:march`、家族/宗门频道 pub/sub、
// gateway 横扩路由、热格缓存）在 S8-1/S8-2/S8-4 接入。缺省无 Redis URL → 返回 null，
// worldsvc 降级运行（行军到点扫描走 Mongo arriveAt 索引，频道功能关闭）。
//
// 实现说明：用变量 specifier 动态 import，使 tsc 在 ioredis 未安装时也能编译
// （Redis 是生产依赖，dev 骨架阶段可不装；package.json 已声明，生产 npm i 即装上）。

/** worldsvc 用到的最小 Redis 接口（按需扩展；类型独立于 ioredis 具体实现）。 */
export interface WorldRedis {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export async function connectRedis(url: string | undefined): Promise<WorldRedis | null> {
  if (!url) return null;
  try {
    // 变量 specifier：绕过 tsc 静态模块解析（ioredis 可在 dev 未安装）。
    const spec = 'ioredis';
    const mod: any = await import(spec);
    const Redis = mod.default ?? mod;
    const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    client.on('error', (e: Error) => console.error('[world-redis] error:', e.message));
    return client as WorldRedis;
  } catch (e) {
    console.error(
      `[world-redis] 连接 Redis 失败 (url=${url}): ${(e as Error).message}. ` +
        `worldsvc 降级运行（行军调度走 Mongo 兜底，频道关闭）。`,
    );
    return null;
  }
}

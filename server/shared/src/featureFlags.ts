// 功能开关（Feature Flags）核心：类型安全白名单 + default 兜底 + 统一求值纯函数 + 进程级缓存。
// 设计基准：design/game/FEATURE_FLAGS_DESIGN.md。
//
// 单一真源原则：求值逻辑（evaluateFlag）前后端共用同一实现——
//   • metaserver 在 /bootstrap 对客户端「求值成布尔 map」（规则/白名单绝不下发）；
//   • 不连库的后端（gateway/matchsvc/worldsvc…）轮询 admin 拿原始规则，自己 evaluateFlag 现场求值。
// flag 与 SaveData.flags（玩家态）/ AccountDoc.flags（账号态）彻底解耦——这是运营控制的全局开关。

// ── 白名单（代码侧登记，新增 flag 在此追加）─────────────────────────────
/**
 * 全部 feature flag 的注册表。key 即 flag 标识，前后端用 {@link FlagKey} 类型引用——拼错编译期报错。
 * - `default`：库里查不到 / admin 不可达时的兜底值，**必须存在**。
 * - `side`：`client | server | both`，仅文档/校验提示，标明这个 flag 在哪侧被读。
 */
export const FEATURE_FLAGS = {
  /**
   * 大区匹配机器人兜底：打开后，玩家 ranked 匹配等待超过阈值（默认 30s）仍无真人对手，
   * 即降级为「打 AI」（客户端本地 AI 对局）。关闭则一直等真人。
   */
  match_bot_fallback: { default: false, desc: '匹配超时降级打AI', side: 'server' },
} as const;

export type FlagKey = keyof typeof FEATURE_FLAGS;

/** 全部白名单 key（运行期枚举：admin 列表 / metaserver 求值全量用）。 */
export const FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FlagKey[];

export function isFlagKey(v: unknown): v is FlagKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, v);
}

/** flag 默认值（doc 不存在时的兜底）。 */
export function flagDefault(key: FlagKey): boolean {
  return FEATURE_FLAGS[key].default;
}

// ── 平台 / 规则文档 ──────────────────────────────────────────────────────
export type FlagPlatform = 'web' | 'wechat' | 'crazygames';
export const FLAG_PLATFORMS: readonly FlagPlatform[] = ['web', 'wechat', 'crazygames'];

/** 定向规则（admin 库 featureFlags 集合的可选 rollout 子文档）。 */
export interface FlagRollout {
  /** 0-100，按 hash(flagKey+accountId) 稳定分桶。 */
  pct?: number;
  /** 命中的部署区域（见 DEPLOY_TOPOLOGY）。 */
  regions?: string[];
  /** 命中的平台。 */
  platforms?: FlagPlatform[];
  /** 白名单：命中即开（盖过 pct/region/platform）。 */
  allowAccounts?: string[];
  /** 黑名单：命中即关（盖过 allow 之外的一切）。 */
  denyAccounts?: string[];
}

/** flag 规则文档（admin 库 featureFlags 集合；_id = flag key）。 */
export interface FeatureFlagDoc {
  _id: FlagKey;
  /** 总闸：false → 任何人都关（无视定向）。 */
  enabled: boolean;
  rollout?: FlagRollout;
  desc?: string;
  updatedAt: number;
  /** admin 账号 ID。 */
  updatedBy: string;
}

/** 求值上下文（按当前 user / 部署环境）。 */
export interface FlagContext {
  /** 未登录时 undefined。 */
  accountId?: string;
  /** 部署区域（由进程注入，知道自己在哪区）。 */
  region?: string;
  platform?: FlagPlatform;
}

// ── 稳定 hash（FNV-1a 32-bit）──────────────────────────────────────────────
// 灰度分桶必须稳定：同一玩家在同一 flag 上结果不抖动（否则名单飘移）。FNV-1a 简单、无依赖、分布够均匀。
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit，返回无符号 32 位整数。 */
export function fnv1a(input: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    // Math.imul 做 32 位无溢出乘法。
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** 稳定分桶：返回 [0,100) 区间的桶号（hash(flagKey+accountId) % 100）。 */
export function rolloutBucket(key: string, accountId: string): number {
  return fnv1a(`${key}:${accountId}`) % 100;
}

// ── 求值（前后端唯一真源）──────────────────────────────────────────────────
/**
 * 求值一个 flag。短路顺序（FEATURE_FLAGS_DESIGN §3）：
 *  1. doc 不存在 → default；
 *  2. enabled===false → false（总闸优先于一切）；
 *  3. denyAccounts 命中 → false；
 *  4. allowAccounts 命中 → true（盖过 region/platform/pct）；
 *  5. regions 有限定且当前 region 不在内 → false；platforms 同理；
 *  6. pct 有限定：bucket < pct → 否则 false；未登录无 accountId 时按 pct>=100 才算命中（保守）；
 *  7. 全部通过 → true。
 */
export function evaluateFlag(key: FlagKey, doc: FeatureFlagDoc | null | undefined, ctx: FlagContext): boolean {
  if (!doc) return flagDefault(key);
  if (doc.enabled === false) return false;
  const r = doc.rollout;
  if (!r) return true; // 总闸开、无定向 → 全开。

  if (ctx.accountId && r.denyAccounts?.includes(ctx.accountId)) return false;
  if (ctx.accountId && r.allowAccounts?.includes(ctx.accountId)) return true;

  if (r.regions && r.regions.length > 0) {
    if (!ctx.region || !r.regions.includes(ctx.region)) return false;
  }
  if (r.platforms && r.platforms.length > 0) {
    if (!ctx.platform || !r.platforms.includes(ctx.platform)) return false;
  }
  if (typeof r.pct === 'number') {
    const pct = Math.max(0, Math.min(100, r.pct));
    if (pct >= 100) return true;
    if (pct <= 0) return false;
    // 未登录无 accountId：无法稳定分桶 → 仅 pct>=100 命中（上面已 return），故此处 false。
    if (!ctx.accountId) return false;
    return rolloutBucket(key, ctx.accountId) < pct;
  }
  return true;
}

// ── 进程级缓存（不连库后端：轮询 admin 原始规则 + 短 TTL + 本地求值）─────────────────
/**
 * 校验并规整一份原始规则文档（来自 admin 内部端点 / 库）。丢弃非白名单 key、非法字段。
 * 容错优先：任何字段缺失/越界都降级为「忽略该字段」，不抛——分发链路绝不能因脏数据崩。
 */
export function sanitizeFlagDoc(raw: unknown): FeatureFlagDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isFlagKey(o._id)) return null;
  const rolloutIn = o.rollout && typeof o.rollout === 'object' ? (o.rollout as Record<string, unknown>) : undefined;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  let rollout: FlagRollout | undefined;
  if (rolloutIn) {
    rollout = {};
    if (typeof rolloutIn.pct === 'number' && Number.isFinite(rolloutIn.pct)) {
      rollout.pct = Math.max(0, Math.min(100, Math.floor(rolloutIn.pct)));
    }
    const regions = strArr(rolloutIn.regions);
    if (regions) rollout.regions = regions;
    const platforms = strArr(rolloutIn.platforms)?.filter((p): p is FlagPlatform =>
      (FLAG_PLATFORMS as readonly string[]).includes(p),
    );
    if (platforms) rollout.platforms = platforms;
    const allow = strArr(rolloutIn.allowAccounts);
    if (allow) rollout.allowAccounts = allow;
    const deny = strArr(rolloutIn.denyAccounts);
    if (deny) rollout.denyAccounts = deny;
    if (Object.keys(rollout).length === 0) rollout = undefined;
  }
  return {
    _id: o._id,
    enabled: o.enabled !== false, // 缺省视为开（仅显式 false 关总闸）
    ...(rollout ? { rollout } : {}),
    ...(typeof o.desc === 'string' ? { desc: o.desc } : {}),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy : '',
  };
}

export interface FeatureFlagCacheOpts {
  /** 拉全量原始规则的取数函数（通常 = 轮询 admin GET /admin/internal/flags）。 */
  fetchAll: () => Promise<unknown[]>;
  /** 刷新间隔 ms。默认 30000。 */
  ttlMs?: number;
  /** 注入时钟（测试）。默认 Date.now。 */
  now?: () => number;
  /** 区域（进程知道自己在哪区，注入到求值 ctx 缺省值）。 */
  region?: string;
  /** 刷新失败回调（默认静默——优雅降级吃旧缓存）。 */
  onError?: (err: unknown) => void;
}

/**
 * 不连库后端的 flag 缓存：启动 refresh 一次 → 每 ttl 刷新 → 暴露 isOn(key, ctx)（内部即 evaluateFlag）。
 * 降级策略：admin 不可达时吃上次缓存；冷启动从未拉到 → default 兜底。绝不阻塞主流程。
 */
export class FeatureFlagCache {
  private docs = new Map<FlagKey, FeatureFlagDoc>();
  private timer: NodeJS.Timeout | null = null;
  private loadedOnce = false;
  private readonly fetchAll: () => Promise<unknown[]>;
  private readonly ttlMs: number;
  private readonly region?: string;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: FeatureFlagCacheOpts) {
    this.fetchAll = opts.fetchAll;
    this.ttlMs = opts.ttlMs ?? 30_000;
    if (opts.region) this.region = opts.region;
    if (opts.onError) this.onError = opts.onError;
  }

  /** 拉一次全量并替换缓存。失败保留旧缓存（不抛）。 */
  async refresh(): Promise<void> {
    try {
      const raw = await this.fetchAll();
      const next = new Map<FlagKey, FeatureFlagDoc>();
      for (const r of raw) {
        const doc = sanitizeFlagDoc(r);
        if (doc) next.set(doc._id, doc);
      }
      this.docs = next;
      this.loadedOnce = true;
    } catch (e) {
      this.onError?.(e);
      // 保留旧缓存，优雅降级。
    }
  }

  /** 启动周期刷新（先同步拉一次，再定时）。timer unref——不挡进程退出。 */
  async start(): Promise<void> {
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.ttlMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 求值一个 flag（缺省把 cache.region 注入 ctx，调用方可覆盖）。 */
  isOn(key: FlagKey, ctx: FlagContext = {}): boolean {
    const merged: FlagContext = { ...ctx };
    if (merged.region === undefined && this.region !== undefined) merged.region = this.region;
    return evaluateFlag(key, this.docs.get(key) ?? null, merged);
  }

  /** 当前缓存里某 flag 的原始规则（admin 工具/调试用；无覆盖返回 null）。 */
  rawDoc(key: FlagKey): FeatureFlagDoc | null {
    return this.docs.get(key) ?? null;
  }

  /** 是否至少成功拉到过一次（false = 仍在 default 兜底）。 */
  get hasLoaded(): boolean {
    return this.loadedOnce;
  }
}

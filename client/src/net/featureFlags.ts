// 客户端功能开关下发 + 日志定向采集（FEATURE_FLAGS_DESIGN §9，F3 客户端侧）。
//
// 职责：
//   1. 启动拉一次 + 每 120s 轮询公开 GET /bootstrap，拿「与默认值不同的 flag」布尔 map（多数玩家为空）。
//   2. 解析 client_log_* 四个分级 flag → 推出当前上传阈值（debug>info>warn>error，取最 verbose 的已开）。
//   3. 命中阈值后，每 30s 把环形缓冲里 ≥阈值的日志批量 POST /client/log（metaserver 转发 Loki）。
//
// 单一真源原则：客户端只拿服务端求值后的布尔结果，绝不下发规则/白名单（防泄露未上线功能 + 防作弊）。
// 非定向玩家 bootstrap 拿空 map → 阈值恒「关」→ 永不调 /client/log，天然零负担、天然限流。

import type { ApiClient } from './ApiClient';
import { netLog, snapshotClientLogs, LOG_LEVEL_RANK, type ClientLogLevel } from './log';

const log = netLog('flags');

const DEFAULT_POLL_MS = 120_000; // bootstrap 轮询间隔（§9.3）
const DEFAULT_UPLOAD_MS = 30_000; // 命中后日志批量上报间隔（§9.4）

/** 四个分级 flag → 级别，按 verbose 程度从高到低排列（推阈值时第一个命中即最 verbose）。 */
const CLIENT_LOG_FLAGS: { flag: string; level: ClientLogLevel }[] = [
  { flag: 'client_log_debug', level: 'debug' },
  { flag: 'client_log_info', level: 'info' },
  { flag: 'client_log_warn', level: 'warn' },
  { flag: 'client_log_error', level: 'error' },
];

export interface FeatureFlagsOpts {
  api: ApiClient;
  /** 平台名（web / wechat / crazygames），随 bootstrap query 带入求值。 */
  platform: string;
  /** 取当前玩家的 9 位 publicId（登录后才有；定向采集靠它）。 */
  getPublicId: () => string | null;
  pollMs?: number;
  uploadMs?: number;
}

export class FeatureFlags {
  private flags: Record<string, boolean> = {};
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private uploadTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前日志上传阈值 rank（snapshot 取 ≤ 此 verbose 度的条目）；null = 未命中、不上报。 */
  private thresholdRank: number | null = null;
  /** 上次上报到的缓冲序号（只发其后的新条目，避免重复）。 */
  private lastSeq = 0;
  private readonly api: ApiClient;
  private readonly platform: string;
  private readonly getPublicId: () => string | null;
  private readonly pollMs: number;
  private readonly uploadMs: number;

  constructor(opts: FeatureFlagsOpts) {
    this.api = opts.api;
    this.platform = opts.platform;
    this.getPublicId = opts.getPublicId;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.uploadMs = opts.uploadMs ?? DEFAULT_UPLOAD_MS;
  }

  /** 某 flag 当前是否开（服务端只回 diff，故缺省即默认值——当前全部 flag 默认 false）。 */
  isOn(key: string): boolean {
    return this.flags[key] === true;
  }

  /** 启动：立即拉一次 + 周期轮询。重复调用安全（已起则忽略）。 */
  start(): void {
    void this.refresh();
    if (!this.pollTimer) this.pollTimer = setInterval(() => void this.refresh(), this.pollMs);
  }

  /** 立即重拉一次（登录拿到 publicId 后调，无需等下一个轮询周期）。 */
  async refresh(): Promise<void> {
    try {
      const publicId = this.getPublicId() ?? undefined;
      const { flags } = await this.api.getBootstrap(this.platform, publicId);
      this.flags = flags ?? {};
      this.recomputeLogThreshold();
    } catch {
      // bootstrap 失败：保留上次结果，静默（启动早期/离线很常见，绝不影响主流程）。
    }
  }

  /** 根据 client_log_* flag 推当前上传阈值，并相应启停上传定时器。 */
  private recomputeLogThreshold(): void {
    let rank: number | null = null;
    for (const { flag, level } of CLIENT_LOG_FLAGS) {
      if (this.flags[flag] === true) { rank = LOG_LEVEL_RANK[level]; break; } // 最 verbose 的已开者
    }
    const was = this.thresholdRank;
    this.thresholdRank = rank;
    if (rank !== null && this.uploadTimer === null) {
      log.info('client log collection ENABLED', { thresholdRank: rank });
      this.uploadTimer = setInterval(() => void this.uploadTick(), this.uploadMs);
      void this.uploadTick(); // 立即上报一次当前缓冲里的上下文
    } else if (rank === null && this.uploadTimer !== null) {
      log.info('client log collection disabled');
      clearInterval(this.uploadTimer);
      this.uploadTimer = null;
    } else if (rank !== null && was !== rank) {
      log.info('client log threshold changed', { thresholdRank: rank });
    }
  }

  /** 把缓冲里 ≥阈值的新日志批量上报（命中定向时才被调度）。 */
  private async uploadTick(): Promise<void> {
    if (this.thresholdRank === null) return;
    const publicId = this.getPublicId();
    if (!publicId) return; // 无 publicId 无法归属（定向本就需要它），跳过
    const { entries, lastSeq } = snapshotClientLogs(this.thresholdRank, this.lastSeq);
    this.lastSeq = lastSeq;
    if (entries.length === 0) return;
    try {
      await this.api.postClientLog({
        publicId,
        platform: this.platform,
        logs: entries.map((e) => ({ level: e.level, msg: e.msg, ts: e.ts, ...(e.tag ? { tag: e.tag } : {}) })),
      });
    } catch {
      // 上报失败静默：日志采集是尽力而为，绝不影响玩家。下批新条目继续尝试。
    }
  }

  /** 停止所有定时器（一般无需调；应用生命周期内常驻）。 */
  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.uploadTimer) { clearInterval(this.uploadTimer); this.uploadTimer = null; }
  }
}

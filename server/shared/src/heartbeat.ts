// 存活心跳：周期性打一条 info 日志，作为「服务还活着」的信号——空闲时 Grafana/Loki 里
// 也能看到每个 svc 在按节奏跳，从而判断进程没挂、采集链路也通。
//
// 设计：
//   • info 级别——即便生产 NW_LOG_LEVEL=info 也不会被过滤（debug 心跳会在 info 下消失）。
//   • 启动即打一条（确认上线），之后每 intervalMs（缺省 5 分钟）一条。
//   • timer.unref()——不阻止进程正常退出（优雅关闭时无需手动 clear）。

import { type Logger } from './logger';

export interface HeartbeatHandle {
  /** 停止心跳（一般无需调用，timer 已 unref）。 */
  stop(): void;
}

export interface HeartbeatOptions {
  /** 间隔毫秒，缺省 5 分钟。 */
  intervalMs?: number;
  /** 日志 msg，缺省 'heartbeat'。 */
  msg?: string;
  /** 附加到每条心跳的额外字段（如在线连接数），惰性求值。 */
  extra?: () => Record<string, unknown>;
}

export function startHeartbeat(log: Logger, opts: HeartbeatOptions = {}): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const msg = opts.msg ?? 'heartbeat';
  const emit = (): void => {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    const data: Record<string, unknown> = { uptimeSec: Math.round(process.uptime()), rssMb };
    if (opts.extra) {
      try {
        Object.assign(data, opts.extra());
      } catch {
        /* extra 求值失败不影响心跳本身 */
      }
    }
    log.info(msg, data);
  };
  emit(); // 启动即打一条
  const timer = setInterval(emit, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

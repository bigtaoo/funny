// Liveness heartbeat: emits one info log on a regular interval as a "service is alive" signal —
// even when idle, Grafana/Loki will show each svc beating on schedule, confirming the process
// has not crashed and the collection pipeline is healthy.
//
// Design:
//   • info level — not filtered even when production NW_LOG_LEVEL=info (a debug heartbeat would
//     disappear under info).
//   • Fires once immediately on startup (confirms the service is up), then once every intervalMs
//     (default 5 minutes).
//   • timer.unref() — does not prevent the process from exiting normally (no manual clear needed
//     during graceful shutdown).

import { type Logger } from './logger';

export interface HeartbeatHandle {
  /** Stop the heartbeat (normally unnecessary — the timer is already unref'd). */
  stop(): void;
}

export interface HeartbeatOptions {
  /** Interval in milliseconds; default 5 minutes. */
  intervalMs?: number;
  /** Log message string; default 'heartbeat'. */
  msg?: string;
  /** Extra fields appended to each heartbeat log entry (e.g. active connection count); evaluated lazily. */
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
        /* extra evaluation failure must not affect the heartbeat itself */
      }
    }
    log.info(msg, data);
  };
  emit(); // Fire once immediately on startup
  const timer = setInterval(emit, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

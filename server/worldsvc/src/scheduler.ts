// worldsvc 行军到点调度循环（S8-2，§14.4 / U12）。
// 单点消费：定时调 WorldService.processDueArrivals 落地所有到达的行军（占领/增援/退兵）。
// 处理以 Mongo arriveAt 索引扫描为权威（无 Redis 也正确）；Redis ZSET 仅作未来精确唤醒提示。
// timer 用 unref() 不阻塞进程退出；处理重入用 running 守卫（避免上一拍未完又起一拍）。
import type { WorldService } from './service';

export interface Scheduler {
  stop(): void;
}

/** 每 tickMs 处理一次到点行军（默认 2s，对 6s/格的行军节奏足够即时）。 */
export function startScheduler(svc: WorldService, tickMs = 2000): Scheduler {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // 上一拍仍在处理 → 跳过本拍
    running = true;
    void svc
      .processDueArrivals()
      .catch((e) => console.error('[world-scheduler] processDueArrivals failed:', (e as Error).message))
      .finally(() => {
        running = false;
      });
  }, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// worldsvc 调度循环（S8-2 行军 + S8-5 拍卖过期）。
// 行军：定时调 WorldService.processDueArrivals 落地所有到达（占领/增援/退兵）。
// 拍卖：定时调 AuctionService.processExpiredAuctions 处理过期挂拍（退还卖方标的）。
// 两者共用同一 setInterval（tickMs = 2s），Mongo 索引扫描权威（无 Redis 也正确）。
// timer 用 unref() 不阻塞进程退出；running 守卫防重入。
import type { WorldService } from './service';
import type { AuctionService } from './auctionService';

export interface Scheduler {
  stop(): void;
}

/** 每 tickMs 处理一次到点行军 + 过期拍卖（默认 2s）。 */
export function startScheduler(svc: WorldService, auctionSvc?: AuctionService, tickMs = 2000): Scheduler {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const tasks: Promise<unknown>[] = [
      svc
        .processDueArrivals()
        .catch((e) => console.error('[world-scheduler] processDueArrivals failed:', (e as Error).message)),
    ];
    if (auctionSvc) {
      tasks.push(
        auctionSvc
          .processExpiredAuctions()
          .catch((e) => console.error('[world-scheduler] processExpiredAuctions failed:', (e as Error).message)),
      );
    }
    void Promise.allSettled(tasks).finally(() => {
      running = false;
    });
  }, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// analyticsvc ETL 调度器（A9-7）。
// 每小时重算「当天 + 昨天」的漏斗预聚合数据，写入 funnels_daily。
// 重跑幂等（upsert），无需持久化调度状态。
import type { AnalyticsService } from './service';

const INTERVAL_MS = 60 * 60 * 1000; // 1 小时

function utcDateStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function startEtlScheduler(svc: AnalyticsService): () => void {
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // 今天 + 昨天（当天数据随时间积累，昨天数据修补漏报）。
      await Promise.all([
        svc.runFunnelEtl(utcDateStr(0)),
        svc.runFunnelEtl(utcDateStr(-1)),
      ]);
    } catch (e) {
      console.error('[analyticsvc] ETL 失败', e);
    } finally {
      running = false;
    }
  };

  // 启动即执行一次，之后每小时。
  void run();
  const timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref(); // 不阻塞进程退出。

  return () => clearInterval(timer);
}

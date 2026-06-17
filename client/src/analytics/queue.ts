// Analytics event queue + flush logic (A9-4).
// Buffers events in memory and flushes on timer / lifecycle triggers / size threshold.

import type { components } from '../net/openapi';

type AnalyticsEvent = components['schemas']['AnalyticsEvent'];

export interface QueueOptions {
  analyticsBaseUrl: string;
  getToken: () => string | undefined;
  getBatchMeta: () => BatchMeta;
}

export interface BatchMeta {
  session_id: string;
  device_id: string;
  platform: 'web' | 'wechat' | 'crazygames';
  os: string;
  game_version: string;
  locale: string;
}

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_SIZE_THRESHOLD = 50;
const MAX_QUEUE_SIZE = 200;
const MAX_RETRIES = 3;

export class EventQueue {
  private queue: AnalyticsEvent[] = [];
  private retries = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: QueueOptions) {}

  push(event: AnalyticsEvent): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) return; // silent drop
    this.queue.push(event);
    if (this.queue.length >= FLUSH_SIZE_THRESHOLD) {
      void this.flush();
    }
  }

  /** Called before a screen_view — low-cost checkpoint flush. */
  checkpoint(): void {
    if (this.queue.length > 0) void this.flush();
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.setupLifecycleHooks();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Synchronous fire-and-forget for beforeunload / wx.onHide. */
  flushSync(): void {
    if (this.queue.length === 0) return;
    const batch = this.buildBatch();
    this.queue = [];
    const body = JSON.stringify(batch);
    const url = `${this.opts.analyticsBaseUrl}/analytics/events`;
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, body);
    } else {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body,
      }).catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.buildBatch();
    const snapshot = this.queue;
    this.queue = [];
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = this.opts.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${this.opts.analyticsBaseUrl}/analytics/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch),
      });
      this.retries = 0;
    } catch {
      this.retries++;
      if (this.retries <= MAX_RETRIES) {
        // put events back for retry
        this.queue = [...snapshot, ...this.queue];
      }
      // else: exceed max retries → silent drop
    }
  }

  private buildBatch() {
    const meta = this.opts.getBatchMeta();
    return { ...meta, events: this.queue };
  }

  private setupLifecycleHooks(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushSync();
      });
      window.addEventListener('beforeunload', () => this.flushSync());
    }
    // WeChat — wx.onHide available in the mini-game environment
    const wx = (globalThis as { wx?: { onHide?: (cb: () => void) => void } }).wx;
    if (wx?.onHide) {
      wx.onHide(() => this.flushSync());
    }
  }
}

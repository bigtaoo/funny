// Analytics event queue + flush logic (A9-4).
// Buffers events in memory and flushes on timer / lifecycle triggers / size threshold.

import type { components } from '../net/openapi';
import { netTransport } from '../net/transport';
import { onAppLifecycleChange } from '../platform/appLifecycle';

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
  /** Raw device fields (A9-9), best-effort — absent where the runtime doesn't expose them. */
  ua?: string;
  screen_w?: number;
  screen_h?: number;
  dpr?: number;
  /** GDPR consent (C5-c, L1-1). track() already gates all queuing on consent having been
   *  granted, so every batch reaching flush()/flushSync() is post-consent — this just
   *  makes that fact visible to the server, which discards identified batches without it. */
  consent: boolean;
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

  /**
   * Called before a screen_view — low-cost checkpoint flush.
   *
   * Deliberately skipped while no token is available yet. `user_id` is resolved per BATCH from the
   * Authorization header at ingest, so flushing early permanently stamps everything queued so far as
   * anonymous — and the first screen_view lands within the opening seconds of a session, before login
   * has finished. That is why `session_start` was anonymous 355 times against 128 identified in prod
   * as of 2026-08-24: the checkpoint kept racing the login it was queued alongside.
   *
   * Nothing is lost by waiting. This flush is an optimisation, not a delivery guarantee — the 30s
   * timer, the 50-event threshold and the unload flush all still fire, and queue growth stays bounded
   * by MAX_QUEUE_SIZE either way. A player who genuinely never logs in gets the same events, sent a
   * little later and still anonymous, which is the correct outcome for them.
   */
  checkpoint(): void {
    if (this.queue.length === 0) return;
    if (!this.opts.getToken()) return;
    void this.flush();
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

  /** POST headers for a batch: JSON, plus the bearer token when the player is logged in. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.opts.getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  private get url(): string {
    return `${this.opts.analyticsBaseUrl}/analytics/events`;
  }

  /**
   * Fire-and-forget flush for the hide / unload path (visibilitychange→hidden, beforeunload,
   * wx.onHide).
   *
   * **Uses a keepalive request, NOT navigator.sendBeacon** — the reason is the whole point of this
   * method. `sendBeacon` cannot set request headers at all, so a beacon can never carry the
   * `Authorization` bearer token, and analyticsvc attributes `user_id` purely from that header. Every
   * event that only ever leaves on this path was therefore recorded anonymously, 100% of the time:
   * as of 2026-08-24 prod held 2848 `session_end` and 2848 `churn_signal` rows and **not one** of them
   * was attributable to a player, while events that happen to ride a periodic flush (`gacha_draw`:
   * 3297 identified vs 247 anonymous) were fine. It read like a sampling quirk; it was a hard
   * structural gap in exactly the two events the churn funnel is built on.
   *
   * A keepalive fetch is the spec-sanctioned unload-surviving alternative and can set headers, so the
   * transport asks for one. It is already the same choice net/anomaly's exit beacon made, for a
   * related reason (there: sendBeacon is always credentialed, which its CORS setup rejects outright).
   *
   * Cost: an `Authorization` header makes this a preflighted request, and a preflight racing page
   * unload is not something to rely on — hence the `Access-Control-Max-Age` analyticsvc now returns,
   * so the periodic flush's preflight is still warm and this one goes out as a single request.
   *
   * The former `sendBeacon` fallback ("where `fetch` does not exist") is gone as of 2026-09-01, and
   * with it the last reader of the global `fetch` in this file — the send now goes through
   * net/transport.ts. That fallback was dead on every platform we ship: web / CrazyGames / the
   * Capacitor shell all have `fetch` (the asset loader would not survive a runtime without it), and
   * the one runtime that genuinely lacks it — the WeChat mini-game — has no `navigator.sendBeacon`
   * either, so this method was a silent no-op there. It now sends via `wx.request`, which is the
   * point of the seam. WeChat has no `keepalive` equivalent, but `wx.onHide` fires while the process
   * is still alive (unlike `beforeunload`), so the send is best-effort rather than guaranteed.
   */
  flushSync(): void {
    if (this.queue.length === 0) return;
    const batch = this.buildBatch();
    this.queue = [];
    // credentials:'omit' is deliberate, not cargo-culted: analyticsvc answers with
    // `access-control-allow-origin: *`, and a wildcard origin is invalid for a credentialed
    // request — so sending cookies here would make the browser reject the response outright.
    // (WeChat has no cookie jar at all, so it is already true there.)
    void netTransport()
      .request({ method: 'POST', url: this.url, headers: this.headers(), keepalive: true, credentials: 'omit', body: JSON.stringify(batch) })
      .catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.buildBatch();
    const snapshot = this.queue;
    this.queue = [];
    try {
      await netTransport().request({
        method: 'POST',
        url: this.url,
        headers: this.headers(),
        credentials: 'omit',
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
    onAppLifecycleChange((state) => {
      if (state !== 'visible') this.flushSync();
    });
  }
}

// Client-side feature flag delivery + targeted log collection (FEATURE_FLAGS_DESIGN §9, F3 client side).
//
// Responsibilities:
//   1. Fetch once on startup + poll public GET /bootstrap every 120 s; receives a boolean map of flags that differ from defaults (empty for most players).
//   2. Parse the four tiered client_log_* flags → derive the current upload threshold (debug>info>warn>error; pick the most verbose one that is enabled).
//   3. Once a threshold is hit, batch-POST logs from the ring buffer that meet or exceed the threshold to /client/log every 30 s (metaserver forwards to Loki).
//
// Single-source-of-truth principle: the client only receives server-evaluated boolean results; rules/allowlists are never sent down (prevents leaking unreleased features and cheating).
// Non-targeted players get an empty map from bootstrap → threshold always "off" → /client/log is never called; zero overhead and rate-limiting by design.

import type { ApiClient } from './ApiClient';
import { netLog, snapshotClientLogs, LOG_LEVEL_RANK, type ClientLogLevel } from './log';

const log = netLog('flags');

const DEFAULT_POLL_MS = 120_000; // bootstrap poll interval (§9.3)
const DEFAULT_UPLOAD_MS = 30_000; // log batch upload interval when threshold is hit (§9.4)

/** Four tiered flags → levels, ordered from most to least verbose (first match when computing threshold = most verbose enabled). */
const CLIENT_LOG_FLAGS: { flag: string; level: ClientLogLevel }[] = [
  { flag: 'client_log_debug', level: 'debug' },
  { flag: 'client_log_info', level: 'info' },
  { flag: 'client_log_warn', level: 'warn' },
  { flag: 'client_log_error', level: 'error' },
];

export interface FeatureFlagsOpts {
  api: ApiClient;
  /** Platform name (web / wechat / crazygames), passed as a bootstrap query parameter for server-side evaluation. */
  platform: string;
  /** Returns the current player's 9-digit publicId (available only after login; required for targeted collection). */
  getPublicId: () => string | null;
  pollMs?: number;
  uploadMs?: number;
}

export class FeatureFlags {
  private flags: Record<string, boolean> = {};
  /** Paddle.js seller client token delivered by /bootstrap (COMMERCIAL_DESIGN §IAP client); null until fetched / when Paddle is unconfigured server-side. */
  private paddleClientToken: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private uploadTimer: ReturnType<typeof setInterval> | null = null;
  /** Current log upload threshold rank (snapshot collects entries at or below this verbosity); null = no threshold matched, nothing uploaded. */
  private thresholdRank: number | null = null;
  /** Sequence number of the last uploaded buffer entry (only newer entries are sent, avoiding duplicates). */
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

  /** Whether a given flag is currently enabled (server returns only diffs, so absent = default value — all flags default to false). */
  isOn(key: string): boolean {
    return this.flags[key] === true;
  }

  /** Paddle.js client token from the latest bootstrap, or null if not yet fetched / Paddle unconfigured. */
  getPaddleClientToken(): string | null {
    return this.paddleClientToken;
  }

  /** Start: fetch immediately + start periodic polling. Safe to call multiple times (ignored if already running). */
  start(): void {
    void this.refresh();
    if (!this.pollTimer) this.pollTimer = setInterval(() => void this.refresh(), this.pollMs);
  }

  /** Immediately re-fetch (call after login when publicId becomes available, without waiting for the next poll cycle). */
  async refresh(): Promise<void> {
    try {
      const publicId = this.getPublicId() ?? undefined;
      const { flags, paddleClientToken } = await this.api.getBootstrap(this.platform, publicId);
      this.flags = flags ?? {};
      this.paddleClientToken = paddleClientToken ?? null;
      this.recomputeLogThreshold();
    } catch {
      // bootstrap failed: keep the previous result silently (common at early startup or while offline; must never affect the main flow).
    }
  }

  /** Recompute the current upload threshold from client_log_* flags, and start or stop the upload timer accordingly. */
  private recomputeLogThreshold(): void {
    let rank: number | null = null;
    for (const { flag, level } of CLIENT_LOG_FLAGS) {
      if (this.flags[flag] === true) { rank = LOG_LEVEL_RANK[level]; break; } // first (most verbose) enabled flag
    }
    const was = this.thresholdRank;
    this.thresholdRank = rank;
    if (rank !== null && this.uploadTimer === null) {
      log.info('client log collection ENABLED', { thresholdRank: rank });
      this.uploadTimer = setInterval(() => void this.uploadTick(), this.uploadMs);
      void this.uploadTick(); // immediately upload whatever is currently in the buffer
    } else if (rank === null && this.uploadTimer !== null) {
      log.info('client log collection disabled');
      clearInterval(this.uploadTimer);
      this.uploadTimer = null;
    } else if (rank !== null && was !== rank) {
      log.info('client log threshold changed', { thresholdRank: rank });
    }
  }

  /** Batch-upload new log entries from the buffer that meet or exceed the threshold (only scheduled when targeted collection is active). */
  private async uploadTick(): Promise<void> {
    if (this.thresholdRank === null) return;
    const publicId = this.getPublicId();
    if (!publicId) return; // no publicId means attribution is impossible (targeted collection requires it) — skip
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
      // Upload failure is silently swallowed: log collection is best-effort and must never affect the player. The next batch will retry.
    }
  }

  /** Stop all timers (normally not needed; this instance lives for the full application lifetime). */
  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.uploadTimer) { clearInterval(this.uploadTimer); this.uploadTimer = null; }
  }
}

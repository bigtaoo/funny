// Shared foundation for the AdminService domain classes (see ../service.ts assembly).
//
// AdminCore holds `deps` (unpacked into public readonly fields, so domain class method bodies keep
// referencing `this.core.cols` / `this.core.now` verbatim) + the genuinely cross-cutting helpers used
// by more than one domain (audit / actorNames / requireCap). Each business domain lives in its own
// sibling file as an independent class taking `(core: AdminCore)` in its constructor (2026-08-11
// mixin-chain split, claudedocs/server.md's "拆分形态的优先级" 形态②/独立类+组合 — the 18 domains
// had zero cross-domain `this.*` calls in the mixin chain, only these three shared helpers, so
// composition replaces the chain one-for-one with no narrow per-pair interfaces needed). Domain-local
// state/helpers (e.g. auth.ts's login-attempt table) stay in their own domain file, not here.
import { randomUUID } from 'node:crypto';
import {
  roleHasCapability,
  createLogger,
  type AdminCapability,
  type AdminRole,
  type AuditAction,
} from '@nw/shared';
import type { AdminCollections, AuditDoc } from '../db';
import type { StatsClient, PlayerClient, AntiCheatClient, MismatchClient, PvpCardStatsClient, SuspiciousPveClient, MailDispatcher, AnalyticsClient, WorldClient, AuctionClient, LadderClient, EventsClient, GachaPoolsClient, PromoClient, PaddleEventsClient, ReportsClient, AppealsClient, EnforcementClient, FeedbackClient } from '../clients';
import { AdminError } from './errors';

const log = createLogger('admin:service');

/** Authenticated admin principal (injected by httpApi after decoding the admin JWT). */
export interface Actor {
  adminId: string;
  username: string;
  displayName: string;
  role: AdminRole;
}

export interface AdminServiceDeps {
  cols: AdminCollections;
  stats: StatsClient;
  players: PlayerClient;
  antiCheat: AntiCheatClient;
  mismatches: MismatchClient;
  pvpCardStats: PvpCardStatsClient;
  suspiciousPve: SuspiciousPveClient;
  mail: MailDispatcher;
  analytics: AnalyticsClient;
  world: WorldClient;
  auction: AuctionClient;
  ladder: LadderClient;
  events: EventsClient;
  gachaPools: GachaPoolsClient;
  promo: PromoClient;
  paddleEvents: PaddleEventsClient;
  reports: ReportsClient;
  appeals: AppealsClient;
  enforcement: EnforcementClient;
  feedback: FeedbackClient;
  now: () => number;
}

// Login failure rate limiting (OPS_DESIGN §6 "login failure rate limiting"). The admin service holds internal secrets
// and exposes a port to operators, making it a high-value attack target. Uses a per-username sliding-window counter;
// reaching the threshold locks the account for a period. In-memory state (sufficient for a single admin instance;
// migrate to Redis if horizontally scaled). Only auth.ts uses these — kept here as shared constants (imported by
// auth.ts) rather than moved there, since they're the public contract of the rate-limit window, not internal detail.
export const LOGIN_MAX_FAILURES = 5; // max failures within the window
export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // sliding window for failure counting
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // lockout duration after threshold is reached

export interface LoginAttempt {
  fails: number;
  windowStart: number;
  lockedUntil: number;
}

export class AdminCore {
  // Deps unpacked into public readonly fields so domain-class method bodies keep referencing them
  // verbatim (this.core.cols, this.core.now, …) — no protected-visibility wall to work around since
  // these are now sibling classes, not mixin-chain descendants.
  readonly cols: AdminCollections;
  readonly stats: StatsClient;
  readonly players: PlayerClient;
  readonly antiCheat: AntiCheatClient;
  readonly mismatches: MismatchClient;
  readonly pvpCardStats: PvpCardStatsClient;
  readonly suspiciousPve: SuspiciousPveClient;
  readonly mail: MailDispatcher;
  readonly analytics: AnalyticsClient;
  readonly world: WorldClient;
  readonly auction: AuctionClient;
  readonly ladder: LadderClient;
  readonly events: EventsClient;
  readonly gachaPools: GachaPoolsClient;
  readonly promo: PromoClient;
  readonly paddleEvents: PaddleEventsClient;
  readonly reports: ReportsClient;
  readonly appeals: AppealsClient;
  readonly enforcement: EnforcementClient;
  readonly feedback: FeedbackClient;
  readonly now: () => number;

  constructor(deps: AdminServiceDeps) {
    this.cols = deps.cols;
    this.stats = deps.stats;
    this.players = deps.players;
    this.antiCheat = deps.antiCheat;
    this.mismatches = deps.mismatches;
    this.pvpCardStats = deps.pvpCardStats;
    this.suspiciousPve = deps.suspiciousPve;
    this.mail = deps.mail;
    this.analytics = deps.analytics;
    this.world = deps.world;
    this.auction = deps.auction;
    this.ladder = deps.ladder;
    this.events = deps.events;
    this.gachaPools = deps.gachaPools;
    this.promo = deps.promo;
    this.paddleEvents = deps.paddleEvents;
    this.reports = deps.reports;
    this.appeals = deps.appeals;
    this.enforcement = deps.enforcement;
    this.feedback = deps.feedback;
    this.now = deps.now;
  }

  requireCap(actor: Actor, cap: AdminCapability): void {
    if (!roleHasCapability(actor.role, cap)) {
      throw new AdminError(403, 'forbidden', `missing capability: ${cap}`);
    }
  }

  /** Write one audit entry (best-effort, does not throw — an audit failure must not block the primary operation, but must be logged). */
  async audit(
    actor: string,
    action: AuditAction,
    extra: { target?: string; summary?: string; ip?: string } = {},
  ): Promise<void> {
    const doc: AuditDoc = {
      _id: randomUUID(),
      actor,
      action,
      ...(extra.target ? { target: extra.target } : {}),
      ...(extra.summary ? { summary: extra.summary } : {}),
      ...(extra.ip ? { ip: extra.ip } : {}),
      ts: this.now(),
    };
    try {
      await this.cols.auditLog.insertOne(doc);
    } catch (e) {
      log.error('audit write failed', { action, err: (e as Error).message });
    }
  }

  async actorNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)].filter((x) => !x.startsWith('unknown:'));
    const out = new Map<string, string>();
    if (uniq.length === 0) return out;
    const docs = await this.cols.adminAccounts
      .find({ _id: { $in: uniq } }, { projection: { displayName: 1, username: 1 } })
      .toArray();
    for (const d of docs) out.set(d._id, d.displayName || d.username);
    return out;
  }
}

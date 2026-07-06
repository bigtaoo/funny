// Shared foundation for the AdminService mixin chain (see ../service.ts assembly).
// AdminServiceBase holds `deps` (unpacked into protected fields, so domain mixin method bodies keep
// referencing `this.cols` / `this.now` verbatim) + the genuinely cross-cutting helpers used by more
// than one domain mixin (audit / actorNames / requireCap) plus the in-memory login-attempt table owned
// by the constructor. Each business domain lives in its own sibling file as an `XMixin(Base)` and is
// chained together into the final AdminService. Domain-local state/helpers stay in their own mixin file.
import { randomUUID } from 'node:crypto';
import {
  roleHasCapability,
  createLogger,
  type AdminCapability,
  type AdminRole,
  type AuditAction,
} from '@nw/shared';
import type { AdminCollections, AuditDoc } from '../db';
import type { StatsClient, PlayerClient, AntiCheatClient, MismatchClient, SuspiciousPveClient, MailDispatcher, AnalyticsClient, WorldClient, AuctionClient, LadderClient, EventsClient, GachaPoolsClient, PromoClient } from '../clients';
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
  suspiciousPve: SuspiciousPveClient;
  mail: MailDispatcher;
  analytics: AnalyticsClient;
  world: WorldClient;
  auction: AuctionClient;
  ladder: LadderClient;
  events: EventsClient;
  gachaPools: GachaPoolsClient;
  promo: PromoClient;
  now: () => number;
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type AdminBaseCtor = Constructor<AdminServiceBase>;

// Login failure rate limiting (OPS_DESIGN §6 "login failure rate limiting"). The admin service holds internal secrets
// and exposes a port to operators, making it a high-value attack target. Uses a per-username sliding-window counter;
// reaching the threshold locks the account for a period. In-memory state (sufficient for a single admin instance;
// migrate to Redis if horizontally scaled).
export const LOGIN_MAX_FAILURES = 5; // max failures within the window
export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // sliding window for failure counting
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // lockout duration after threshold is reached

export interface LoginAttempt {
  fails: number;
  windowStart: number;
  lockedUntil: number;
}

export class AdminServiceBase {
  protected readonly deps: AdminServiceDeps;
  // Deps unpacked into protected fields so domain-mixin method bodies keep referencing them verbatim (this.cols, this.now, …).
  protected readonly cols: AdminCollections;
  protected readonly stats: StatsClient;
  protected readonly players: PlayerClient;
  protected readonly antiCheat: AntiCheatClient;
  protected readonly mismatches: MismatchClient;
  protected readonly suspiciousPve: SuspiciousPveClient;
  protected readonly mail: MailDispatcher;
  protected readonly analytics: AnalyticsClient;
  protected readonly world: WorldClient;
  protected readonly auction: AuctionClient;
  protected readonly ladder: LadderClient;
  protected readonly events: EventsClient;
  protected readonly gachaPools: GachaPoolsClient;
  protected readonly promo: PromoClient;
  protected readonly now: () => number;
  /** Login failure rate-limit table (keyed by username, in-memory). */
  protected readonly loginAttempts = new Map<string, LoginAttempt>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    const deps = args[0] as AdminServiceDeps;
    this.deps = deps;
    this.cols = deps.cols;
    this.stats = deps.stats;
    this.players = deps.players;
    this.antiCheat = deps.antiCheat;
    this.mismatches = deps.mismatches;
    this.suspiciousPve = deps.suspiciousPve;
    this.mail = deps.mail;
    this.analytics = deps.analytics;
    this.world = deps.world;
    this.auction = deps.auction;
    this.ladder = deps.ladder;
    this.events = deps.events;
    this.gachaPools = deps.gachaPools;
    this.promo = deps.promo;
    this.now = deps.now;
  }

  protected requireCap(actor: Actor, cap: AdminCapability): void {
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

  protected async actorNames(ids: string[]): Promise<Map<string, string>> {
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

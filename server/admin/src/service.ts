// Admin service core (OPS_DESIGN §2/§3/§5). RBAC + account management + compensation approval ticket flow + audit + monitoring/trends + sampling.
// httpApi handles authentication (admin JWT) + static capability gates; this class enforces business invariants (initiator ≠ approver, quota → approval capability,
// ticket state machine) + audit persistence. All write operations flow through here → single source of truth.
import { randomUUID } from 'node:crypto';
import {
  ADMIN_ROLES,
  capabilitiesForRole,
  hashPassword,
  isAdminRole,
  requiredApproveCapability,
  requiredInitiateCapability,
  roleHasCapability,
  tierForAttachments,
  totalCoinValue,
  validatePassword,
  verifyPassword,
  createLogger,
  FEATURE_FLAGS,
  FLAG_KEYS,
  FLAG_PLATFORMS,
  isFlagKey,
  type AdminAccountView,
  type AdminCapability,
  type AdminRole,
  type AuditAction,
  type AuditEntryView,
  type CompAttachment,
  type CompMailContent,
  type CompScope,
  type CompTarget,
  type CompTicketStatus,
  type CompTicketView,
  type FeatureFlagDoc,
  type FlagKey,
  type FlagPlatform,
  type FlagRollout,
  type LiveStats,
  type MetricKey,
  type TradeAuditSnapshot,
  type TradeAuditTicketStatus,
  type TradeAuditTicketView,
  type TrendPoint,
} from '@nw/shared';
import { METRIC_KEYS } from '@nw/shared';
import type { AdminAccountDoc, AdminCollections, AuditDoc, CompTicketDoc, TradeAuditTicketDoc } from './db';
import type { AnalyticsClient, AnalyticsQueryResult, AntiCheatClient, AntiCheatReviewRow, EventsClient, LadderClient, LadderSeasonInfo, MailDispatcher, MismatchClient, MismatchRow, PlayerClient, PlayerProfile, PlayerSummary, PromoClient, PromoCodeView, StatsClient, SuspiciousPveClient, SuspiciousPveRow, WorldClient, SlgWorldSummary } from './clients';
import type { AuctionAnomaly, EventDoc, EventInput } from '@nw/shared';

const log = createLogger('admin:service');

/** Endpoint error (httpApi maps HTTP status codes based on the status field). */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AdminError';
  }
}

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
  ladder: LadderClient;
  events: EventsClient;
  promo: PromoClient;
  now: () => number;
}

const ALL_TICKET_STATUS: readonly CompTicketStatus[] = [
  'pending',
  'approved',
  'executed',
  'rejected',
  'cancelled',
  'failed',
];

// Login failure rate limiting (OPS_DESIGN §6 "login failure rate limiting"). The admin service holds internal secrets
// and exposes a port to operators, making it a high-value attack target. Uses a per-username sliding-window counter;
// reaching the threshold locks the account for a period. In-memory state (sufficient for a single admin instance;
// migrate to Redis if horizontally scaled).
const LOGIN_MAX_FAILURES = 5; // max failures within the window
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // sliding window for failure counting
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // lockout duration after threshold is reached

interface LoginAttempt {
  fails: number;
  windowStart: number;
  lockedUntil: number;
}

export class AdminService {
  private readonly cols: AdminCollections;
  private readonly stats: StatsClient;
  private readonly players: PlayerClient;
  private readonly antiCheat: AntiCheatClient;
  private readonly mismatches: MismatchClient;
  private readonly suspiciousPve: SuspiciousPveClient;
  private readonly mail: MailDispatcher;
  private readonly analytics: AnalyticsClient;
  private readonly world: WorldClient;
  private readonly ladder: LadderClient;
  private readonly events: EventsClient;
  private readonly promo: PromoClient;
  private readonly now: () => number;
  /** Login failure rate-limit table (keyed by username, in-memory). */
  private readonly loginAttempts = new Map<string, LoginAttempt>();

  constructor(deps: AdminServiceDeps) {
    this.cols = deps.cols;
    this.stats = deps.stats;
    this.players = deps.players;
    this.antiCheat = deps.antiCheat;
    this.mismatches = deps.mismatches;
    this.suspiciousPve = deps.suspiciousPve;
    this.mail = deps.mail;
    this.analytics = deps.analytics;
    this.world = deps.world;
    this.ladder = deps.ladder;
    this.events = deps.events;
    this.promo = deps.promo;
    this.now = deps.now;
  }

  // ───────────────────── Time-limited event management (B6, events.manage) ──────────────────
  /** List all event definitions (including not-yet-started and ended). Returns empty if meta is unreachable. */
  async listEvents(): Promise<EventDoc[]> {
    if (!this.events.available) return [];
    return this.events.list();
  }

  /** Create an event; validation failure on the meta side throws EventsClientError (httpApi maps to 4xx). Audited. */
  async createEvent(actor: Actor, input: EventInput): Promise<EventDoc> {
    const ev = await this.events.create(input);
    await this.audit(actor.adminId, 'event.create', { target: ev._id, summary: ev.title });
    return ev;
  }

  /** Full replacement of an event definition. Audited. */
  async updateEvent(actor: Actor, eventId: string, input: EventInput): Promise<EventDoc> {
    const ev = await this.events.update(eventId, input);
    await this.audit(actor.adminId, 'event.update', { target: ev._id, summary: ev.title });
    return ev;
  }

  /** Delete an event definition. Audited. */
  async deleteEvent(actor: Actor, eventId: string): Promise<void> {
    await this.events.remove(eventId);
    await this.audit(actor.adminId, 'event.delete', { target: eventId });
  }

  // ───────────────────── Promo code management (B-PROMO, promo.manage) ──────────────────────────
  /** List all promo codes; returns an empty list if commercial is unreachable. */
  async listPromoCodes(): Promise<PromoCodeView[]> {
    if (!this.promo.available) return [];
    return this.promo.list();
  }

  /** Create a promo code. Audited. Throws AdminError if commercial is unreachable or the code already exists. */
  async createPromoCode(
    actor: Actor,
    args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string },
  ): Promise<{ code: string }> {
    if (!this.promo.available) throw new AdminError(503, 'promo_unavailable', 'commercial not configured');
    const r = await this.promo.create({ ...args, createdBy: actor.adminId });
    await this.audit(actor.adminId, 'promo.create', { target: r.code, summary: `${args.coins} coins` });
    return r;
  }

  // ───────────────────── Ladder season ops (SE-3) ──────────────────────────
  /** Get current ladder season summary; returns null if meta is unreachable (ops frontend uses this to highlight approaching endAt). */
  async getLadderCurrentSeason(): Promise<LadderSeasonInfo | null> {
    if (!this.ladder.available) return null;
    return this.ladder.getCurrentSeason();
  }

  /** CAS-idempotent advance of the ladder season (open a new season). Audited. */
  async rollLadderSeason(actor: string): Promise<LadderSeasonInfo> {
    const season = await this.ladder.rollSeason();
    await this.audit(actor, 'ladder.season.roll', { summary: `→ s${season.seasonNo}` });
    return season;
  }

  /** List of matches with hash mismatches within the last 24 h (C3, anticheat.view capability). */
  async listMismatches(): Promise<MismatchRow[]> {
    if (!this.mismatches.available) return [];
    return this.mismatches.listMismatches();
  }

  /** C4: list of suspicious accounts with pveWarnings > 0 (anticheat.view capability). */
  async listSuspiciousPve(): Promise<SuspiciousPveRow[]> {
    if (!this.suspiciousPve.available) return [];
    return this.suspiciousPve.listSuspiciousPve();
  }

  /** S4-4: manual account ban (anticheat.action capability). */
  async banAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.suspiciousPve.available) return { ok: false };
    return this.suspiciousPve.banAccount(accountId);
  }

  /** S4-4: manual account unban (anticheat.action capability). */
  async unbanAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.suspiciousPve.available) return { ok: false };
    return this.suspiciousPve.unbanAccount(accountId);
  }

  // ───────────────────── SLG season ops (G7/§17.7) ─────────────────────
  // Proxies worldsvc /admin/world/* + audit + operational sequence constraint (must settle before reset, to prevent loss of history).

  /** List operational summaries for all worlds (capability slg.season.view). Returns empty if worldsvc is unreachable. */
  async slgListWorlds(): Promise<SlgWorldSummary[]> {
    if (!this.world.available) return [];
    return this.world.listWorlds();
  }

  /** Open a new world (high-risk, super only). Audited. */
  async slgOpenSeason(actor: string, worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    await this.world.openWorld(worldId, season, shard, capacity);
    await this.audit(actor, 'slg.season.open', { target: worldId, summary: `s${season}-${shard} cap=${capacity}` });
  }

  /** Settle a world (persist seasonResults + distribute rewards). Audited. */
  async slgSettleSeason(actor: string, worldId: string): Promise<unknown> {
    const r = await this.world.settleWorld(worldId);
    await this.audit(actor, 'slg.season.settle', { target: worldId });
    return r;
  }

  /**
   * Reset a world (wipe data and reopen, high-risk). Operational sequence constraint: the world must have already
   * been settled (status=settling/resetting) before reset is allowed; otherwise the request is rejected
   * (prevents skipping settlement and losing seasonResults history, §17.7). worldsvc enforces the same guard (double safety net).
   */
  async slgResetSeason(actor: string, worldId: string): Promise<unknown> {
    const worlds = await this.world.listWorlds();
    const w = worlds.find((x) => x.worldId === worldId);
    if (w && w.status !== 'settling' && w.status !== 'resetting') {
      throw new AdminError(409, 'conflict', `重置前须先结算（当前 status=${w.status}，应为 settling）`);
    }
    const r = await this.world.resetWorld(worldId);
    await this.audit(actor, 'slg.season.reset', { target: worldId });
    return r;
  }

  /** Close a world (archive it). Audited. */
  async slgCloseSeason(actor: string, worldId: string): Promise<void> {
    await this.world.closeWorld(worldId);
    await this.audit(actor, 'slg.season.close', { target: worldId });
  }

  // ───────────────── SLG anomalous trade audit (G7 anti-RMT, §17.7) ─────────────────
  // worldsvc offline scan detects suspicious seller→buyer pairs; ops files an audit ticket → single-person adjudication (dismiss for false positive / action for confirmed violation).
  // Parallel to compensation tickets: no rewards issued, no two-person approval; review is single-person adjudication + audit trail; enforcement (ban/clawback) follows the external liaison process.

  /** Fetch auction anomaly scan for a world (capability slg.audit.view). Returns empty if worldsvc is unreachable. */
  async slgScanAnomalies(worldId: string, windowSec?: number): Promise<AuctionAnomaly[]> {
    if (!this.world.available) return [];
    return this.world.listAuctionAnomalies(worldId, windowSec);
  }

  /**
   * File an anomalous trade audit ticket (capability slg.audit.manage). Freezes the snapshot + deduplicates by pairKey:
   * if an open ticket already exists for the same pair, returns it directly (idempotent, no duplicate filing). Audited as slg.audit.file.
   */
  async slgFileAuditTicket(actor: Actor, snapshot: TradeAuditSnapshot): Promise<TradeAuditTicketView> {
    const snap = validateAuditSnapshot(snapshot);
    const pairKey = `${snap.worldId}:${snap.sellerId}:${snap.buyerId}`;
    const existing = await this.cols.tradeAuditTickets.findOne({ pairKey, status: 'open' });
    if (existing) return this.toAuditTicketView(existing);
    const doc: TradeAuditTicketDoc = {
      _id: randomUUID(),
      pairKey,
      snapshot: snap,
      status: 'open',
      filedBy: actor.adminId,
      filedAt: this.now(),
    };
    await this.cols.tradeAuditTickets.insertOne(doc);
    await this.audit(actor.adminId, 'slg.audit.file', {
      target: doc._id,
      summary: `${snap.worldId} ${snap.sellerId}→${snap.buyerId} ${snap.severity} coins=${snap.totalCoins}`,
    });
    return this.toAuditTicketView(doc);
  }

  /** List audit tickets (capability slg.audit.view), optionally filtered by status, ordered by filing time descending. */
  async slgListAuditTickets(filter: { status?: string }): Promise<TradeAuditTicketView[]> {
    const q: Partial<Record<'status', TradeAuditTicketStatus>> = {};
    if (filter.status) {
      if (filter.status !== 'open' && filter.status !== 'dismissed' && filter.status !== 'actioned') {
        throw new AdminError(400, 'bad_request', 'invalid status');
      }
      q.status = filter.status;
    }
    const docs = await this.cols.tradeAuditTickets.find(q).sort({ filedAt: -1 }).limit(200).toArray();
    return Promise.all(docs.map((d) => this.toAuditTicketView(d)));
  }

  /**
   * Adjudicate an audit ticket (capability slg.audit.manage): open → dismissed (false positive) / actioned (confirmed violation).
   * Only open tickets can be adjudicated (atomic guard prevents concurrent double-adjudication). Audited as slg.audit.resolve.
   */
  async slgResolveAuditTicket(
    actor: Actor,
    id: string,
    disposition: string,
    note: string,
  ): Promise<TradeAuditTicketView> {
    if (disposition !== 'dismissed' && disposition !== 'actioned') {
      throw new AdminError(400, 'bad_request', 'disposition must be dismissed|actioned');
    }
    const doc = await this.cols.tradeAuditTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'open') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    const trimmedNote = (note ?? '').trim();
    const res = await this.cols.tradeAuditTickets.findOneAndUpdate(
      { _id: id, status: 'open' },
      {
        $set: {
          status: disposition,
          resolvedBy: actor.adminId,
          resolvedAt: this.now(),
          ...(trimmedNote ? { note: trimmedNote } : {}),
        },
      },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer open');
    await this.audit(actor.adminId, 'slg.audit.resolve', {
      target: id,
      summary: `${disposition}${trimmedNote ? `: ${trimmedNote}` : ''}`,
    });
    return this.toAuditTicketView(res);
  }

  private async toAuditTicketView(doc: TradeAuditTicketDoc): Promise<TradeAuditTicketView> {
    const names = await this.actorNames([doc.filedBy, doc.resolvedBy].filter((x): x is string => !!x));
    return {
      id: doc._id,
      snapshot: doc.snapshot,
      status: doc.status,
      filedBy: doc.filedBy,
      ...(names.get(doc.filedBy) ? { filedByName: names.get(doc.filedBy)! } : {}),
      filedAt: doc.filedAt,
      ...(doc.note ? { note: doc.note } : {}),
      ...(doc.resolvedBy ? { resolvedBy: doc.resolvedBy } : {}),
      ...(doc.resolvedBy && names.get(doc.resolvedBy) ? { resolvedByName: names.get(doc.resolvedBy)! } : {}),
      ...(doc.resolvedAt ? { resolvedAt: doc.resolvedAt } : {}),
    };
  }

  // ───────────────────────── Authentication ─────────────────────────

  /** Verify account credentials. Returns the account on success (for httpApi to sign a token); throws AdminError on failure. Audits both success and failure. */
  async authenticate(username: string, password: string, ip?: string): Promise<AdminAccountDoc> {
    const key = (username ?? '').trim().toLowerCase();
    // Rate-limit gate: reject immediately at threshold without even checking the password (prevents brute force + timing side-channel).
    const lockedFor = this.loginLockedMs(key);
    if (lockedFor > 0) {
      await this.audit(`unknown:${username}`, 'login.failed', {
        target: username,
        ...(ip ? { ip } : {}),
        summary: `rate limited (${Math.ceil(lockedFor / 1000)}s left)`,
      });
      throw new AdminError(429, 'too_many_attempts', 'too many failed attempts, try again later');
    }

    const doc = await this.cols.adminAccounts.findOne({ username });
    if (!doc || doc.disabled || !(await verifyPassword(password, doc.passwordHash))) {
      this.recordLoginFailure(key);
      // Do not distinguish between "no such user / wrong password / disabled" externally, to prevent account enumeration; the audit log records the real reason.
      await this.audit(doc?._id ?? `unknown:${username}`, 'login.failed', {
        target: username,
        ...(ip ? { ip } : {}),
        summary: doc ? (doc.disabled ? 'disabled' : 'bad password') : 'no such user',
      });
      throw new AdminError(401, 'invalid_credentials', 'invalid username or password');
    }
    this.loginAttempts.delete(key); // reset counter on success
    await this.cols.adminAccounts.updateOne({ _id: doc._id }, { $set: { lastLoginAt: this.now() } });
    await this.audit(doc._id, 'login', { ...(ip ? { ip } : {}) });
    return doc;
  }

  /** Whether the account is currently locked; returns remaining lockout milliseconds (0 = not locked). */
  private loginLockedMs(key: string): number {
    const a = this.loginAttempts.get(key);
    if (!a) return 0;
    const now = this.now();
    return a.lockedUntil > now ? a.lockedUntil - now : 0;
  }

  /** Record one login failure; resets the counter if outside the window, locks the account when threshold is reached. */
  private recordLoginFailure(key: string): void {
    const now = this.now();
    const a = this.loginAttempts.get(key);
    if (!a || now - a.windowStart > LOGIN_WINDOW_MS) {
      this.loginAttempts.set(key, { fails: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    a.fails += 1;
    if (a.fails >= LOGIN_MAX_FAILURES) {
      a.lockedUntil = now + LOGIN_LOCKOUT_MS;
      a.fails = 0; // reset counter after locking; restarts fresh after the lockout expires
      a.windowStart = now;
    }
  }

  async getAccount(adminId: string): Promise<AdminAccountDoc | null> {
    return this.cols.adminAccounts.findOne({ _id: adminId });
  }

  meView(doc: AdminAccountDoc): { admin: AdminAccountView; capabilities: AdminCapability[] } {
    return { admin: toAccountView(doc), capabilities: capabilitiesForRole(doc.role) };
  }

  // ───────────────────────── Account management (admin.manage) ─────────────────────────

  async listAccounts(): Promise<AdminAccountView[]> {
    const docs = await this.cols.adminAccounts.find({}).sort({ createdAt: 1 }).toArray();
    return docs.map(toAccountView);
  }

  async createAccount(
    actor: Actor,
    input: { username: string; password: string; role: string; displayName: string },
  ): Promise<AdminAccountView> {
    const username = (input.username ?? '').trim();
    if (username.length < 3) throw new AdminError(400, 'bad_request', 'username too short (min 3)');
    if (!isAdminRole(input.role)) throw new AdminError(400, 'bad_request', 'invalid role');
    const pwErr = validatePassword(input.password);
    if (pwErr) throw new AdminError(400, 'bad_request', pwErr);
    const exists = await this.cols.adminAccounts.findOne({ username });
    if (exists) throw new AdminError(409, 'conflict', 'username taken');

    const doc: AdminAccountDoc = {
      _id: randomUUID(),
      username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      displayName: (input.displayName ?? username).trim() || username,
      disabled: false,
      createdAt: this.now(),
      createdBy: actor.adminId,
    };
    try {
      await this.cols.adminAccounts.insertOne(doc);
    } catch (e) {
      // Concurrent unique index violation.
      if ((e as { code?: number }).code === 11000) throw new AdminError(409, 'conflict', 'username taken');
      throw e;
    }
    await this.audit(actor.adminId, 'account.create', {
      target: doc._id,
      summary: `${username} (${doc.role})`,
    });
    return toAccountView(doc);
  }

  async updateAccount(
    actor: Actor,
    id: string,
    patch: { role?: string; disabled?: boolean; displayName?: string },
  ): Promise<AdminAccountView> {
    const doc = await this.cols.adminAccounts.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such account');
    const set: Partial<AdminAccountDoc> = {};
    if (patch.role !== undefined) {
      if (!isAdminRole(patch.role)) throw new AdminError(400, 'bad_request', 'invalid role');
      // Prevent a super admin from demoting themselves, leaving no one who can manage accounts (must always keep at least one active super admin).
      if (doc._id === actor.adminId && patch.role !== 'super') {
        throw new AdminError(400, 'bad_request', 'cannot demote yourself');
      }
      set.role = patch.role;
    }
    if (patch.disabled !== undefined) {
      if (doc._id === actor.adminId && patch.disabled) {
        throw new AdminError(400, 'bad_request', 'cannot disable yourself');
      }
      set.disabled = patch.disabled;
    }
    if (patch.displayName !== undefined) {
      const dn = patch.displayName.trim();
      if (dn) set.displayName = dn;
    }
    if (Object.keys(set).length === 0) return toAccountView(doc);
    await this.cols.adminAccounts.updateOne({ _id: id }, { $set: set });
    await this.audit(actor.adminId, 'account.update', {
      target: id,
      summary: JSON.stringify(set),
    });
    return toAccountView({ ...doc, ...set });
  }

  async resetPassword(actor: Actor, id: string, password: string): Promise<void> {
    const pwErr = validatePassword(password);
    if (pwErr) throw new AdminError(400, 'bad_request', pwErr);
    const doc = await this.cols.adminAccounts.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such account');
    await this.cols.adminAccounts.updateOne(
      { _id: id },
      { $set: { passwordHash: await hashPassword(password) } },
    );
    await this.audit(actor.adminId, 'account.reset_password', { target: id });
  }

  // ───────────────────────── Compensation tickets ─────────────────────────

  async initiateTicket(
    actor: Actor,
    input: { scope: string; target: CompTarget; mail: CompMailContent; reason: string },
  ): Promise<CompTicketView> {
    const scope = input.scope;
    if (scope !== 'single' && scope !== 'global') {
      throw new AdminError(400, 'bad_request', 'scope must be single|global');
    }
    // Validate initiation capability (single player vs. all players).
    this.requireCap(actor, requiredInitiateCapability(scope));

    const reason = (input.reason ?? '').trim();
    if (!reason) throw new AdminError(400, 'bad_request', 'reason required');
    const mail = validateMail(input.mail);
    const target = validateTarget(scope, input.target);

    // Single-player compensation is tiered by total attachment value; global compensation always requires super-admin approval (amountTier is audit semantics only; the capability is determined by scope).
    const amountTier = scope === 'global' ? 'overquota' : tierForAttachments(mail.attachments);

    const doc: CompTicketDoc = {
      _id: randomUUID(),
      scope,
      target,
      mail,
      reason,
      status: 'pending',
      amountTier,
      initiatedBy: actor.adminId,
      initiatedAt: this.now(),
      dispatchKey: randomUUID(),
    };
    await this.cols.compTickets.insertOne(doc);
    await this.audit(actor.adminId, 'comp.initiate', {
      target: doc._id,
      summary: `${scope} ${describeTarget(target)} value=${totalCoinValue(mail.attachments)} tier=${amountTier}`,
    });
    return this.toTicketView(doc);
  }

  async listTickets(filter: { status?: string }): Promise<CompTicketView[]> {
    const q: Partial<Record<'status', CompTicketStatus>> = {};
    if (filter.status) {
      if (!ALL_TICKET_STATUS.includes(filter.status as CompTicketStatus)) {
        throw new AdminError(400, 'bad_request', 'invalid status');
      }
      q.status = filter.status as CompTicketStatus;
    }
    const docs = await this.cols.compTickets.find(q).sort({ initiatedAt: -1 }).limit(200).toArray();
    return Promise.all(docs.map((d) => this.toTicketView(d)));
  }

  /**
   * Approve → auto-execute (OPS_DESIGN §3.3). Validates: ① ticket is pending; ② approver ≠ initiator;
   * ③ approver has the capability required for this scope/tier. On passing, sets status to approved and immediately executes (dispatches the system mail).
   */
  async approveTicket(actor: Actor, id: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    const cap = requiredApproveCapability(doc.scope, doc.amountTier);
    // Four-eyes principle: the initiator must not approve their own ticket. However, if there are no other eligible approvers for this ticket
    // (typical case: only one super admin exists, and global/over-quota tickets can only be approved by super), strict four-eyes would cause permanent deadlock.
    // Therefore, self-approval is only blocked when another eligible approver exists; otherwise self-approval is permitted and explicitly flagged (selfApproved).
    // TODO(single-super-exception): remove this exception once a second operator with the corresponding approval capability is on-boarded, restoring hard initiator ≠ approver enforcement.
    let selfApproved = false;
    if (doc.initiatedBy === actor.adminId) {
      if (await this.hasOtherEligibleApprover(doc.initiatedBy, cap)) {
        throw new AdminError(403, 'forbidden', 'initiator cannot approve own ticket');
      }
      selfApproved = true;
    }
    this.requireCap(actor, cap);

    const res = await this.cols.compTickets.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', approvedBy: actor.adminId, approvedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
    await this.audit(actor.adminId, 'comp.approve', {
      target: id,
      summary: selfApproved ? `${doc.scope} [SELF-APPROVED:no-other-approver]` : doc.scope,
    });

    return this.execute(res);
  }

  /**
   * Whether there is another admin — other than the initiator, currently active (not disabled), and possessing the given approval capability.
   * Determines whether four-eyes can be enforced: present → another person must approve; absent → self-approval allowed (single-super exception, see approveTicket).
   */
  private async hasOtherEligibleApprover(initiatorId: string, cap: AdminCapability): Promise<boolean> {
    const eligibleRoles = ADMIN_ROLES.filter((r) => roleHasCapability(r, cap));
    const count = await this.cols.adminAccounts.countDocuments({
      _id: { $ne: initiatorId },
      disabled: { $ne: true },
      // Seed super-admins are dormant backup/bootstrap accounts, not active operators; exclude them (otherwise the seed would always block a single super from self-approving).
      seed: { $ne: true },
      role: { $in: eligibleRoles },
    });
    return count > 0;
  }

  async rejectTicket(actor: Actor, id: string, note: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    if (doc.initiatedBy === actor.adminId) {
      throw new AdminError(403, 'forbidden', 'initiator cannot reject own ticket');
    }
    this.requireCap(actor, requiredApproveCapability(doc.scope, doc.amountTier));
    const res = await this.cols.compTickets.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'rejected', approvedBy: actor.adminId, approvedAt: this.now(), error: note } },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
    await this.audit(actor.adminId, 'comp.reject', { target: id, summary: note });
    return this.toTicketView(res);
  }

  /** Cancel a ticket (pending only; initiator or super admin). */
  async cancelTicket(actor: Actor, id: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    if (doc.initiatedBy !== actor.adminId && actor.role !== 'super') {
      throw new AdminError(403, 'forbidden', 'only initiator or super can cancel');
    }
    const res = await this.cols.compTickets.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'cancelled', approvedBy: actor.adminId, approvedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
    await this.audit(actor.adminId, 'comp.cancel', { target: id });
    return this.toTicketView(res);
  }

  /** Dry-run preview of how many players a global compensation would reach (OPS_DESIGN §3.3 safety valve). */
  async preview(input: { scope: string; target: CompTarget }): Promise<{ recipientCount: number; available: boolean }> {
    if (input.scope !== 'single' && input.scope !== 'global') {
      throw new AdminError(400, 'bad_request', 'scope must be single|global');
    }
    const target = validateTarget(input.scope, input.target);
    if (input.scope === 'single') return { recipientCount: 1, available: true };
    const r = await this.mail.preview({ scope: 'global', target });
    return { recipientCount: r.recipientCount, available: r.ok };
  }

  /** Retry a failed ticket execution (failed → re-dispatch; dispatchKey is unchanged, so the mail backend prevents duplicates). */
  async retryTicket(actor: Actor, id: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'failed') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    this.requireCap(actor, requiredApproveCapability(doc.scope, doc.amountTier));
    return this.execute(doc);
  }

  /**
   * Executor: calls the meta system-mail endpoint (idempotent via dispatchKey). On success sets status to executed (backfills recipientCount);
   * on failure sets status to failed (retryable). Execution ≠ credit — it only delivers the mail to the player's inbox; the reward is credited via commercial/inventory when the player claims it.
   */
  private async execute(doc: CompTicketDoc): Promise<CompTicketView> {
    const res = await this.mail.send({
      dispatchKey: doc.dispatchKey,
      scope: doc.scope,
      target: doc.target,
      subject: doc.mail.subject,
      body: doc.mail.body,
      attachments: doc.mail.attachments,
      expireDays: doc.mail.expireDays,
    });
    if (res.ok) {
      const updated = await this.cols.compTickets.findOneAndUpdate(
        { _id: doc._id },
        {
          $set: {
            status: 'executed',
            executedAt: this.now(),
            ...(typeof res.recipientCount === 'number' ? { recipientCount: res.recipientCount } : {}),
          },
          $unset: { error: '' },
        },
        { returnDocument: 'after' },
      );
      await this.audit(doc.initiatedBy, 'comp.execute', {
        target: doc._id,
        summary: `recipients=${res.recipientCount ?? '?'}`,
      });
      return this.toTicketView(updated ?? doc);
    }
    const err = res.error ?? 'mail dispatch failed';
    const updated = await this.cols.compTickets.findOneAndUpdate(
      { _id: doc._id },
      { $set: { status: 'failed', error: err } },
      { returnDocument: 'after' },
    );
    log.warn('ticket execute failed', { ticketId: doc._id, err });
    await this.audit(doc.initiatedBy, 'comp.execute.failed', { target: doc._id, summary: err });
    return this.toTicketView(updated ?? { ...doc, status: 'failed', error: err });
  }

  // ───────────────────────── Audit ─────────────────────────

  /**
   * Audit query. audit.view.all → all entries (optionally filtered by actor); otherwise only the caller's own entries (audit.view.self).
   * httpApi has already verified "at least audit.view.self"; this method further narrows the visible range based on capability.
   */
  async listAudit(
    actor: Actor,
    filter: { actor?: string; from?: number; to?: number },
  ): Promise<AuditEntryView[]> {
    const canAll = roleHasCapability(actor.role, 'audit.view.all');
    const q: Record<string, unknown> = {};
    if (canAll) {
      if (filter.actor) q.actor = filter.actor;
    } else {
      q.actor = actor.adminId; // force visibility to own entries only
    }
    if (filter.from !== undefined || filter.to !== undefined) {
      const ts: Record<string, number> = {};
      if (filter.from !== undefined) ts.$gte = filter.from;
      if (filter.to !== undefined) ts.$lte = filter.to;
      q.ts = ts;
    }
    const docs = await this.cols.auditLog.find(q).sort({ ts: -1 }).limit(500).toArray();
    const names = await this.actorNames(docs.map((d) => d.actor));
    return docs.map((d) => ({
      id: d._id,
      actor: d.actor,
      ...(names.get(d.actor) ? { actorName: names.get(d.actor)! } : {}),
      action: d.action,
      ...(d.target ? { target: d.target } : {}),
      ...(d.summary ? { summary: d.summary } : {}),
      ...(d.ip ? { ip: d.ip } : {}),
      ts: d.ts,
    }));
  }

  // ───────────────────────── Monitoring / trends / analytics ─────────────────────────

  async liveStats(): Promise<LiveStats & { available: boolean }> {
    const live = await this.stats.fetchLive();
    return { ...live, available: this.stats.available };
  }

  async trend(input: { metric: string; from?: number; to?: number }): Promise<TrendPoint[]> {
    if (!METRIC_KEYS.includes(input.metric as MetricKey)) {
      throw new AdminError(400, 'bad_request', 'invalid metric');
    }
    const q: Record<string, unknown> = { metric: input.metric };
    if (input.from !== undefined || input.to !== undefined) {
      const ts: Record<string, number> = {};
      if (input.from !== undefined) ts.$gte = input.from;
      if (input.to !== undefined) ts.$lte = input.to;
      q.ts = ts;
    }
    const docs = await this.cols.metricSnapshots
      .find(q)
      .sort({ ts: 1 })
      .limit(2000)
      .toArray();
    return docs.map((d) => ({ ts: d.ts, value: d.value }));
  }

  /** Analytics overview (aggregated self-collected metrics + ticket status counts). */
  async analyticsSummary(): Promise<{
    live: LiveStats & { available: boolean };
    last24h: Record<MetricKey, { avg: number; peak: number; samples: number }>;
    tickets: Record<CompTicketStatus, number>;
  }> {
    const live = await this.liveStats();
    const since = this.now() - 24 * 3600 * 1000;
    const last24h = {} as Record<MetricKey, { avg: number; peak: number; samples: number }>;
    for (const metric of METRIC_KEYS) {
      const docs = await this.cols.metricSnapshots
        .find({ metric, ts: { $gte: since } })
        .toArray();
      const samples = docs.length;
      const sum = docs.reduce((s, d) => s + d.value, 0);
      const peak = docs.reduce((m, d) => Math.max(m, d.value), 0);
      last24h[metric] = { avg: samples ? sum / samples : 0, peak, samples };
    }
    const tickets = {} as Record<CompTicketStatus, number>;
    for (const st of ALL_TICKET_STATUS) {
      tickets[st] = await this.cols.compTickets.countDocuments({ status: st });
    }
    return { live, last24h, tickets };
  }

  /** Aggregated analytics query (proxied to analyticsvc /internal/query, A9-6). */
  async analyticsQuery(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult & { available: boolean }> {
    if (!this.analytics.available) return { available: false };
    const result = await this.analytics.query(type, days, platform);
    return { ...result, available: true };
  }

  /** Player lookup (player.lookup). */
  async lookupPlayer(publicId: string): Promise<PlayerProfile> {
    const pid = (publicId ?? '').trim();
    if (!/^\d{9}$/.test(pid)) throw new AdminError(400, 'bad_request', 'publicId must be 9 digits');
    if (!this.players.available) {
      throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
    }
    const p = await this.players.lookupByPublicId(pid);
    if (!p) throw new AdminError(404, 'not_found', 'no such player');
    return p;
  }

  /** Look up player details by accountId (player.lookup; called after clicking a fuzzy-search result for details). */
  async lookupPlayerByAccountId(accountId: string): Promise<PlayerProfile> {
    const id = (accountId ?? '').trim();
    if (!id) throw new AdminError(400, 'bad_request', 'accountId required');
    if (!this.players.available) {
      throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
    }
    const p = await this.players.lookupByAccountId(id);
    if (!p) throw new AdminError(404, 'not_found', 'no such player');
    return p;
  }

  /** Fuzzy player search (player.lookup): by display name / login name / public id / accountId; returns a list of matching summaries. Audited. */
  async searchPlayers(actor: string, q: string): Promise<PlayerSummary[]> {
    const term = (q ?? '').trim();
    if (term.length < 2) throw new AdminError(400, 'bad_request', 'query too short (min 2)');
    if (!this.players.available) {
      throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
    }
    const rows = await this.players.search(term, 20);
    await this.audit(actor, 'player.search', { summary: `q=${term} → ${rows.length} hits` });
    return rows;
  }

  /** Achievement anti-cheat review queue (anticheat.view, S9-7). Defaults to open status; can be filtered by accountId. Audited. */
  async listAntiCheatReviews(
    actor: string,
    opts: { accountId?: string; status?: string; limit?: number } = {},
  ): Promise<AntiCheatReviewRow[]> {
    if (!this.antiCheat.available) {
      throw new AdminError(503, 'unavailable', 'anti-cheat backend unavailable');
    }
    const rows = await this.antiCheat.listReviews(opts);
    await this.audit(actor, 'anticheat.view', {
      ...(opts.accountId ? { target: opts.accountId } : {}),
      summary: `${rows.length} reviews (status=${opts.status ?? 'open'})`,
    });
    return rows;
  }

  // ───────────────────────── Sampling (OPS_DESIGN §5) ─────────────────────────

  /** Take one live-state time-series snapshot (called by the sampling timer). Records 0 on error (sampling must not be interrupted). */
  async sampleOnce(): Promise<void> {
    const live = await this.stats.fetchLive();
    const ts = this.now();
    const at = new Date(ts);
    const vals: Record<MetricKey, number> = {
      online: live.online,
      queue: live.queue,
      rooms: live.rooms,
      gameInstances: live.gameInstances,
      gameLoad: live.gameLoad ?? 0,
    };
    await this.cols.metricSnapshots.insertMany(
      METRIC_KEYS.map((metric) => ({ metric, ts, value: vals[metric], at })),
    );
  }

  // ───────────────────── Feature flags (§5) ─────────────────────
  // admin is the "processing hub": the only service that touches the flags collection, the only writer, and the sole internal source of raw rules.
  // Operators flip switches in ops → upsertFlag writes to the DB + audits; backends that do not connect to the DB poll getInternalFlags() to retrieve raw rules and evaluate them locally.

  /**
   * List all allowlisted flags with their current override rules and defaults (capability config.manage, used by the ops list view).
   * Flags that have never been overridden have doc=null; the frontend displays them as "default".
   */
  async getConfigFlags(): Promise<
    Array<{ key: FlagKey; default: boolean; desc: string; side: string; doc: FeatureFlagDoc | null }>
  > {
    const docs = await this.cols.featureFlags.find({}).toArray();
    const byKey = new Map(docs.map((d) => [d._id, d]));
    return FLAG_KEYS.map((key) => ({
      key,
      default: FEATURE_FLAGS[key].default,
      desc: FEATURE_FLAGS[key].desc,
      side: FEATURE_FLAGS[key].side,
      doc: byKey.get(key) ?? null,
    }));
  }

  /** All raw flag rules (for the admin internal endpoint GET /admin/internal/flags; not evaluated — returned as-is for consumers to evaluate locally). */
  async getInternalFlags(): Promise<FeatureFlagDoc[]> {
    return this.cols.featureFlags.find({}).toArray();
  }

  /**
   * Write/update a flag rule (capability config.manage). Validates that key is in the allowlist and that pct/platform values are legal;
   * writes to auditLog on every change (actor / before+after values / timestamp), consistent with compensation approval auditing.
   */
  async upsertFlag(
    actor: Actor,
    key: string,
    input: { enabled?: boolean; rollout?: unknown; desc?: string },
  ): Promise<FeatureFlagDoc> {
    if (!isFlagKey(key)) throw new AdminError(400, 'bad_request', `unknown flag key: ${key}`);
    const before = await this.cols.featureFlags.findOne({ _id: key });
    const rollout = validateRollout(input.rollout);
    const doc: FeatureFlagDoc = {
      _id: key,
      enabled: input.enabled !== false, // defaults to enabled; only an explicit false turns it off
      ...(rollout ? { rollout } : {}),
      ...(typeof input.desc === 'string' && input.desc.trim() ? { desc: input.desc.trim() } : {}),
      updatedAt: this.now(),
      updatedBy: actor.adminId,
    };
    await this.cols.featureFlags.replaceOne({ _id: key }, doc, { upsert: true });
    await this.audit(actor.adminId, 'config.update', {
      target: key,
      summary: `${describeFlag(before)} → ${describeFlag(doc)}`,
    });
    return doc;
  }

  // ───────────────────────── Internal helpers ─────────────────────────

  private requireCap(actor: Actor, cap: AdminCapability): void {
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

  private async actorNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)].filter((x) => !x.startsWith('unknown:'));
    const out = new Map<string, string>();
    if (uniq.length === 0) return out;
    const docs = await this.cols.adminAccounts
      .find({ _id: { $in: uniq } }, { projection: { displayName: 1, username: 1 } })
      .toArray();
    for (const d of docs) out.set(d._id, d.displayName || d.username);
    return out;
  }

  private async toTicketView(doc: CompTicketDoc): Promise<CompTicketView> {
    const names = await this.actorNames(
      [doc.initiatedBy, doc.approvedBy].filter((x): x is string => !!x),
    );
    return {
      id: doc._id,
      scope: doc.scope,
      target: doc.target,
      mail: doc.mail,
      reason: doc.reason,
      status: doc.status,
      amountTier: doc.amountTier,
      initiatedBy: doc.initiatedBy,
      ...(names.get(doc.initiatedBy) ? { initiatedByName: names.get(doc.initiatedBy)! } : {}),
      initiatedAt: doc.initiatedAt,
      ...(doc.approvedBy ? { approvedBy: doc.approvedBy } : {}),
      ...(doc.approvedBy && names.get(doc.approvedBy) ? { approvedByName: names.get(doc.approvedBy)! } : {}),
      ...(doc.approvedAt ? { approvedAt: doc.approvedAt } : {}),
      ...(doc.executedAt ? { executedAt: doc.executedAt } : {}),
      ...(typeof doc.recipientCount === 'number' ? { recipientCount: doc.recipientCount } : {}),
      ...(doc.error ? { error: doc.error } : {}),
    };
  }
}

// ── Pure function helpers ──────────────────────────────────────────
function toAccountView(doc: AdminAccountDoc): AdminAccountView {
  return {
    id: doc._id,
    username: doc.username,
    role: doc.role,
    displayName: doc.displayName,
    disabled: doc.disabled,
    createdAt: doc.createdAt,
    ...(doc.createdBy ? { createdBy: doc.createdBy } : {}),
    ...(doc.lastLoginAt ? { lastLoginAt: doc.lastLoginAt } : {}),
  };
}

function validateAuditSnapshot(s: TradeAuditSnapshot | undefined): TradeAuditSnapshot {
  if (!s || typeof s !== 'object') throw new AdminError(400, 'bad_request', 'snapshot required');
  const worldId = (s.worldId ?? '').trim();
  const sellerId = (s.sellerId ?? '').trim();
  const buyerId = (s.buyerId ?? '').trim();
  if (!worldId || !sellerId || !buyerId) {
    throw new AdminError(400, 'bad_request', 'snapshot requires worldId/sellerId/buyerId');
  }
  if (sellerId === buyerId) throw new AdminError(400, 'bad_request', 'seller and buyer must differ');
  const severity = s.severity === 'high' ? 'high' : 'medium';
  const allowed = new Set(['repeated', 'designated', 'high_value']);
  const reasons = (Array.isArray(s.reasons) ? s.reasons : []).filter((r) => allowed.has(r));
  const num = (v: unknown): number => (Number.isFinite(v as number) && (v as number) >= 0 ? Math.floor(v as number) : 0);
  return {
    worldId,
    sellerId,
    buyerId,
    trades: num(s.trades),
    designatedTrades: num(s.designatedTrades),
    totalCoins: num(s.totalCoins),
    firstTs: num(s.firstTs),
    lastTs: num(s.lastTs),
    severity,
    reasons,
  };
}

function validateMail(mail: CompMailContent | undefined): CompMailContent {
  if (!mail || typeof mail !== 'object') throw new AdminError(400, 'bad_request', 'mail required');
  const subject = (mail.subject ?? '').trim();
  const body = (mail.body ?? '').trim();
  if (!subject) throw new AdminError(400, 'bad_request', 'mail subject required');
  if (!body) throw new AdminError(400, 'bad_request', 'mail body required');
  const attachments: CompAttachment[] = Array.isArray(mail.attachments) ? mail.attachments : [];
  for (const a of attachments) {
    if (a.kind !== 'coins' && a.kind !== 'item' && a.kind !== 'skin') {
      throw new AdminError(400, 'bad_request', 'invalid attachment kind');
    }
    if ((a.kind === 'item' || a.kind === 'skin') && !a.id) {
      throw new AdminError(400, 'bad_request', `${a.kind} attachment requires id`);
    }
    if (a.count !== undefined && (!Number.isFinite(a.count) || a.count < 0)) {
      throw new AdminError(400, 'bad_request', 'invalid attachment count');
    }
  }
  const expireDays = Number.isFinite(mail.expireDays) && mail.expireDays > 0 ? Math.floor(mail.expireDays) : 30;
  return { subject, body, attachments, expireDays };
}

function validateTarget(scope: CompScope, target: CompTarget | undefined): CompTarget {
  if (scope === 'single') {
    const pid = (target as { publicId?: string } | undefined)?.publicId;
    if (typeof pid !== 'string' || !/^\d{9}$/.test(pid.trim())) {
      throw new AdminError(400, 'bad_request', 'single target requires 9-digit publicId');
    }
    return { publicId: pid.trim() };
  }
  // global: phase 1 supports only "all".
  return { filter: { kind: 'all' } };
}

function describeTarget(target: CompTarget): string {
  return 'publicId' in target ? `#${target.publicId}` : `filter:${target.filter.kind}`;
}

/** Validate and normalise a flag targeting rule (out-of-range / invalid values throw 400 directly — stricter than player-facing config, to prevent misconfiguration). */
function validateRollout(raw: unknown): FlagRollout | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new AdminError(400, 'bad_request', 'rollout must be an object');
  const o = raw as Record<string, unknown>;
  const out: FlagRollout = {};
  if (o.pct !== undefined) {
    if (typeof o.pct !== 'number' || !Number.isFinite(o.pct) || o.pct < 0 || o.pct > 100) {
      throw new AdminError(400, 'bad_request', 'rollout.pct must be 0-100');
    }
    out.pct = Math.floor(o.pct);
  }
  const strArr = (v: unknown, field: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new AdminError(400, 'bad_request', `rollout.${field} must be string[]`);
    }
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  };
  const regions = strArr(o.regions, 'regions');
  if (regions && regions.length) out.regions = regions;
  const platforms = strArr(o.platforms, 'platforms');
  if (platforms) {
    for (const p of platforms) {
      if (!(FLAG_PLATFORMS as readonly string[]).includes(p)) {
        throw new AdminError(400, 'bad_request', `invalid platform: ${p}`);
      }
    }
    if (platforms.length) out.platforms = platforms as FlagPlatform[];
  }
  const allow = strArr(o.allowAccounts, 'allowAccounts');
  if (allow && allow.length) out.allowAccounts = allow;
  const deny = strArr(o.denyAccounts, 'denyAccounts');
  if (deny && deny.length) out.denyAccounts = deny;
  const allowPublicIds = strArr(o.allowPublicIds, 'allowPublicIds');
  if (allowPublicIds && allowPublicIds.length) out.allowPublicIds = allowPublicIds;
  return Object.keys(out).length ? out : undefined;
}

/** Audit summary: compact description of a flag's state (used for before/after comparison). */
function describeFlag(doc: FeatureFlagDoc | null): string {
  if (!doc) return 'default';
  const r = doc.rollout;
  const parts = [doc.enabled ? 'on' : 'OFF'];
  if (r?.pct !== undefined) parts.push(`${r.pct}%`);
  if (r?.regions?.length) parts.push(`region=${r.regions.join('|')}`);
  if (r?.platforms?.length) parts.push(`plat=${r.platforms.join('|')}`);
  if (r?.allowAccounts?.length) parts.push(`allow=${r.allowAccounts.length}`);
  if (r?.denyAccounts?.length) parts.push(`deny=${r.denyAccounts.length}`);
  if (r?.allowPublicIds?.length) parts.push(`allowPid=${r.allowPublicIds.length}`);
  return parts.join(',');
}

export { ADMIN_ROLES };

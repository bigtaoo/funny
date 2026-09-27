// Per-world scheduler leases (2026-09-26, WORLDSVC_CONCURRENCY_AUDIT §12.7 phase 3 / §12.12).
//
// The scheduler (scheduler.ts) scans every world's due marches, sieges, occupations, training and builds. With
// one worldsvc process that is exactly right. With two, both scan the same due lists: the claims added in phase 1
// (§12.10) keep that CORRECT — every settlement is claimed atomically, so nothing is settled twice — but each
// process does the other's reads, and they spend their time losing claims to each other. This module divides the
// worlds between the live processes so each one scans only its own.
//
// How ownership is decided: rendezvous hashing. Every process writes a presence doc; every process can therefore
// list the live ones and compute, for each world, the process with the highest `hash(instance, world)`. That
// process wants the world, every other one lets go of it. No coordination beyond the shared list is needed, and a
// process joining or leaving moves only the worlds it wins or held, not a reshuffle of everything.
//
// Leases are documents in `schedulerLeases`, one per world, with a holder and an expiry. The TTL is shared with
// the presence docs, so a crashed process's worlds free up at the same moment it drops out of the live list —
// the next winner is computed without it and takes them over. A clean shutdown releases everything at once.
//
// What a lease does NOT promise: exclusivity. A process that has just let go may still be finishing a pass over
// that world while the new owner starts one; a paused process may keep scanning past its expiry. Both are safe
// for the reason above — the lease is an efficiency mechanism layered on claims that are already correct — so
// there is no fencing token and there does not need to be one.
//
// Off by default (NW_SLG_WORLD_LEASE=1 turns it on): a single process gains nothing from it, and a lease left by
// a crashed previous process would stall that world's scheduling for up to one TTL after a restart.
import { createHash } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { WorldDoc } from './db';
import { INSTANCE_ID } from './instance';
import { bumpCounter } from './metrics';

/** One doc per world (`kind: 'world'`, `_id` = `w:<worldId>`) and one per live process (`kind: 'instance'`). */
export interface SchedulerLeaseDoc {
  _id: string;
  kind: 'world' | 'instance';
  holder: string;
  /** Epoch ms after which the lease / presence no longer counts. */
  until: number;
  worldId?: string;
}

/** How often a process renews its presence and leases and re-evaluates which worlds it should hold. */
export const LEASE_RENEW_MS = 5_000;
/** Presence and lease lifetime. Four renewals: one slow round (a GC pause, a Mongo failover) must not drop them. */
export const LEASE_TTL_MS = 20_000;
/**
 * How long before its recorded expiry a process stops treating a lease as its own. Another process can take the
 * world only once the expiry has passed, so stopping this much earlier leaves a clean gap even with some clock
 * skew between the two hosts.
 */
const LOCAL_MARGIN_MS = 3_000;

export interface WorldLeaseOptions {
  leases: Collection<SchedulerLeaseDoc>;
  worlds: Collection<WorldDoc>;
  instanceId?: string;
  now?: () => number;
}

/** Rendezvous weight of `instance` for `world`: the live instance with the highest weight should hold the world. */
export function leaseWeight(instance: string, world: string): number {
  return createHash('sha1').update(`${instance}|${world}`).digest().readUInt32BE(0);
}

/** The live instance that should hold `world` (ties, astronomically rare, go to the smaller id). */
export function preferredHolder(instances: readonly string[], world: string): string | undefined {
  let best: string | undefined;
  let bestW = -1;
  for (const i of instances) {
    const w = leaseWeight(i, world);
    if (w > bestW || (w === bestW && best !== undefined && i < best)) {
      best = i;
      bestW = w;
    }
  }
  return best;
}

const worldKey = (worldId: string) => `w:${worldId}`;
const instanceKey = (instanceId: string) => `i:${instanceId}`;

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === 11000;
}

export class WorldLeases {
  readonly instanceId: string;
  private readonly now: () => number;
  /** worldId → the local expiry (recorded expiry minus the margin). Only this set is read by the scheduler. */
  private held = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private round: Promise<void> | null = null;

  constructor(private readonly opts: WorldLeaseOptions) {
    this.instanceId = opts.instanceId ?? INSTANCE_ID;
    this.now = opts.now ?? Date.now;
  }

  /** The worlds this process currently holds — what every scheduler task restricts its scan to. */
  owned(): string[] {
    const t = this.now();
    return [...this.held].filter(([, until]) => until > t).map(([w]) => w).sort();
  }

  /** Run the first round now (so the scheduler starts with its worlds), then renew every LEASE_RENEW_MS. */
  async start(): Promise<void> {
    await this.renew();
    this.timer = setInterval(() => {
      void this.renew().catch((e) => console.error('[world-lease] renew failed:', (e as Error).message));
    }, LEASE_RENEW_MS);
    this.timer.unref?.();
  }

  /** Stop renewing and hand every world back at once, so the next owner need not wait out the TTL. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.round?.catch(() => {});
    this.held.clear();
    await this.opts.leases.deleteMany({ holder: this.instanceId });
  }

  /** One renewal round. Rounds never overlap: a call while one is running waits for it instead. */
  renew(): Promise<void> {
    if (this.round) return this.round;
    this.round = this.doRenew().finally(() => {
      this.round = null;
    });
    return this.round;
  }

  private async doRenew(): Promise<void> {
    const { leases, worlds } = this.opts;
    const me = this.instanceId;
    const t = this.now();
    const until = t + LEASE_TTL_MS;

    await leases.updateOne({ _id: instanceKey(me) }, { $set: { kind: 'instance', holder: me, until } }, { upsert: true });
    const [live, , worldDocs, leaseDocs] = await Promise.all([
      leases.find({ kind: 'instance', until: { $gt: t } }, { projection: { holder: 1 } }).toArray(),
      // Every restart is a new instance id, so a crashed process's presence doc would otherwise stay forever.
      // Kept one extra TTL past expiry only so that a doc is never removed while someone might still count it.
      leases.deleteMany({ kind: 'instance', until: { $lt: t - LEASE_TTL_MS } }),
      // Closed worlds are done: nothing in them is due, and leasing them would cost a write per round forever.
      worlds.find({ status: { $ne: 'closed' } }, { projection: { _id: 1 } }).toArray(),
      leases.find({ kind: 'world' }).toArray(),
    ]);
    const instances = [...new Set([me, ...live.map((d) => d.holder)])];
    const leaseOf = new Map(leaseDocs.map((d) => [d.worldId ?? d._id.slice(2), d]));

    const keep: string[] = [];
    const release: string[] = [];
    const acquire: string[] = [];
    for (const { _id: worldId } of worldDocs) {
      const mine = preferredHolder(instances, worldId) === me;
      const lease = leaseOf.get(worldId);
      const heldByMe = lease?.holder === me && lease.until > t;
      if (heldByMe) (mine ? keep : release).push(worldId);
      else if (mine && (!lease || lease.until <= t)) acquire.push(worldId);
      // else: someone else's live lease. If it is ours by preference they will release it on their next
      // round (they see the same live list) and we pick it up on ours.
    }
    // Leases this process still holds on worlds that no longer qualify (closed, deleted) are simply dropped.
    const known = new Set(worldDocs.map((w) => w._id));
    const stale = [...leaseOf].filter(([w, d]) => d.holder === me && !known.has(w)).map(([w]) => w);

    // Let go locally BEFORE the write: from here on this process no longer schedules these worlds.
    for (const w of [...release, ...stale]) this.held.delete(w);
    if (release.length + stale.length) {
      await leases.deleteMany({ _id: { $in: [...release, ...stale].map(worldKey) }, holder: me });
    }
    if (keep.length) {
      await leases.updateMany({ _id: { $in: keep.map(worldKey) }, holder: me }, { $set: { until } });
    }
    await Promise.all(
      acquire.map(async (worldId) => {
        try {
          // Matches only a free (expired) lease; on a live one the filter misses, the upsert tries to insert
          // the same _id, and the unique index turns that into "someone else has it".
          await leases.updateOne(
            { _id: worldKey(worldId), until: { $lte: t } },
            { $set: { kind: 'world', worldId, holder: me, until } },
            { upsert: true },
          );
        } catch (e) {
          if (!isDuplicateKey(e)) throw e;
        }
      }),
    );

    // The authoritative answer is what the collection now says, not what this round attempted: a renewal whose
    // lease was taken over (after a stall past its expiry) must drop out, and a lost acquisition race too.
    const nowHeld = await leases.find({ kind: 'world', holder: me, until: { $gt: t } }).toArray();
    const next = new Map(nowHeld.map((d) => [d.worldId ?? d._id.slice(2), d.until - LOCAL_MARGIN_MS]));
    const gained = [...next.keys()].filter((w) => !this.held.has(w));
    const lost = [...this.held.keys()].filter((w) => !next.has(w));
    this.held = next;
    bumpCounter('lease.acquired', gained.length);
    bumpCounter('lease.released', release.length + stale.length + lost.length);
    if (gained.length || lost.length || release.length) {
      console.log('[world-lease] holding', { instance: me, worlds: this.owned(), gained, released: [...release, ...lost] });
    }
  }
}

/** The Mongo filter fragment restricting a scheduler scan to `worldIds`; empty when the scan is unscoped. */
export function worldScope(worldIds?: readonly string[]): { worldId?: { $in: string[] } } {
  return worldIds ? { worldId: { $in: [...worldIds] } } : {};
}

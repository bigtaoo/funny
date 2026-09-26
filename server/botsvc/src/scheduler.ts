// Session scheduler (BOTSVC_DESIGN §3.1, §4): keeps online count near a target that follows a European
// day and ramps down under capacity pressure, rotating which bots are online (20–60 minute sessions)
// instead of pretending a fixed-size crowd stays logged in forever.
import { CapacityClient, shedTarget } from './capacityClient';
import { BotSession, type PveCounters } from './bot';
import { diurnalTarget, sessionLength } from './rotation';

/** Which step of a session's upkeep chain failed (see Scheduler.upkeepErrors). */
type UpkeepKind = 'family' | 'slg' | 'pve';

/** Rolled-up upkeep-failure warnings are emitted at most this often, however many bots are failing. */
const UPKEEP_ERROR_LOG_INTERVAL_MS = 60_000;

export interface SchedulerOptions {
  targetOnline: number;
  shedStartAt: number;
  shedFullAt: number;
  /** Max sessions started/stopped per tick — avoids a login/logout stampede that would itself look unlike real traffic. */
  batchSize: number;
  /** Max concurrent per-session upkeep chains (family+SLG) per tick — see the tick() note on why this is bounded, not serial and not unbounded. */
  upkeepConcurrency: number;
  /** Ticks needed to cycle every online session through one upkeep pass (see runUpkeep()). */
  upkeepRotations: number;
  /**
   * Rotation (BOTSVC_DESIGN §3.1): scale targetOnline (then the evening peak) by the European day curve
   * and end every session after 20–60 minutes. Off = the old fixed crowd, for load tests that want a
   * flat fleet.
   */
  rotation?: boolean;
  /** Injected for tests. */
  now?: () => number;
  random?: () => number;
}

export class Scheduler {
  private readonly online = new Set<BotSession>();
  /** When each online session's login is up (sessionLength); only read with `rotation` on. */
  private readonly sessionEnds = new Map<BotSession, number>();
  private paused = false;
  private currentTarget: number;
  /** Re-entrancy guard: the process fires tick() on a fixed interval regardless of whether the previous pass finished. */
  private ticking = false;
  /** Advances each tick so runUpkeep() covers a different rotation slice of the online set (round-robin). */
  private upkeepRotation = 0;
  /** One-shot flag so a persistently-unavailable capacity signal warns once, not every tick. */
  private capacityWarned = false;
  /**
   * Cumulative upkeep failures by kind, plus how many of them have already been logged.
   *
   * These used to be `.catch(() => undefined)` — thrown away unread. That is how a bot loop that had
   * failed on EVERY call since the day it shipped stayed invisible for months: `tickSlg()`'s building
   * upgrade was rejected 629,382 times in one 29-hour window on live s2-0 (see
   * BotSession.upgradeNextBuilding) while botsvc's log stayed clean and `/internal/bots/status`
   * reported a healthy fleet. A silenced error on a loop that runs forever is not noise reduction,
   * it is a blind spot with a request rate.
   */
  private readonly upkeepErrors = new Map<UpkeepKind, { count: number; logged: number; last: string }>();
  private lastUpkeepErrorLogAt = 0;

  constructor(
    private readonly pool: BotSession[],
    private readonly capacity: CapacityClient,
    private opts: SchedulerOptions,
  ) {
    this.currentTarget = opts.targetOnline;
  }

  setTargetOnline(target: number): void {
    this.opts = { ...this.opts, targetOnline: target };
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  status(): {
    total: number;
    online: number;
    targetOnline: number;
    effectiveTarget: number;
    paused: boolean;
    upkeepErrors: Record<UpkeepKind, number>;
    pve: PveCounters;
  } {
    // Summed over the whole pool, online or not: "are the bots playing PvE" is a fleet question.
    const pve: PveCounters = { entered: 0, cleared: 0, lost: 0, spotChecked: 0, verified: 0 };
    for (const s of this.pool) {
      for (const k of Object.keys(pve) as (keyof PveCounters)[]) pve[k] += s.pveCounters[k];
    }
    return {
      total: this.pool.length,
      online: this.online.size,
      targetOnline: this.opts.targetOnline,
      effectiveTarget: this.currentTarget,
      paused: this.paused,
      // Cumulative since process start: a fleet whose upkeep is wholly broken should be readable from
      // ops without going to the logs, since "the bots are online" was never the same as "the bots work".
      upkeepErrors: {
        family: this.upkeepErrors.get('family')?.count ?? 0,
        slg: this.upkeepErrors.get('slg')?.count ?? 0,
        pve: this.upkeepErrors.get('pve')?.count ?? 0,
      },
      pve,
    };
  }

  /** One scheduling pass: recompute the shed-adjusted target, then log sessions in/out toward it. */
  async tick(): Promise<void> {
    // At high fleet sizes a single pass can outlast the fixed tick interval (hundreds of REST
    // round-trips + matchmaking). Without this guard the interval would stack overlapping ticks,
    // multiplying REST/matchmaking load and the event-loop bursts that were causing bots to miss
    // gameserver heartbeats mid-match (BOTSVC_DESIGN §3.1). Skip this pass; the next one will catch up.
    if (this.ticking) {
      console.warn('botsvc scheduler: previous tick still running, skipping this pass');
      return;
    }
    this.ticking = true;
    try {
      if (this.paused) {
        await this.drainAll();
        return;
      }
      // A missing capacity signal must not halt scheduling — degrade to "no shedding" (full target)
      // rather than throwing away the whole pass. Also lets an external load-gen fleet run without
      // reach to gateway's internal /internal/stats (public routing doesn't expose it).
      let gatewayOnline: number | undefined;
      try {
        gatewayOnline = await this.capacity.onlineCount();
      } catch (e) {
        if (!this.capacityWarned) {
          console.warn('botsvc scheduler: capacity signal unavailable, shedding disabled:', (e as Error).message);
          this.capacityWarned = true;
        }
      }
      const now = this.now();
      const wanted = this.opts.rotation ? diurnalTarget(this.opts.targetOnline, now) : this.opts.targetOnline;
      this.currentTarget =
        gatewayOnline === undefined
          ? wanted
          : shedTarget({
              targetOnline: wanted,
              currentOnline: gatewayOnline,
              shedStartAt: this.opts.shedStartAt,
              shedFullAt: this.opts.shedFullAt,
            });

      if (this.opts.rotation) this.endExpiredSessions(now);
      if (this.online.size < this.currentTarget) {
        await this.spawnUpTo(this.currentTarget, now);
      } else if (this.online.size > this.currentTarget) {
        this.despawnDownTo(this.currentTarget);
      }

      await this.runUpkeep();
      this.flushUpkeepErrors(this.now());
    } finally {
      this.ticking = false;
    }
  }

  private noteUpkeepError(kind: UpkeepKind, e: unknown): void {
    const entry = this.upkeepErrors.get(kind) ?? { count: 0, logged: 0, last: '' };
    entry.count++;
    entry.last = e instanceof Error ? e.message : String(e);
    this.upkeepErrors.set(kind, entry);
  }

  /**
   * One rolled-up line per interval instead of one per failure: at 100 online bots a broken upkeep
   * step fails hundreds of times a minute, and a per-failure log would be its own incident. Prints
   * the count SINCE THE LAST LINE plus the running total, so a steady rate reads as a steady rate.
   */
  private flushUpkeepErrors(now: number): void {
    if (this.upkeepErrors.size === 0) return;
    if (now - this.lastUpkeepErrorLogAt < UPKEEP_ERROR_LOG_INTERVAL_MS) return;
    const parts: string[] = [];
    for (const [kind, entry] of this.upkeepErrors) {
      const since = entry.count - entry.logged;
      if (since === 0) continue;
      entry.logged = entry.count;
      parts.push(`${kind}=${since} (total ${entry.count}, last: ${entry.last})`);
    }
    if (parts.length === 0) return;
    this.lastUpkeepErrorLogAt = now;
    console.warn(`botsvc upkeep failures: ${parts.join(', ')}`);
  }

  /**
   * Family + SLG upkeep for one rotation slice of the online set, at bounded concurrency. Only
   * 1/upkeepRotations of the fleet is touched per call — round-robin across ticks — so each bot still
   * gets upkeep roughly once every (tickMs * upkeepRotations), same cadence as processing everyone
   * every tick, but the per-tick burst is upkeepRotations times smaller. This trades one big fan-out
   * per interval for several small ones, closer to how real players trickle their activity rather than
   * all acting in lockstep. Serial awaits made one pass grow linearly with the fleet (a 1000-bot tick
   * outran the interval); unbounded Promise.all would fire hundreds of REST fan-outs at once. A fixed
   * pool of workers pulling from a shared cursor keeps each session's tickFamily→tickSlg order intact
   * while capping in-flight work. tickPve() and tickBattle() stay fire-and-forget: a level or a match
   * lasts minutes, so neither may ever be awaited here.
   */
  private async runUpkeep(): Promise<void> {
    const all = [...this.online];
    if (all.length === 0) return;
    const rotations = Math.max(1, this.opts.upkeepRotations);
    const chunkSize = Math.ceil(all.length / rotations);
    const start = (this.upkeepRotation % rotations) * chunkSize;
    this.upkeepRotation = (this.upkeepRotation + 1) % rotations;
    const sessions = all.slice(start, start + chunkSize);

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < sessions.length) {
        const session = sessions[next++]!;
        await session.tickFamily().catch((e: unknown) => this.noteUpkeepError('family', e));
        await session.tickSlg().catch((e: unknown) => this.noteUpkeepError('slg', e));
        // Before the ranked roll: a due PvE run takes the bot out of lobby_idle, so it does not also queue.
        void session.tickPve(this.now()).catch((e: unknown) => this.noteUpkeepError('pve', e));
        session.tickBattle();
      }
    };
    const workers = Math.max(1, Math.min(this.opts.upkeepConcurrency, sessions.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private random(): number {
    return (this.opts.random ?? Math.random)();
  }

  /**
   * Who logs in next. With rotation: bots whose PvE run is due first (earliest first), so a planned
   * evening run is not lost to a bot that happens to be offline then; after them a uniform random
   * pick from the rest of the pool. Without rotation: the pool in order, the old behaviour.
   */
  private nextToLogIn(now: number, count: number): BotSession[] {
    const offline = this.pool.filter((s) => s.state === 'offline');
    if (!this.opts.rotation) return offline.slice(0, Math.max(0, count));
    const picked = offline
      .map((s) => ({ s, at: s.pveDueAt(now) }))
      .filter((d) => d.at <= now)
      .sort((a, b) => a.at - b.at)
      .slice(0, Math.max(0, count))
      .map((d) => d.s);
    const rest = offline.filter((s) => !picked.includes(s));
    while (picked.length < count && rest.length > 0) {
      picked.push(rest.splice(Math.floor(this.random() * rest.length), 1)[0]!);
    }
    return picked;
  }

  private async spawnUpTo(target: number, now: number): Promise<void> {
    const need = Math.min(target - this.online.size, this.opts.batchSize);
    for (const session of this.nextToLogIn(now, need)) {
      await session.login().catch(() => undefined);
      if (session.state === 'offline') continue;
      this.online.add(session);
      this.sessionEnds.set(session, now + sessionLength(() => this.random()));
    }
  }

  /**
   * Logs out sessions whose time is up — only from lobby_idle, so a match or a level is finished first
   * (a player does not quit mid-game to keep to a schedule), and not while a PvE run is due: the bot
   * plays it, then goes. Batched like every other login/logout wave.
   */
  private endExpiredSessions(now: number): void {
    let ended = 0;
    for (const session of [...this.online]) {
      if (ended >= this.opts.batchSize) break;
      if ((this.sessionEnds.get(session) ?? Infinity) > now) continue;
      if (session.state !== 'lobby_idle' || session.pveDueAt(now) <= now) continue;
      this.drop(session);
      ended++;
    }
  }

  /**
   * Over target (the day curve falling, or capacity shedding): idle sessions go first, soonest-ending
   * first, and only then ones mid-match — shedding still reaches its target, the evening wind-down just
   * does not cut matches short.
   */
  private despawnDownTo(target: number): void {
    const excess = Math.min(this.online.size - target, this.opts.batchSize);
    const order = [...this.online].sort(
      (a, b) =>
        Number(a.state !== 'lobby_idle') - Number(b.state !== 'lobby_idle') ||
        // MAX_SAFE_INTEGER, not Infinity: Infinity - Infinity is NaN, which breaks the sort.
        (this.sessionEnds.get(a) ?? Number.MAX_SAFE_INTEGER) - (this.sessionEnds.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    for (const session of order.slice(0, Math.max(0, excess))) this.drop(session);
  }

  private drop(session: BotSession): void {
    session.logout();
    this.online.delete(session);
    this.sessionEnds.delete(session);
  }

  private async drainAll(): Promise<void> {
    for (const session of this.online) session.logout();
    this.online.clear();
    this.sessionEnds.clear();
  }
}

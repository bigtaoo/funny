// Session scheduler (BOTSVC_DESIGN §3.1, §4): keeps online count near a target that ramps down under
// capacity pressure, without pretending a fixed-size crowd all logs in/out in lockstep.
import { CapacityClient, shedTarget } from './capacityClient';
import { BotSession } from './bot';

export interface SchedulerOptions {
  targetOnline: number;
  shedStartAt: number;
  shedFullAt: number;
  /** Max sessions started/stopped per tick — avoids a login/logout stampede that would itself look unlike real traffic. */
  batchSize: number;
  /** Max concurrent per-session upkeep chains (family+SLG) per tick — see the tick() note on why this is bounded, not serial and not unbounded. */
  upkeepConcurrency: number;
}

export class Scheduler {
  private readonly online = new Set<BotSession>();
  private paused = false;
  private currentTarget: number;
  /** Re-entrancy guard: the process fires tick() on a fixed interval regardless of whether the previous pass finished. */
  private ticking = false;

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

  status(): { total: number; online: number; targetOnline: number; effectiveTarget: number; paused: boolean } {
    return {
      total: this.pool.length,
      online: this.online.size,
      targetOnline: this.opts.targetOnline,
      effectiveTarget: this.currentTarget,
      paused: this.paused,
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
      const gatewayOnline = await this.capacity.onlineCount();
      this.currentTarget = shedTarget({
        targetOnline: this.opts.targetOnline,
        currentOnline: gatewayOnline,
        shedStartAt: this.opts.shedStartAt,
        shedFullAt: this.opts.shedFullAt,
      });

      if (this.online.size < this.currentTarget) {
        await this.spawnUpTo(this.currentTarget);
      } else if (this.online.size > this.currentTarget) {
        this.despawnDownTo(this.currentTarget);
      }

      await this.runUpkeep();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Family + SLG upkeep for every online session, at bounded concurrency. Serial awaits made one pass
   * grow linearly with the fleet (a 1000-bot tick outran the interval); unbounded Promise.all would
   * fire 1000 REST fan-outs at once. A fixed pool of workers pulling from a shared cursor keeps each
   * session's tickFamily→tickSlg order intact while capping in-flight work. tickBattle() stays
   * fire-and-forget: a match can run for minutes, so it must never be awaited here.
   */
  private async runUpkeep(): Promise<void> {
    const sessions = [...this.online];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < sessions.length) {
        const session = sessions[next++]!;
        await session.tickFamily().catch(() => undefined);
        await session.tickSlg().catch(() => undefined);
        session.tickBattle();
      }
    };
    const workers = Math.max(1, Math.min(this.opts.upkeepConcurrency, sessions.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  private async spawnUpTo(target: number): Promise<void> {
    const offline = this.pool.filter((s) => s.state === 'offline');
    const need = Math.min(target - this.online.size, this.opts.batchSize, offline.length);
    for (let i = 0; i < need; i++) {
      const session = offline[i]!;
      await session.login().catch(() => undefined);
      if (session.state !== 'offline') this.online.add(session);
    }
  }

  private despawnDownTo(target: number): void {
    const excess = Math.min(this.online.size - target, this.opts.batchSize);
    let dropped = 0;
    for (const session of this.online) {
      if (dropped >= excess) break;
      session.logout();
      this.online.delete(session);
      dropped++;
    }
  }

  private async drainAll(): Promise<void> {
    for (const session of this.online) session.logout();
    this.online.clear();
  }
}

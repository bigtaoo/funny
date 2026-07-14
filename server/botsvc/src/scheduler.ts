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
}

export class Scheduler {
  private readonly online = new Set<BotSession>();
  private paused = false;
  private currentTarget: number;

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

    for (const session of this.online) {
      // Family upkeep is cheap and infrequent enough to run every tick; real cadence tuning is a post-load-test knob.
      await session.tickFamily().catch(() => undefined);
    }
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

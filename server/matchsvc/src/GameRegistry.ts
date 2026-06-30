// Game instance registry (M17, inside matchsvc). On startup, gameserver POSTs /mm/game/register
// to report its public WS address + capacity; periodic heartbeats report load; matchsvc uses this
// to assign matches to the least-loaded healthy instance.
//
// Single-instance deployments need not register — the env fallback address (GatewayEnv.gamePublicWsUrl)
// creates a static entry. For multi-instance horizontal scaling this registry is the sole authority
// on "who has a free game slot" (clients and meta need not know the game topology).

export interface GameInstance {
  gameId: string;
  wsUrl: string;
  capacity: number;
  load: number;
  lastSeen: number;
}

/** Heartbeat expiry threshold: instances that have not reported within this duration are considered unhealthy and no longer assigned. */
const STALE_MS = 30_000;

export class GameRegistry {
  private readonly instances = new Map<string, GameInstance>();

  constructor(
    /** Injected clock (for testing). */
    private readonly now: () => number = Date.now,
    /** Single-instance fallback address; assigned when the registry is empty. */
    private readonly fallbackWsUrl: string | null = null,
  ) {}

  register(gameId: string, wsUrl: string, capacity: number): void {
    this.instances.set(gameId, {
      gameId,
      wsUrl,
      capacity: Math.max(1, capacity),
      load: 0,
      lastSeen: this.now(),
    });
  }

  heartbeat(gameId: string, load: number, _rooms: number): void {
    const inst = this.instances.get(gameId);
    if (!inst) return;
    inst.load = Math.max(0, load);
    inst.lastSeen = this.now();
  }

  /** Real-time aggregate (admin monitoring, OPS_DESIGN §4.1): healthy instance count + total load/capacity. */
  stats(): { instances: number; load: number; capacity: number } {
    const t = this.now();
    let instances = 0;
    let load = 0;
    let capacity = 0;
    for (const inst of this.instances.values()) {
      if (t - inst.lastSeen > STALE_MS) continue; // unhealthy, exclude from aggregate
      instances++;
      load += inst.load;
      capacity += inst.capacity;
    }
    return { instances, load, capacity };
  }

  /** Picks the wsUrl of the least-loaded healthy instance; falls back to the fallback address when no registered instances exist (null = no game available). */
  pick(): string | null {
    const t = this.now();
    let best: GameInstance | null = null;
    for (const inst of this.instances.values()) {
      if (t - inst.lastSeen > STALE_MS) continue; // unhealthy
      if (inst.load >= inst.capacity) continue; // at full capacity
      const ratio = inst.load / inst.capacity;
      if (!best || ratio < best.load / best.capacity) best = inst;
    }
    if (best) {
      best.load++; // optimistic reservation (corrected on next heartbeat)
      return best.wsUrl;
    }
    return this.fallbackWsUrl;
  }
}

import { registerPool } from './poolRegistry';

type Factory<T> = () => T;
type Resetter<T> = (obj: T) => void;

/** Optional: register this pool with the memory-monitor registry (MemoryMonitor). */
export interface PoolStatOpts {
  /** Display label, e.g. 'unit.circle' / 'building'. */
  label: string;
  /** Rough estimated JS heap bytes per idle object (see poolRegistry file header). */
  bytesEach: number;
}

export class ObjectPool<T> {
  private pool: T[] = [];
  /** Memory monitor unregister function (called on drain()); null when not registered. */
  private unregisterStat: (() => void) | null = null;

  constructor(
    private factory: Factory<T>,
    private resetter: Resetter<T>,
    prewarm = 0,
    stat?: PoolStatOpts,
  ) {
    for (let i = 0; i < prewarm; i++) {
      this.pool.push(factory());
    }
    if (stat) {
      this.unregisterStat = registerPool({
        label: stat.label,
        idle: () => this.pool.length,
        bytesEach: stat.bytesEach,
      });
    }
  }

  acquire(): T {
    return this.pool.length > 0 ? this.pool.pop()! : this.factory();
  }

  release(obj: T): void {
    this.resetter(obj);
    this.pool.push(obj);
  }

  get size(): number {
    return this.pool.length;
  }

  /**
   * Empty the pool, optionally disposing each retained (detached) object.
   * Teardown only — pooled objects have been `removeFromParent()`'d, so they are
   * NOT covered by a parent container's `destroy({children:true})` and would leak
   * their Graphics/Sprite GPU resources unless destroyed here.
   */
  drain(dispose?: (obj: T) => void): void {
    if (dispose) for (const obj of this.pool) dispose(obj);
    this.pool.length = 0;
    this.unregisterStat?.();
    this.unregisterStat = null;
  }
}

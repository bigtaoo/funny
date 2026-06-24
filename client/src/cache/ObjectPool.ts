import { registerPool } from './poolRegistry';

type Factory<T> = () => T;
type Resetter<T> = (obj: T) => void;

/** 可选：把这个池登记进内存看护注册表（MemoryMonitor）。 */
export interface PoolStatOpts {
  /** 展示标签，如 'unit.circle' / 'building'。 */
  label: string;
  /** 单个空闲对象的粗估 JS 堆字节数（见 poolRegistry 文件头）。 */
  bytesEach: number;
}

export class ObjectPool<T> {
  private pool: T[] = [];
  /** 内存看护注销函数（drain() 时调用）；未登记则为 null。 */
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

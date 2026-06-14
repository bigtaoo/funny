type Factory<T> = () => T;
type Resetter<T> = (obj: T) => void;

export class ObjectPool<T> {
  private pool: T[] = [];

  constructor(
    private factory: Factory<T>,
    private resetter: Resetter<T>,
    prewarm = 0,
  ) {
    for (let i = 0; i < prewarm; i++) {
      this.pool.push(factory());
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
}

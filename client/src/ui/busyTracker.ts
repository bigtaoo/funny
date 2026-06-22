/** Milliseconds before an in-flight request is considered timed out. */
export const BUSY_TIMEOUT_MS = 10_000;

export class TimeoutError extends Error {
  constructor() { super('timeout'); }
}

/**
 * Race a promise against a 10 s deadline.
 * Rejects with TimeoutError if the promise hasn't settled by then.
 */
export function withTimeout<T>(promise: Promise<T>, ms = BUSY_TIMEOUT_MS): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(id)) as Promise<T>;
}

/**
 * Per-scene busy state: tracks how long a request has been in flight and
 * gates a 1-second loading indicator with animated dots.
 *
 * Usage pattern:
 *   private readonly bt = new BusyTracker();
 *
 *   update(dt) { if (this.bt.tick(dt)) this.render(); }
 *
 *   // block all input while request is in flight:
 *   handleDown() { if (this.bt.busy) return; ... }
 *
 *   // show loading overlay after 1 s:
 *   render() { ...; if (this.bt.loadingVisible) drawLoadingOverlay(..., this.bt.dots); }
 */
export class BusyTracker {
  busy = false;
  /** Seconds the current request has been in flight. */
  elapsed = 0;
  /** True after 1 second — triggers the loading overlay. */
  loadingVisible = false;
  /** 0–2, cycles every 0.4 s to drive the dot animation. */
  dots = 0;
  private dotTimer = 0;

  start(): void {
    this.busy = true;
    this.elapsed = 0;
    this.loadingVisible = false;
    this.dots = 0;
    this.dotTimer = 0;
  }

  stop(): void {
    this.busy = false;
    this.loadingVisible = false;
  }

  /** Call in Scene.update(dt). Returns true when a re-render is needed. */
  tick(dt: number): boolean {
    if (!this.busy) return false;
    this.elapsed += dt;
    let dirty = false;
    if (!this.loadingVisible && this.elapsed >= 1.0) {
      this.loadingVisible = true;
      dirty = true;
    }
    if (this.loadingVisible) {
      this.dotTimer += dt;
      if (this.dotTimer >= 0.4) {
        this.dotTimer = 0;
        this.dots = (this.dots + 1) % 3;
        dirty = true;
      }
    }
    return dirty;
  }
}

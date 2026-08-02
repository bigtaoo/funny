// Shared foundation for the AnalyticsService mixin chain (see ../service.ts assembly).
//
// AnalyticsServiceBase holds the collections handle (protected, so every mixin body keeps referencing
// this.col verbatim) + the constructor + getConfig. Each query domain lives in its own sibling file as
// `XMixin(Base)` and is chained into the final AnalyticsService:
//   traffic.ts — event counts / DAU / login-hour / retention / first-session
//   funnel.ts  — the funnel ETL plus the tutorial / scene / level / feature-guide funnels
//   dist.ts    — region / os / browser / device-type / geo / badge distributions
//   ingest.ts  — the write path (A9-3 event batch ingestion)
import type { AnalyticsCollections } from '../db';
import { AnalyticsConfig, getConfig } from './defs';



export class AnalyticsServiceBase {


  constructor(
    protected readonly cols: AnalyticsCollections,
    protected readonly now: () => number = () => Date.now(),
  ) {}

  getConfig(): AnalyticsConfig {
    return getConfig();
  }
}

export type Constructor<T = object> = new (...args: any[]) => T;
export type AnalyticsServiceBaseCtor = Constructor<AnalyticsServiceBase>;

// ── Domain entrypoints dispatched to from base-level code (the render dispatcher) and across
// sibling mixins. Declared via interface/class declaration merging so base-level calls type-check
// as METHODS (properties would clash with the mixin override — TS2425). Emits NOTHING at runtime,
// so the real prototype methods provided by the mixins run and every body stays verbatim.
export interface AnalyticsServiceBase {

}

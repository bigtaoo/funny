// analyticsvc business logic (A9-2 / A9-3 / A9-6). Thin assembly file.
//
// The service is composed via the mixin chain below over AnalyticsServiceBase (./service/base.ts,
// which owns the collections handle + the constructor + getConfig). Each query domain lives in its
// own sibling file (traffic / funnel / dist / ingest); the shared config, wire shapes, UA parser and
// funnel step definitions are pure declarations and live in ./service/defs.ts.
//
// AnalyticsService stays exported HERE, and ./service/defs.ts is re-exported through it, so existing
// importers (`from './service'` in httpApi.ts / index.ts / scheduler.ts and the e2e test) keep
// resolving to this file rather than the directory. To add a query: find the matching domain mixin
// or add a new one to the chain — do NOT grow this file.
import { AnalyticsServiceBase } from './service/base';
import { TrafficMixin } from './service/traffic';
import { FunnelMixin } from './service/funnel';
import { DistMixin } from './service/dist';
import { IngestMixin } from './service/ingest';

export * from './service/defs';

const Assembled = IngestMixin(DistMixin(FunnelMixin(TrafficMixin(AnalyticsServiceBase))));

/**
 * AnalyticsService — the single object httpApi routes and the scheduler call into.
 * Assembled from the per-domain mixin chain over AnalyticsServiceBase.
 */
export class AnalyticsService extends Assembled {}

// analyticsvc business logic (A9-2 / A9-3 / A9-6). Thin assembly file.
//
// The service is composed by holding one independent sibling instance per query domain (traffic /
// funnel / dist / ingest), each constructed with its own `(cols, now)` — no shared base class, no
// mixin chain (2026-08-11: converted from the `XMixin(Base)` chain per claudedocs/server.md's
// "拆分形态的优先级" 形态②, independent classes + composition — the four domains never called
// each other's methods, so the inheritance chain bought nothing here). The shared config/wire-shape
// /UA parser/funnel-step declarations are pure declarations and live in ./service/defs.ts.
//
// AnalyticsService stays exported HERE, and ./service/defs.ts is re-exported through it, so existing
// importers (`from './service'` in httpApi.ts / index.ts / scheduler.ts and the e2e test) keep
// resolving to this file rather than the directory. To add a query: find the matching domain class
// or add a new one — do NOT grow this file, and do NOT let the domains import each other.
import type { AnalyticsCollections } from './db';
import { AnalyticsConfig, getConfig } from './service/defs';
import { TrafficService } from './service/traffic';
import { FunnelService } from './service/funnel';
import { DistService } from './service/dist';
import { IngestService } from './service/ingest';

export * from './service/defs';

/**
 * AnalyticsService — the single object httpApi routes and the scheduler call into. Composed from
 * four independent sibling classes, each constructed with the same `(cols, now)` this class was.
 */
export class AnalyticsService {
  private readonly traffic: TrafficService;
  private readonly funnel: FunnelService;
  private readonly dist: DistService;
  private readonly ingest: IngestService;

  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.traffic = new TrafficService(cols, now);
    this.funnel = new FunnelService(cols, now);
    this.dist = new DistService(cols, now);
    this.ingest = new IngestService(cols, now);
  }

  getConfig(): AnalyticsConfig {
    return getConfig();
  }

  // ── traffic ──
  queryEventCounts(...args: Parameters<TrafficService['queryEventCounts']>) { return this.traffic.queryEventCounts(...args); }
  queryDau(...args: Parameters<TrafficService['queryDau']>) { return this.traffic.queryDau(...args); }
  queryLoginHour(...args: Parameters<TrafficService['queryLoginHour']>) { return this.traffic.queryLoginHour(...args); }
  queryRetention(...args: Parameters<TrafficService['queryRetention']>) { return this.traffic.queryRetention(...args); }
  queryFirstSession(...args: Parameters<TrafficService['queryFirstSession']>) { return this.traffic.queryFirstSession(...args); }

  // ── funnel ──
  queryFunnel(...args: Parameters<FunnelService['queryFunnel']>) { return this.funnel.queryFunnel(...args); }
  runFunnelEtl(...args: Parameters<FunnelService['runFunnelEtl']>) { return this.funnel.runFunnelEtl(...args); }
  queryTutorialFunnel(...args: Parameters<FunnelService['queryTutorialFunnel']>) { return this.funnel.queryTutorialFunnel(...args); }
  querySceneFunnel(...args: Parameters<FunnelService['querySceneFunnel']>) { return this.funnel.querySceneFunnel(...args); }
  queryLevelFunnel(...args: Parameters<FunnelService['queryLevelFunnel']>) { return this.funnel.queryLevelFunnel(...args); }
  queryFeatureGuideFunnel(...args: Parameters<FunnelService['queryFeatureGuideFunnel']>) { return this.funnel.queryFeatureGuideFunnel(...args); }

  // ── dist ──
  queryRegionDist(...args: Parameters<DistService['queryRegionDist']>) { return this.dist.queryRegionDist(...args); }
  queryOsDist(...args: Parameters<DistService['queryOsDist']>) { return this.dist.queryOsDist(...args); }
  queryBrowserDist(...args: Parameters<DistService['queryBrowserDist']>) { return this.dist.queryBrowserDist(...args); }
  queryDeviceTypeDist(...args: Parameters<DistService['queryDeviceTypeDist']>) { return this.dist.queryDeviceTypeDist(...args); }
  queryWebViewDist(...args: Parameters<DistService['queryWebViewDist']>) { return this.dist.queryWebViewDist(...args); }
  queryGeoDist(...args: Parameters<DistService['queryGeoDist']>) { return this.dist.queryGeoDist(...args); }
  queryBadgeDist(...args: Parameters<DistService['queryBadgeDist']>) { return this.dist.queryBadgeDist(...args); }

  // ── ingest ──
  ingestEvents(...args: Parameters<IngestService['ingestEvents']>) { return this.ingest.ingestEvents(...args); }
}

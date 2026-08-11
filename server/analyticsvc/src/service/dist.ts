// analyticsvc query domain: distributions — locale/region, OS, browser, device type, geo country
// and match-badge spread, all counted as distinct devices.
//
// Independent sibling class (2026-08-11 mixin-chain split, claudedocs/server.md "拆分形态的优先级"
// 形态②): holds its own `cols`/`now`, no shared base, no cross-domain calls — assembled by
// composition in ../service.ts.

import { AnalyticsCollections } from '../db';
import { RegionRow, OsRow, BadgeDistRow, BrowserRow, DeviceTypeRow, GeoRow, dayStart } from './defs';

export class DistService {
  constructor(
    private readonly cols: AnalyticsCollections,
    private readonly now: () => number,
  ) {}

  /** Region distribution: unique device count by locale across all events (last N days). */
  async queryRegionDist(days: number): Promise<RegionRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since } } },
      { $group: { _id: { locale: '$locale', device: '$device_id' } } },
      { $group: { _id: '$_id.locale', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: string; devices: number }>(pipeline)
      .toArray();
    return rows.map((r) => ({ locale: r._id || 'unknown', devices: r.devices }));
  }

  /** Device/OS distribution: unique device count by os from session_start events (last N days). */
  async queryOsDist(days: number): Promise<OsRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { os: '$os', device: '$device_id' } } },
      { $group: { _id: '$_id.os', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: string; devices: number }>(pipeline)
      .toArray();
    return rows.map((r) => ({ os: r._id || 'unknown', devices: r.devices }));
  }

  /** Browser distribution (A9-9): unique device count by server-derived browser (from session_start). */
  async queryBrowserDist(days: number): Promise<BrowserRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { browser: '$browser', device: '$device_id' } } },
      { $group: { _id: '$_id.browser', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; devices: number }>(pipeline).toArray();
    return rows.map((r) => ({ browser: r._id || 'unknown', devices: r.devices }));
  }

  /** Device-type distribution (A9-9): mobile / tablet / desktop, server-derived from UA at ingest. */
  async queryDeviceTypeDist(days: number): Promise<DeviceTypeRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { device_type: '$device_type', device: '$device_id' } } },
      { $group: { _id: '$_id.device_type', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; devices: number }>(pipeline).toArray();
    return rows.map((r) => ({ device_type: r._id || 'unknown', devices: r.devices }));
  }

  /** Geo (country) distribution (A9-9): unique device count by IP-derived country. Raw IPs are never stored. */
  async queryGeoDist(days: number): Promise<GeoRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'session_start' } },
      { $group: { _id: { country: '$geo_country', device: '$device_id' } } },
      { $group: { _id: '$_id.country', devices: { $sum: 1 } } },
      { $sort: { devices: -1 as const } },
    ];
    const rows = await this.cols.events.aggregate<{ _id: string; devices: number }>(pipeline).toArray();
    return rows.map((r) => ({ country: r._id || 'unknown', devices: r.devices }));
  }

  /**
   * Post-match badge/title distribution (ANALYTICS_DESIGN §5.8): how often each `hero` badge is the
   * one awarded, split by mode (pvp_ranked / pvp_friendly / campaign …) and result (win/loss/draw).
   * Answers "is a single badge dominating for everyone" — the calibration-health signal for the
   * ResultScene REF_* constants. Counts matches (events), not devices; one row per (mode,result,badge).
   */
  async queryBadgeDist(days: number): Promise<BadgeDistRow[]> {
    const since = new Date(dayStart(this.now()) - (days - 1) * 86400_000);
    const pipeline = [
      { $match: { ts: { $gte: since }, event: 'match_badges' } },
      { $group: {
        _id: { mode: '$props.mode', result: '$props.result', badge: '$props.hero' },
        count: { $sum: 1 },
      } },
      { $sort: { count: -1 as const } },
    ];
    const rows = await this.cols.events
      .aggregate<{ _id: { mode?: string; result?: string; badge?: string }; count: number }>(pipeline)
      .toArray();
    return rows.map((r) => ({
      mode: r._id.mode || 'unknown',
      result: r._id.result || 'unknown',
      badge: r._id.badge || 'none',
      count: r.count,
    }));
  }
}

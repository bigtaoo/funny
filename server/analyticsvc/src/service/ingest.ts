// analyticsvc write path: event-batch ingestion (A9-3) — sampling, UA/geo enrichment, session
// upsert and the event insert.
import type { EventDoc } from '../db';
import { EventBatch, ResolvedGeo, parseUserAgent, clampEventTs } from './defs';
import type { Constructor, AnalyticsServiceBaseCtor } from './base';

export interface IngestHandlers {
  ingestEvents(batch: EventBatch, userId: string | undefined, geo?: ResolvedGeo): Promise<void>;
}

export function IngestMixin<TBase extends AnalyticsServiceBaseCtor>(Base: TBase): TBase & Constructor<IngestHandlers> {
  return class extends Base {
    async ingestEvents(batch: EventBatch, userId: string | undefined, geo?: ResolvedGeo): Promise<void> {
      if (!batch.events || batch.events.length === 0) return;

      const { browser, device_type } = parseUserAgent(batch.ua);
      const deviceFields = {
        ...(batch.ua ? { ua: batch.ua } : {}),
        ...(typeof batch.screen_w === 'number' ? { screen_w: batch.screen_w } : {}),
        ...(typeof batch.screen_h === 'number' ? { screen_h: batch.screen_h } : {}),
        ...(typeof batch.dpr === 'number' ? { dpr: batch.dpr } : {}),
        ...(batch.ua ? { browser, device_type } : {}),
        ...(geo?.ip ? { ip: geo.ip } : {}),
        ...(geo?.country ? { geo_country: geo.country } : {}),
        ...(geo?.region ? { geo_region: geo.region } : {}),
        ...(geo?.city ? { geo_city: geo.city } : {}),
      };

      const docs: EventDoc[] = batch.events.map((e) => ({
        session_id: batch.session_id ?? '',
        user_id: userId,
        device_id: batch.device_id ?? '',
        platform: batch.platform ?? 'web',
        os: batch.os ?? '',
        game_version: batch.game_version ?? '',
        locale: batch.locale ?? '',
        event: String(e.event),
        props: e.props ?? {},
        ts: clampEventTs(e.ts, this.now()),
        ...deviceFields,
      }));

      // fire-and-forget: w:0 does not wait for disk acknowledgement; a very small amount of event loss is acceptable for analytics data (A9-3 §7.3)
      await this.cols.events.insertMany(docs, { ordered: false, writeConcern: { w: 0 } });

      // session summary upsert (sessions collection, driven by session_start/session_end events)
      const sessionStart = batch.events.find((e) => e.event === 'session_start');
      const sessionEnd = batch.events.find((e) => e.event === 'session_end');

      // events_count must track every batch for the session, not just the one carrying
      // session_start: real traffic sends session_start once and then many event-only batches,
      // so gating the $inc on session_start's presence left events_count permanently undercounted.
      // The trigger here is simply "this batch has events for a known session" — batch.events.length
      // is always > 0 at this point (see the early return above), and this is the only $inc site for
      // events_count, so each batch still contributes exactly once, with no double-counting.
      if (batch.session_id) {
        await this.cols.sessions.updateOne(
          { _id: batch.session_id },
          {
            $setOnInsert: {
              user_id: userId,
              device_id: batch.device_id ?? '',
              platform: batch.platform ?? 'web',
              os: batch.os ?? '',
              started_at: clampEventTs(sessionStart?.ts ?? batch.events[0]?.ts, this.now()),
              scenes_visited: [],
              ...deviceFields,
            },
            $inc: { events_count: batch.events.length },
          },
          { upsert: true },
        );
      }

      if (sessionEnd && batch.session_id) {
        const props = sessionEnd.props ?? {};
        await this.cols.sessions.updateOne(
          { _id: batch.session_id },
          {
            $set: {
              ended_at: clampEventTs(sessionEnd.ts, this.now()),
              ...(typeof props['duration_sec'] === 'number' ? { duration_sec: props['duration_sec'] } : {}),
              ...(Array.isArray(props['scenes_visited']) ? { scenes_visited: props['scenes_visited'] as string[] } : {}),
            },
          },
        );
      }
    }
  };
}

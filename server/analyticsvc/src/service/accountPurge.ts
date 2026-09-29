// Account-deletion purge (POST /internal/accounts/:accountId/purge), called by metaserver's purge job
// once a soft-deleted account's grace period is over.
//
// Identity reaches this database two ways, and both have to be cleared:
//   • `user_id` — stamped on every event sent with a valid JWT, i.e. everything after login.
//   • `device_id` — the only key on events sent BEFORE login (first launch, the age/consent gates, the
//     login screen itself), which is often most of a new player's first session. metaserver passes the
//     account's known device ids so those rows go too.
//
// Device matches are restricted to rows with NO user_id: a device can be shared (a family tablet), and
// another account's identified events on it are that account's data, not this one's. Anonymous rows on
// the device cannot be attributed to anyone else, so they go.
//
// Sessions need one more hop. `sessions.user_id` is written by `$setOnInsert` on the session's first
// batch (ingest.ts), so a session that started anonymous and logged in part-way keeps `user_id: null`
// forever even though its later events carry the account. Those are found through the session ids of
// the account's own events, collected before the events are deleted — which is why events go last. The
// anonymous events of those same sessions go with them.
//
// Everything is a deleteMany, so a re-run after a partial failure simply removes whatever is left. Sessions
// are deleted before events so that a failure between the two never loses the session-id hop: if the
// sessions delete fails nothing is gone yet, and if the events delete fails the retry just finishes it.
import type { Filter } from 'mongodb';
import type { AnalyticsCollections, EventDoc, SessionDoc } from '../db';

/**
 * "No account on this row". `user_id: null` matches both a stored null and an absent field — and ingest
 * writes `user_id: undefined`, which the driver stores as null, so both shapes exist. The cast is only
 * because the doc types declare the field `string | undefined` and the driver's Filter type has no way to
 * say "null in the database".
 */
const ANONYMOUS = { user_id: null as unknown as undefined };

export interface AccountPurgeResult {
  done: true;
  removed: { events: number; sessions: number };
}

export class AccountPurgeService {
  constructor(private readonly cols: AnalyticsCollections) {}

  async purgeAccount(accountId: string, deviceIds: readonly string[] = []): Promise<AccountPurgeResult> {
    const anonOnDevice = deviceIds.length > 0 ? [{ device_id: { $in: [...deviceIds] }, ...ANONYMOUS }] : [];

    const sessionIds = (await this.cols.events.distinct('session_id', { user_id: accountId }))
      .filter((s): s is string => typeof s === 'string' && s !== '');
    const sessionFilter: Filter<SessionDoc> = {
      $or: [
        { user_id: accountId },
        ...anonOnDevice,
        ...(sessionIds.length > 0 ? [{ _id: { $in: sessionIds }, ...ANONYMOUS }] : []),
      ],
    };
    const sessions = await this.cols.sessions.deleteMany(sessionFilter);

    // The same hop for events: the anonymous opening of a session the account later logged into is this
    // player's, even on a device metaserver never saw.
    const eventFilter: Filter<EventDoc> = {
      $or: [
        { user_id: accountId },
        ...anonOnDevice,
        ...(sessionIds.length > 0 ? [{ session_id: { $in: sessionIds }, ...ANONYMOUS }] : []),
      ],
    };
    const events = await this.cols.events.deleteMany(eventFilter);

    return { done: true, removed: { events: events.deletedCount, sessions: sessions.deletedCount } };
  }
}

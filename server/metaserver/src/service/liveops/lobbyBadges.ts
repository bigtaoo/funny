// Live-ops aggregated lobby red-dot fetch (P1-4, comm-audit-2026-07-27). Split out of liveops.ts
// (2026-08-10, 独立函数模块 form — see liveops.ts's facade comment). Only ever touched `this.deps`,
// never a protected base method, so it takes plain `deps` with no ctx/binding needed. No behavior change.
import type { FastifyRequest } from 'fastify';
import type { SocialBadges } from '@nw/shared';
import { ok, ACHIEVEMENTS, resetStaleRetention, nextCheckinDay, dailyRewardClaimable, weeklyClaimableTiers } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { getEventsForAccount } from '../../events.js';
import { accountIdOf, type ServiceDeps } from '../base.js';

const ZERO_SOCIAL_BADGES: SocialBadges = { friendRequests: 0, chat: 0, mail: 0, total: 0 };

/**
 * Aggregated lobby red-dot fetch (P1-4, comm-audit-2026-07-27): merges social badges (proxied to
 * socialsvc) + achievement defs/stats/claimed + retention claimable flags + events-available into
 * one call, replacing the 4-request waterfall goLobby() used to fire on every online lobby entry.
 * Best-effort on the social slice — socialsvc being down degrades to zeroed counts rather than
 * failing the whole response, matching the old per-call try/catch semantics on the client.
 */
export async function getLobbyBadgesHandler(deps: ServiceDeps, req: FastifyRequest) {
  const accountId = accountIdOf(req);
  const { cols, now, socialsvc } = deps;
  const tsMs = now();
  const auth = (req.headers.authorization ?? '') as string;
  const [save, events, socialResult] = await Promise.all([
    getOrCreateSave(cols, accountId, tsMs),
    getEventsForAccount(cols, accountId, tsMs),
    socialsvc?.available ? socialsvc.proxy('GET', '/social/badges', null, auth) : Promise.resolve(null),
  ]);
  const retention = resetStaleRetention(save.retention, tsMs);
  const social =
    socialResult && socialResult.status === 200
      ? ((socialResult.data as { data: SocialBadges }).data ?? ZERO_SOCIAL_BADGES)
      : ZERO_SOCIAL_BADGES;
  return ok({
    social,
    achievements: { defs: ACHIEVEMENTS, stats: save.stats ?? {}, achievements: save.achievements ?? {} },
    retentionClaimable: {
      checkin: nextCheckinDay(retention, tsMs) !== null,
      daily: dailyRewardClaimable(retention, tsMs),
      // 2026-08-05 fix: this hand-rolled trio used to omit the weekly chest entirely — a fully
      // week-claimed player still saw the "每日" red dot light up for checkin/daily, but a player
      // who'd ONLY earned a weekly-chest tier (checkin/daily already claimed today) saw no dot at
      // all, even though `hasRetentionClaimable` (retention.ts, used by the client mirror + its own
      // test) already accounted for weekly tiers. Kept as three explicit booleans (matching the
      // openapi contract) rather than switching to hasRetentionClaimable(save, tsMs) directly, since
      // the client badge (lobby.ts) ORs each field independently and may want to distinguish them later.
      weekly: weeklyClaimableTiers(retention, tsMs).length > 0,
    },
    eventsAvailable: events.length > 0,
  });
}

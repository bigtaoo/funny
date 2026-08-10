// socialsvc httpApi split — public /social/profile/:publicId/extra (see ../httpApi.ts for the module
// overview). No behavior change — copied verbatim from the original httpApi.ts.
import { ok } from '@nw/shared';
import { send, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleProfileRoutes(ctx: RouteCtx): Promise<boolean> {
  const { res, method, path, familySvc, meta } = ctx;

  // Unified profile-popup extras (rank/ELO + family/sect, if any) for an arbitrary player, looked
  // up by public id — the single place every ProfilePopup instance fetches this from (friends
  // list / family roster / world chat / battle opponent), instead of each screen threading its
  // own copy of the same fields through its own view model. Best-effort: an unresolvable publicId
  // or a lookup failure yields an empty object rather than an error, since the popup already has
  // enough (name + id) to render without these extras.
  const m = /^\/social\/profile\/([^/]+)\/extra$/.exec(path);
  if (method === 'GET' && m) {
    const publicId = decodeURIComponent(m[1]!);
    // comm-audit batch F item 2: was resolveByPublicId + getPlayerRank (two sequential meta hops) —
    // meta's /internal/player already accepts publicId directly, collapsing this to one hop.
    const resolved = await meta.getPlayerRankByPublicId(publicId);
    if (!resolved) { send(res, 200, ok({})); return true; }
    const mem = await familySvc.getMember(resolved.accountId);
    send(res, 200, ok({
      ...(resolved.rank ? { rank: resolved.rank } : {}),
      ...(resolved.elo !== undefined ? { elo: resolved.elo } : {}),
      ...(mem?.name ? { familyName: mem.name } : {}),
      ...(mem?.sectName ? { sectName: mem.sectName } : {}),
    }));
    return true;
  }

  return false;
}

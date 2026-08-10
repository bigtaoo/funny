// socialsvc httpApi split — /internal/family/* (called by worldsvc/metaserver, SS7/§8.2). Runs after the
// shell has already verified X-Internal-Key once for the whole /internal/* block (see ../httpApi.ts).
// No behavior change — copied verbatim from the original httpApi.ts.
import { ErrorCode, ok } from '@nw/shared';
import { send, sendErr, readJson, type BaseCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleInternalFamilyRoutes(ctx: BaseCtx): Promise<boolean> {
  const { req, res, method, path, familySvc } = ctx;

  // Look up the familyId the player belongs to (called by worldsvc, SS7)
  {
    const m = /^\/internal\/family\/by-account\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const accountId = decodeURIComponent(m[1]!);
      const familyId = await familySvc.getFamilyIdByAccount(accountId);
      send(res, 200, ok({ familyId }));
      return true;
    }
  }

  // Accumulate activity score (called by worldsvc on capture/battle, SS7)
  if (method === 'POST' && path === '/internal/family/activity') {
    const body = await readJson(req);
    const familyId = typeof body.familyId === 'string' ? body.familyId : null;
    const delta = typeof body.delta === 'number' ? body.delta : 1;
    if (!familyId) { sendErr(res, ErrorCode.BAD_REQUEST, 'familyId required'); return true; }
    await familySvc.bumpActivity(familyId, delta);
    send(res, 200, ok({}));
    return true;
  }

  // Membership + family identity in one round trip (called by worldsvc sect permission checks)
  {
    const m = /^\/internal\/family\/member\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const accountId = decodeURIComponent(m[1]!);
      const member = await familySvc.getMember(accountId);
      send(res, 200, ok({ member }));
      return true;
    }
  }

  // Batch fetch families by id (called by worldsvc for sect roster display / season settlement)
  if (method === 'POST' && path === '/internal/family/batch') {
    const body = await readJson(req);
    const familyIds = Array.isArray(body.familyIds) ? (body.familyIds as string[]) : [];
    send(res, 200, ok({ families: await familySvc.getFamiliesByIds(familyIds) }));
    return true;
  }

  // All families currently in a given sect (called by worldsvc sect roster / vote / penalty fan-out)
  {
    const m = /^\/internal\/family\/by-sect\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const sectId = decodeURIComponent(m[1]!);
      send(res, 200, ok({ families: await familySvc.getFamiliesBySect(sectId) }));
      return true;
    }
  }

  // Set/clear the sect a family belongs to (worldsvc is authoritative; this is a read cache for clients, SLG_DESIGN §8.2)
  {
    const m = /^\/internal\/family\/([^/]+)\/sect$/.exec(path);
    if (method === 'POST' && m) {
      const familyId = decodeURIComponent(m[1]!);
      const body = await readJson(req);
      const sectId = typeof body.sectId === 'string' ? body.sectId : null;
      const sectName = typeof body.sectName === 'string' ? body.sectName : null;
      await familySvc.setSect(familyId, sectId, sectName);
      send(res, 200, ok({}));
      return true;
    }
  }

  // Recompute + persist prosperity from a worldsvc-supplied territoryCount (worldsvc owns tile ownership)
  {
    const m = /^\/internal\/family\/([^/]+)\/prosperity\/refresh$/.exec(path);
    if (method === 'POST' && m) {
      const familyId = decodeURIComponent(m[1]!);
      const body = await readJson(req);
      const territoryCount = typeof body.territoryCount === 'number' ? body.territoryCount : 0;
      const prosperity = await familySvc.refreshProsperity(familyId, territoryCount);
      send(res, 200, ok({ prosperity }));
      return true;
    }
  }

  // Merged activity bump + prosperity refresh (comm-audit batch F item 9): worldsvc's bumpFamilyActivity
  // always calls these two back-to-back for the same familyId — one round trip instead of two.
  {
    const m = /^\/internal\/family\/([^/]+)\/activity-and-prosperity$/.exec(path);
    if (method === 'POST' && m) {
      const familyId = decodeURIComponent(m[1]!);
      const body = await readJson(req);
      const delta = typeof body.delta === 'number' ? body.delta : 1;
      const territoryCount = typeof body.territoryCount === 'number' ? body.territoryCount : 0;
      const prosperity = await familySvc.bumpActivityAndProsperity(familyId, delta, territoryCount);
      send(res, 200, ok({ prosperity }));
      return true;
    }
  }

  // Zero SLG season state on world reset (called by worldsvc's resetSeason, SLG_DESIGN §17.3)
  {
    const m = /^\/internal\/family\/([^/]+)\/slg-reset$/.exec(path);
    if (method === 'POST' && m) {
      const familyId = decodeURIComponent(m[1]!);
      await familySvc.resetSlgState(familyId);
      send(res, 200, ok({}));
      return true;
    }
  }

  return false;
}

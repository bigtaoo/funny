// worldsvc httpApi split — internal /admin/world/* branch (C4/§17.7, X-Internal-Key auth, no JWT)
// (see ../httpApi.ts for the module overview). No behavior change — copied verbatim.
import type { IncomingMessage, ServerResponse } from 'http';
import { ErrorCode, SlgError, createLogger, ok, err, type InternalAuthVerifier } from '@nw/shared';
import { readJson, send, sendErr, numQ, type RouteDeps } from './helpers';

const log = createLogger('worldsvc');

/**
 * Handles the internal ops branch: /admin/world/* uses X-Internal-Key, checked before JWT.
 * Any logged-in player could previously call /admin/world/reset to wipe an entire region (C4
 * security hole); this branch is only reachable when `aurl.pathname` already starts with
 * `/admin/world/` (checked by the caller in ../httpApi.ts before JWT verification runs) —
 * every path inside always sends a response, so this function has no "not matched" return.
 */
export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  aurl: URL,
  internalAuth: InternalAuthVerifier,
  deps: RouteDeps,
): Promise<void> {
  const { svc, mapTemplateSvc } = deps;
  if (!internalAuth.verify(req.headers).ok) {
    return sendErr(res, ErrorCode.UNAUTHENTICATED, 'internal endpoint requires X-Internal-Key');
  }

  // ── Map templates (§24 Layer A, admin map editor) — self-contained sub-branch, any method, no worldId gate. ──
  if (aurl.pathname.startsWith('/admin/world/map-templates')) {
    try {
      if (method === 'GET' && aurl.pathname === '/admin/world/map-templates') {
        return send(res, 200, ok(await mapTemplateSvc.listTemplates()));
      }
      if (method === 'POST' && aurl.pathname === '/admin/world/map-templates/generate') {
        const body = await readJson(req);
        const templateId = typeof body.templateId === 'string' ? body.templateId : '';
        const summary = await mapTemplateSvc.generateTemplate(templateId, Number(body.width), Number(body.height));
        return send(res, 200, ok(summary));
      }
      const tilesMatch = /^\/admin\/world\/map-templates\/([^/]+)\/tiles$/.exec(aurl.pathname);
      if (tilesMatch) {
        const templateId = decodeURIComponent(tilesMatch[1]!);
        if (method === 'GET') {
          const tiles = await mapTemplateSvc.getTiles(
            templateId,
            numQ(aurl.searchParams.get('x'), 0),
            numQ(aurl.searchParams.get('y'), 0),
            numQ(aurl.searchParams.get('w'), 100),
            numQ(aurl.searchParams.get('h'), 100),
          );
          return send(res, 200, ok(tiles));
        }
        if (method === 'PUT') {
          const body = await readJson(req);
          const result = await mapTemplateSvc.saveTilesDiff(templateId, Array.isArray(body.tiles) ? (body.tiles as never[]) : []);
          return send(res, 200, ok(result));
        }
      }
      const activateMatch = /^\/admin\/world\/map-templates\/([^/]+)\/activate$/.exec(aurl.pathname);
      if (method === 'POST' && activateMatch) {
        await mapTemplateSvc.setActiveTemplate(decodeURIComponent(activateMatch[1]!));
        return send(res, 200, ok({}));
      }
      const deleteMatch = /^\/admin\/world\/map-templates\/([^/]+)$/.exec(aurl.pathname);
      if (method === 'DELETE' && deleteMatch) {
        await mapTemplateSvc.deleteTemplate(decodeURIComponent(deleteMatch[1]!));
        return send(res, 200, ok({}));
      }
      return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
    } catch (e) {
      if (e instanceof SlgError) return sendErr(res, e.code, e.message);
      // Never leak the raw exception message (stack traces, file paths, DB error text) to
      // the caller — comm-audit-2026-07-27 finding B15, mirrored here 2026-07-28 (auctionsvc
      // already had this fix; worldsvc did not).
      log.error('unhandled error (map-templates)', { err: e instanceof Error ? e : String(e) });
      return send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
    }
  }

  // List summary of all regions (G7/§17.7 admin console).
  if (method === 'GET' && aurl.pathname === '/admin/world/list') {
    try {
      return send(res, 200, ok(await svc.listWorlds()));
    } catch (e) {
      if (e instanceof SlgError) return sendErr(res, e.code, e.message);
      log.error('unhandled error (world list)', { err: e instanceof Error ? e : String(e) });
      return send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
    }
  }
  // Cross-region isolation patrol (G6/§20): cross-region march / dual-account detection / orphan tile scan.
  if (method === 'GET' && aurl.pathname === '/admin/world/patrol') {
    try {
      return send(res, 200, ok(await svc.patrolShardIsolation()));
    } catch (e) {
      if (e instanceof SlgError) return sendErr(res, e.code, e.message);
      log.error('unhandled error (patrol)', { err: e instanceof Error ? e : String(e) });
      return send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
    }
  }
  if (method !== 'POST') return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    log.error('unhandled error (readJson)', { err: e instanceof Error ? e : String(e) });
    return sendErr(res, ErrorCode.BAD_REQUEST, 'invalid request body');
  }
  // New-season region allocation (G6/§20): open N regions using snake-draft balancing based on last season's sect strength, no worldId required (checked before the worldId gate).
  if (aurl.pathname === '/admin/world/allocate') {
    try {
      const seasonNum = Number(body.season);
      if (!Number.isFinite(seasonNum)) return sendErr(res, ErrorCode.BAD_REQUEST, 'season required');
      const cap = body.capacity != null ? Number(body.capacity) : undefined;
      if (cap != null && !Number.isFinite(cap)) return sendErr(res, ErrorCode.BAD_REQUEST, 'capacity must be a number');
      return send(res, 200, ok(await svc.allocateNextSeason(seasonNum, cap)));
    } catch (e) {
      if (e instanceof SlgError) return sendErr(res, e.code, e.message);
      log.error('unhandled error (allocate)', { err: e instanceof Error ? e : String(e) });
      return send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
    }
  }
  const worldId = typeof body.worldId === 'string' ? body.worldId : null;
  if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
  try {
    if (aurl.pathname === '/admin/world/open') {
      const seasonN = Number(body.season ?? 1);
      const shardN = Number(body.shard ?? 1);
      const capacityN = Number(body.capacity ?? 10000);
      if (!Number.isFinite(seasonN) || !Number.isFinite(shardN) || !Number.isFinite(capacityN)) {
        return sendErr(res, ErrorCode.BAD_REQUEST, 'season/shard/capacity must be numbers');
      }
      await svc.openSeason(worldId, seasonN, shardN, capacityN);
      // §24: clone the active map template's tiles as this world's terrain baseline (copy, not a live reference).
      // No-op if no template is marked active — behavior is unchanged (proceduralTile-only) until ops sets one.
      await mapTemplateSvc.cloneActiveTemplateInto(worldId);
      return send(res, 200, ok({}));
    }
    if (aurl.pathname === '/admin/world/settle') {
      return send(res, 200, ok(await svc.settleSeason(worldId)));
    }
    if (aurl.pathname === '/admin/world/reset') {
      const reset = await svc.resetSeason(worldId);
      // §24 (2026-07-27 audit finding): mirrors /admin/world/open's clone step. resetSeason re-stamps
      // mapW/mapH from current config, so a stale baseline from before a map-size change (or a template
      // swap) must be replaced, not left in place — cloneActiveTemplateInto deletes+re-clones from
      // whichever template is active now (still a safe no-op if none is).
      await mapTemplateSvc.cloneActiveTemplateInto(worldId);
      return send(res, 200, ok(reset));
    }
    if (aurl.pathname === '/admin/world/close') {
      await svc.closeSeason(worldId);
      return send(res, 200, ok({}));
    }
    // Shard merge (G6/§27): move every remaining player out of worldId (source) into body.targetWorldId, then close worldId.
    if (aurl.pathname === '/admin/world/merge') {
      const targetWorldId = typeof body.targetWorldId === 'string' ? body.targetWorldId : null;
      if (!targetWorldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'targetWorldId required');
      return send(res, 200, ok(await svc.mergeShard(worldId, targetWorldId)));
    }
    return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
  } catch (e) {
    if (e instanceof SlgError) return sendErr(res, e.code, e.message);
    log.error('unhandled error (season ops)', { err: e instanceof Error ? e : String(e) });
    return send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
  }
}

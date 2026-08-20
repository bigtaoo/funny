// admin httpApi split — trust & safety review queues: achievement anti-cheat, UGC reports, player
// appeals, player feedback (see ../httpApi.ts for the module overview). All four share the same
// list+resolve review-queue shape. No behavior change — copied verbatim from the original httpApi.ts.
//
// Plus two read-only anti-cheat signal lists that have no resolve half at all (C3 hash mismatches, C4
// suspicious-PvE roster). Both were removed on 2026-07-28 as unreachable and restored on 2026-08-20 once
// the both-directions check showed their producers had never stopped writing — see OPS_DESIGN.md
// 「反作弊两张信号表（C3/C4 补顶层，2026-08-20）」. They live here rather than in monitorRoutes (their
// physical home in the pre-split httpApi.ts) because `anticheat.view` gates them and the review queue
// alike, and an operator reads all three together.
import { send, requireCap, readJson, str, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleTrustSafetyRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, url, actor, svc } = ctx;

  // ── Achievement anti-cheat review queue (S9-7) ──
  if (method === 'GET' && path === '/admin/anticheat/reviews') {
    requireCap(actor, 'anticheat.view');
    const accountId = url.searchParams.get('accountId') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
    const reviews = await svc.listAntiCheatReviews(actor.adminId, {
      ...(accountId ? { accountId } : {}),
      ...(status ? { status } : {}),
      limit,
    });
    send(res, 200, { ok: true, reviews });
    return true;
  }

  // ── Resolve an anti-cheat review (anticheat.action): human decides dismiss vs ban ──
  const reviewResolveMatch = path.match(/^\/admin\/anticheat\/reviews\/([^/]+)\/resolve$/);
  if (method === 'POST' && reviewResolveMatch) {
    requireCap(actor, 'anticheat.action');
    const id = decodeURIComponent(reviewResolveMatch[1] ?? '');
    const b = await readJson(req);
    const resolution = str(b.resolution);
    if (resolution !== 'dismissed' && resolution !== 'banned') {
      send(res, 400, { ok: false, error: 'resolution must be dismissed or banned' });
      return true;
    }
    await svc.resolveAntiCheatReview(actor.adminId, id, str(b.accountId), resolution);
    send(res, 200, { ok: true });
    return true;
  }

  // ── Unresolved hash-mismatch match list (C3, read-only) ──
  // `matches.hashMismatch` marks a ranked/friendly match whose two clients disagreed on the final state
  // hash AND that the peer judge could not adjudicate; those docs are deliberately exempt from the 7-day
  // TTL so they stay reviewable. Last 24 h, capped at 200 rows by meta.
  if (method === 'GET' && path === '/admin/mismatches') {
    requireCap(actor, 'anticheat.view');
    const rows = await svc.listMismatches();
    send(res, 200, { ok: true, mismatches: rows });
    return true;
  }

  // ── Suspicious-PvE account roster (C4, read-only) ──
  // `accounts.flags.pveWarnings` counts rejected PvE spot-checks. Since 2026-07-18 it is purely a
  // review signal (no longer a ban trigger), so this list is its only reader; acting on a row means
  // the manual ban in playerRoutes (`anticheat.action`), never anything automatic.
  if (method === 'GET' && path === '/admin/suspicious-pve') {
    requireCap(actor, 'anticheat.view');
    const rows = await svc.listSuspiciousPve();
    send(res, 200, { ok: true, accounts: rows });
    return true;
  }

  // ── UGC report review queue (reports.view/.action, CONTENT_MODERATION_DESIGN.md CM9/CM11) ──
  if (method === 'GET' && path === '/admin/reports') {
    requireCap(actor, 'reports.view');
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
    const reports = await svc.listReports(actor.adminId, { ...(status ? { status } : {}), limit });
    send(res, 200, { ok: true, reports });
    return true;
  }
  const reportResolveMatch = path.match(/^\/admin\/reports\/([^/]+)\/resolve$/);
  if (method === 'POST' && reportResolveMatch) {
    requireCap(actor, 'reports.action');
    const id = decodeURIComponent(reportResolveMatch[1] ?? '');
    const b = await readJson(req);
    const resolution = str(b.resolution);
    if (resolution !== 'dismissed' && resolution !== 'upheld') {
      send(res, 400, { ok: false, error: 'resolution must be dismissed or upheld' });
      return true;
    }
    const penalty = await svc.resolveReport(actor, id, str(b.accountId), resolution);
    send(res, 200, { ok: true, ...penalty });
    return true;
  }

  // ── Player appeal review queue (appeals.view/.action, CONTENT_MODERATION_DESIGN.md CM10/CM11) ──
  if (method === 'GET' && path === '/admin/appeals') {
    requireCap(actor, 'appeals.view');
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
    const appeals = await svc.listAppeals(actor.adminId, { ...(status ? { status } : {}), limit });
    send(res, 200, { ok: true, appeals });
    return true;
  }
  const appealResolveMatch = path.match(/^\/admin\/appeals\/([^/]+)\/resolve$/);
  if (method === 'POST' && appealResolveMatch) {
    requireCap(actor, 'appeals.action');
    const id = decodeURIComponent(appealResolveMatch[1] ?? '');
    const b = await readJson(req);
    const resolution = str(b.resolution);
    if (resolution !== 'approved' && resolution !== 'denied') {
      send(res, 400, { ok: false, error: 'resolution must be approved or denied' });
      return true;
    }
    const note = typeof b.note === 'string' ? b.note : undefined;
    await svc.resolveAppeal(actor, id, resolution, note);
    send(res, 200, { ok: true });
    return true;
  }

  // ── Player feedback (feedback.view — UI_DESIGN.md §4.1.1 / SERVER_API.md §2.13) ──
  if (method === 'GET' && path === '/admin/feedback') {
    requireCap(actor, 'feedback.view');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
    const feedback = await svc.listFeedback(actor.adminId, { limit });
    send(res, 200, { ok: true, feedback });
    return true;
  }

  // ── Feedback triage (feedback.action): mark read and/or attach an ops note. Not a verdict —
  // there is no dismiss/uphold outcome here, unlike the three queues above.
  const feedbackReviewMatch = path.match(/^\/admin\/feedback\/([^/]+)\/review$/);
  if (method === 'POST' && feedbackReviewMatch) {
    requireCap(actor, 'feedback.action');
    const id = decodeURIComponent(feedbackReviewMatch[1] ?? '');
    const b = await readJson(req);
    // Absent `note` = read-mark only (leaves an existing note intact); `''` explicitly clears it.
    const note = typeof b.note === 'string' ? b.note : undefined;
    await svc.reviewFeedback(actor.adminId, id, note);
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}

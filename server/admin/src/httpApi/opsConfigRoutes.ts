// admin httpApi split — ops audit log + the three live-tunable config-override surfaces (feature flags,
// SLG shop prices, content-moderation wordlists — see ../httpApi.ts for the module overview). No behavior
// change — copied verbatim from the original httpApi.ts.
import { send, requireCap, readJson, str, numOpt, type RouteCtx } from './helpers';

/** Returns true once matched + a response was sent; false lets the next handler in the chain try. */
export async function handleOpsConfigRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, path, url, actor, svc } = ctx;

  // ── Audit ──
  if (method === 'GET' && path === '/admin/audit') {
    requireCap(actor, 'audit.view.self');
    const entries = await svc.listAudit(actor, {
      ...(url.searchParams.get('actor') ? { actor: url.searchParams.get('actor')! } : {}),
      from: numOpt(url.searchParams.get('from')),
      to: numOpt(url.searchParams.get('to')),
    });
    send(res, 200, { ok: true, entries });
    return true;
  }

  // ── Feature flags (config.manage) ──
  if (method === 'GET' && path === '/admin/config/flags') {
    requireCap(actor, 'config.manage');
    send(res, 200, { ok: true, flags: await svc.getConfigFlags() });
    return true;
  }
  const flagPut = /^\/admin\/config\/flags\/([^/]+)$/.exec(path);
  if (method === 'PUT' && flagPut) {
    requireCap(actor, 'config.manage');
    const key = decodeURIComponent(flagPut[1]!);
    const b = await readJson(req);
    const flag = await svc.upsertFlag(actor, key, {
      ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
      ...(b.rollout !== undefined ? { rollout: b.rollout } : {}),
      ...(typeof b.desc === 'string' ? { desc: b.desc } : {}),
    });
    send(res, 200, { ok: true, flag });
    return true;
  }

  // ── SLG shop price overrides (slg.shop.manage) ──
  if (method === 'GET' && path === '/admin/config/slg-shop') {
    requireCap(actor, 'slg.shop.manage');
    send(res, 200, { ok: true, items: await svc.getShopConfig() });
    return true;
  }
  const shopPut = /^\/admin\/config\/slg-shop\/([^/]+)$/.exec(path);
  if (method === 'PUT' && shopPut) {
    requireCap(actor, 'slg.shop.manage');
    const id = decodeURIComponent(shopPut[1]!);
    const b = await readJson(req);
    const item = await svc.upsertShopItem(actor, id, {
      ...(b.cost !== undefined ? { cost: b.cost } : {}),
      ...(b.effect !== undefined ? { effect: b.effect } : {}),
    });
    send(res, 200, { ok: true, item });
    return true;
  }

  // ── Content-moderation word list overlays (moderation.wordlist.manage, CONTENT_MODERATION_DESIGN §3.2) ──
  if (method === 'GET' && path === '/admin/moderation/wordlists') {
    requireCap(actor, 'moderation.wordlist.manage');
    send(res, 200, { ok: true, regions: await svc.getWordlistConfig() });
    return true;
  }
  const wordlistAdd = /^\/admin\/moderation\/wordlists\/([^/]+)\/words$/.exec(path);
  if (method === 'POST' && wordlistAdd) {
    requireCap(actor, 'moderation.wordlist.manage');
    const region = decodeURIComponent(wordlistAdd[1]!);
    const b = await readJson(req);
    const doc = await svc.addWord(actor, region, str(b.word));
    send(res, 200, { ok: true, doc });
    return true;
  }
  const wordlistRemove = /^\/admin\/moderation\/wordlists\/([^/]+)\/words\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && wordlistRemove) {
    requireCap(actor, 'moderation.wordlist.manage');
    const region = decodeURIComponent(wordlistRemove[1]!);
    const word = decodeURIComponent(wordlistRemove[2]!);
    const doc = await svc.removeWord(actor, region, word);
    send(res, 200, { ok: true, doc });
    return true;
  }

  return false;
}

// Cloudflare Worker for the ops admin panel (paired with wrangler.ops.jsonc).
//
// Two responsibilities:
//   1. Static assets (page + bundle) are served directly from the assets binding (ASSETS), with SPA fallback to index.html.
//   2. /admin/* is the API path used by the ops frontend to reach the admin backend — this Worker reverse-proxies it at the edge
//      to the admin backend on the VPS (env.ADMIN_ORIGIN), injecting the shared secret header X-Ops-Proxy-Secret.
//      Caddy on the VPS validates this header: missing secret → 403 (players cannot reach admin even if they bypass CF Access).
//
// Why same-origin reverse proxy: the entire ops.gamestao.com is protected by a single CF Access application; after the browser
// logs in, CF_Authorization is a first-party cookie and is automatically included in /admin/* fetches, avoiding CORS issues.
// Design: design/product/deploy-cloudflare.md §6.
//
// Configuration dependencies (see wrangler.ops.jsonc / wrangler secret):
//   · env.ADMIN_ORIGIN       — admin backend base URL, e.g. https://api.gamestao.com/ops (vars, may be public)
//   · env.ADMIN_PROXY_SECRET — shared secret matching NW_OPS_PROXY_SECRET on the VPS (secret, never committed to git)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only /admin/* routes go through the reverse proxy (wrangler run_worker_first ensures these paths reach the Worker first, before the SPA fallback can swallow them).
    if (url.pathname.startsWith('/admin/')) {
      if (!env.ADMIN_ORIGIN) {
        return new Response('ops Worker: ADMIN_ORIGIN not configured', { status: 502 });
      }
      const target = env.ADMIN_ORIGIN.replace(/\/$/, '') + url.pathname + url.search;
      const headers = new Headers(request.headers);
      if (env.ADMIN_PROXY_SECRET) headers.set('X-Ops-Proxy-Secret', env.ADMIN_PROXY_SECRET);
      const method = request.method;
      const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
      return fetch(target, { method, headers, body, redirect: 'manual' });
    }

    // All other paths: serve static assets / SPA fallback.
    return env.ASSETS.fetch(request);
  },
};

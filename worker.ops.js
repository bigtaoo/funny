// ops 运维后台的 Cloudflare Worker（配 wrangler.ops.jsonc）。
//
// 两件事：
//   1. 静态资源（页面 + bundle）由 assets 绑定直出（ASSETS），SPA 回退到 index.html。
//   2. /admin/* 是 ops 前端调 admin 后端的 API 路径——本 Worker 在边缘把它反代到
//      VPS 上的 admin 后端（env.ADMIN_ORIGIN），并注入共享密钥头 X-Ops-Proxy-Secret。
//      VPS 的 Caddy 校验该头：无密钥→403（玩家即使绕过 CF Access 也打不进 admin）。
//
// 为什么同源反代：整个 ops.gamestao.com 由一个 CF Access 应用保护，浏览器登录后
// CF_Authorization 是第一方 cookie，/admin/* 的 fetch 自动带上，无跨域踩坑。
// 设计：design/product/deploy-cloudflare.md §6。
//
// 配置依赖（见 wrangler.ops.jsonc / wrangler secret）：
//   · env.ADMIN_ORIGIN      —— admin 后端入口基址，形如 https://api.gamestao.com/ops（vars，可公开）
//   · env.ADMIN_PROXY_SECRET —— 与 VPS 端 NW_OPS_PROXY_SECRET 同值的共享密钥（secret，绝不进 git）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 仅 /admin/* 走反代（wrangler run_worker_first 已保证这些路径先到 Worker、不被 SPA 回退吃掉）。
    if (url.pathname.startsWith('/admin/')) {
      if (!env.ADMIN_ORIGIN) {
        return new Response('ops Worker 未配置 ADMIN_ORIGIN', { status: 502 });
      }
      const target = env.ADMIN_ORIGIN.replace(/\/$/, '') + url.pathname + url.search;
      const headers = new Headers(request.headers);
      if (env.ADMIN_PROXY_SECRET) headers.set('X-Ops-Proxy-Secret', env.ADMIN_PROXY_SECRET);
      const method = request.method;
      const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
      return fetch(target, { method, headers, body, redirect: 'manual' });
    }

    // 其余路径：静态资源 / SPA 回退。
    return env.ASSETS.fetch(request);
  },
};

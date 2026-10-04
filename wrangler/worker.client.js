// Cloudflare Worker for the game client site (paired with client.jsonc).
//
// Everything is served straight from the static assets binding. The Worker only runs first for
// /review/* (run_worker_first in client.jsonc), so the game and the website pages never touch it.
//
// Why it exists: the static assets path answers a `Range` request with a full 200 (measured
// 2026-10-04 on nivara.gamestao.com, every file, cache HIT or not). Safari — macOS and iOS — will
// not play an MP4 from a server that does not answer byte ranges with 206, and /review/ holds the
// App Review screen recording linked from App Store Connect, which a reviewer most likely opens in
// Safari. So this slices the asset into a 206 itself. The files there are a few MB; buffering one
// whole is well inside the Worker memory limit.
// Design: design/product/deploy-cloudflare.md §6.

/** Parses a single `bytes=` range against `size`. Returns null when unsatisfiable, undefined when absent/unsupported. */
export function parseRange(header, size) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined; // multi-range or garbage: fall back to a full 200
  let start;
  let end;
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // A ranged HEAD still needs the real body length, so read the asset with GET.
    const ranged = url.pathname.startsWith('/review/') && request.headers.has('Range');
    const res = await env.ASSETS.fetch(ranged ? new Request(request, { method: 'GET' }) : request);
    if (!url.pathname.startsWith('/review/') || res.status !== 200) return res;

    const headers = new Headers(res.headers);
    headers.set('Accept-Ranges', 'bytes');
    const rangeHeader = request.headers.get('Range');
    if (!rangeHeader) return new Response(res.body, { status: 200, headers });

    const body = await res.arrayBuffer();
    const size = body.byteLength;
    const range = parseRange(rangeHeader, size);
    if (range === undefined) return new Response(body, { status: 200, headers });
    if (range === null) {
      headers.set('Content-Range', `bytes */${size}`);
      headers.delete('Content-Length');
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    const slice = request.method === 'HEAD' ? null : body.slice(range.start, range.end + 1);
    return new Response(slice, { status: 206, headers });
  },
};

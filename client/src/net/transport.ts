// transport.ts — the client's single outbound REST seam (ASSET_PACKAGING §4.3/§4.4 item 1).
//
// Every REST call the client makes goes through this one indirection: metaserver (ApiClient),
// worldsvc/socialsvc/auctionsvc (WorldApiClient), anomaly telemetry, analytics. Web / CrazyGames /
// the Capacitor shell keep the global `fetch`; the WeChat mini-game installs a wx.request-backed
// implementation at boot (platform/wechat/wechatTransport.ts, wired in entries/wechat.ts) — the
// same shape setAssetIO / setAudioBus already use.
//
// ## ⚠️ NOT an asset loader
//
// Package/CDN bytes do NOT belong here. They go through assets/assetIO.ts (wx.downloadFile +
// USER_DATA_PATH cache), and `settings.ADAPTER.fetch` throws a named error on purpose — anything
// reaching for HTTP to read a file that is already in the package is a packaging-boundary mistake
// and should fail loudly. This seam only ever sees API base URLs.
//
// ## Why a seam, and not a `globalThis.fetch` polyfill in platform/wechat/wechatHost.ts
//
// The polyfill is a one-file change that leaves the REST layer untouched, and it was the other
// candidate. Three reasons it loses:
//
//  1. **A partial `fetch` is exactly the failure mode §4.3 exists to end.** wx.request cannot do
//     streams, redirect modes, `Request`/`Headers` objects, blobs, or a cookie jar. Publishing a
//     shim under the name `fetch` re-creates the thing that black-screened us on 2026-09-01: code
//     that reads a host global, gets something *almost* right, and only finds out on a device.
//     A named seam with five fields is a contract we can actually satisfy.
//  2. **It flips feature detection across code we don't own.** `typeof fetch === 'function'` is a
//     live branch in this repo (analytics' unload path used it) and inside third-party libraries;
//     PIXI's Assets picks its loaders that way too. Installing a global fetch silently re-routes
//     all of them onto HTTP — including, eventually, at asset URLs. The ⚠️ above stops being
//     enforceable.
//  3. **The gate could no longer tell the difference.** `test/wechatHostSurface.test.ts` scans for
//     bare `fetch(` in the WeChat-reachable graph. Under the polyfill every one of those call sites
//     stays and has to be waved through with `// dom-ok:`, i.e. the debt list turns into the
//     whitelist its own header warns about. Under the seam they simply stop existing.
//
// What the polyfill would have bought — "the REST layer doesn't change" — is worth little here:
// the call sites already funnel through two `core.ts` transport helpers plus three fire-and-forget
// telemetry sends, so the seam costs six call sites total.

/** One outbound REST request. Absolute `url`; callers own base-url resolution and serialization. */
export interface NetRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Already-serialized body (every caller JSON.stringifies its own). Absent = send no body. */
  readonly body?: string;
  /**
   * Caller-owned deadline / cancellation. Both implementations abort the in-flight request and
   * reject with an `AbortError`-named Error — the callers' own `AbortController` + `setTimeout`
   * pairs (ADR-058's 10s metaserver timeout, WorldApiCore's per-call `timeoutMs`) are unchanged
   * and stay the single source of the deadline.
   */
  readonly signal?: AbortSignal;
  /** Survive page unload. Web: `keepalive`. WeChat: no equivalent — see WechatTransport. */
  readonly keepalive?: boolean;
  /** Web only. WeChat has no cookie jar, so uncredentialed is already the only behaviour there. */
  readonly credentials?: 'omit';
}

/**
 * The slice of the `Response` contract the REST layer actually reads. A real `Response` satisfies
 * it structurally, which is why the web path can hand its own response straight back with no
 * wrapper (and why every existing test's `{ status, json }` fetch fake keeps working verbatim).
 */
export interface NetResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface NetTransport {
  request(req: NetRequest): Promise<NetResponse>;
}

/**
 * Web / CrazyGames / Capacitor shell: the global `fetch`, byte-for-byte the init object the call
 * sites used to build themselves. Optional fields are omitted rather than passed as `undefined`
 * so the request looks identical to a hand-written one.
 */
class FetchTransport implements NetTransport {
  async request(req: NetRequest): Promise<NetResponse> {
    const init: RequestInit = { method: req.method, headers: req.headers };
    if (req.body !== undefined) init.body = req.body;
    if (req.signal) init.signal = req.signal;
    if (req.keepalive) init.keepalive = true;
    if (req.credentials) init.credentials = req.credentials;
    return fetch(req.url, init); // dom-ok: this IS the seam's web implementation; WeChat replaces the whole object at boot (platform/wechat/wechatTransport.ts)
  }
}

/** The default. Exported so a test that installed another transport can put this one back. */
export const fetchTransport: NetTransport = new FetchTransport();

let active: NetTransport = fetchTransport;

/** Install a platform transport (WeChat: `new WechatTransport()`). Call once at boot. */
export function setNetTransport(t: NetTransport): void {
  active = t;
}

/** The active transport (fetch-backed until a platform installs its own). */
export function netTransport(): NetTransport {
  return active;
}

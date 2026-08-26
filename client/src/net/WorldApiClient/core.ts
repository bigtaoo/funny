// Shared foundation for the WorldApiClient composition (see ../WorldApiClient.ts assembly).
//
// WorldApiCore owns the storage-backed auth token read, the shared req() transport helper, and
// the worldsvc health probe — all `public` so the sibling domain classes below can call them via
// an injected `core` reference: this.core.req(...). Each REST domain (world · troops/defense/teams
// /buildings/CC-4 · siege replay · nations/season · SLG shop · family · auction · sect · world
// channel) is its own independent class in a sibling file, constructed with `core` and composed
// into the final WorldApiClient facade (2026-08-11: converted from a single 700+ line flat class —
// zero cross-domain `this.*` calls except listFamilies→getMyFamily, both kept together in
// ./family.ts — see claudedocs/client-modules.md's split-form priority note).
import { getWorldBaseUrl } from '../config';
import type { IStorage } from '../../platform/IPlatform';
import { requestPlatformHeader } from '../ApiClient/core';
import { maybePromptAppeal } from '../log';
import { globalRequestGate } from '../rateGate';

const TOKEN_KEY = 'nw_token';

export class WorldApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WorldApiError';
  }
}

export class WorldApiCore {
  constructor(private readonly storage: IStorage) {}

  get available(): boolean {
    // '' (Docker/prod same-origin proxy) and 'http://...' (dev explicit URL) are both valid
    // — worldsvc is reachable in any standard build. The old `!== ''` guard was wrong.
    return true;
  }

  /**
   * Ping worldsvc /health. Returns false ONLY on a definitive non-2xx response
   * from a reachable server (e.g. 503 = up-but-unhealthy).
   *
   * The probe is a plain cross-origin fetch that reads the status. This works because
   * Caddy routes /health → worldsvc (see server/Caddyfile), and worldsvc's /health
   * sends `access-control-allow-origin: *` like its other public routes — so the read
   * is CORS-allowed and no red "Cross-Origin Request Blocked" error is logged. (Before
   * that route existed, /health fell through to Caddy's CORS-less fallback and the
   * browser blocked the read.)
   *
   * A thrown fetch (timeout / connection refused) is treated as INCONCLUSIVE →
   * returns true (no offline badge). Rationale: better to let the user click through
   * and hit real error handling than to mislabel a working service as offline. This
   * is an expected, harmless condition, so it's logged as a warning, not an error.
   */
  async checkHealth(): Promise<boolean> {
    const base = getWorldBaseUrl();
    // Empty base = same-origin nginx proxy (Docker/production). worldsvc is guaranteed
    // up by the Docker healthcheck; no external ping needed or possible (nginx only
    // routes /world* /auction* (family moved to socialsvc /social/family/*), not
    // /health). Return true immediately.
    if (!base) return true;
    try {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(id);
      return res.ok;
    } catch {
      // Inconclusive (timeout / connection refused) — do not claim offline. Warn,
      // don't error: this is an expected, harmless condition (see method doc).
      console.warn(`[world] /health probe inconclusive for ${base}; assuming reachable`);
      return true;
    }
  }

  token(): string | null {
    return this.storage.getItem(TOKEN_KEY);
  }

  async req<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
    baseOverride?: string,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const base = baseOverride ?? getWorldBaseUrl();
    const url = base + path;
    const token = this.token();
    // X-NW-Platform (ADR-020): which recharged-pool bucket a spend should draw from. Worldsvc/auction
    // spend paths never sent this (comm-audit-internal-2026-07-28 P0-7) — iOS/Android players got
    // charged from the web bucket for SLG/auction purchases, same field ApiClient/core.ts sends.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-NW-Platform': requestPlatformHeader(),
      ...extraHeaders,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    await globalRequestGate.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // AbortError → convert to TypeError so callers see a consistent network failure.
      // eslint-disable-next-line preserve-caught-error -- `{ cause: e }` needs the ES2022 Error lib and tsconfig targets ES2020; String(e) keeps the original in the message.
      throw new TypeError(`world api ${method} ${path} failed: ${String(e)}`);
    } finally {
      clearTimeout(timer);
    }

    // Standard @nw/shared ApiResp envelope: { ok:false, error:{ code, message } }
    // (same shape metaserver's ApiClient reads). NOT top-level code/message — reading
    // json.code here silently collapsed every world/auction/social error to 'UNKNOWN',
    // breaking the AuctionScene error-code→toast mapping. Kept tolerant of a missing error.
    const json = (await res.json()) as {
      ok: boolean;
      data?: T;
      error?: { code?: string; message?: string };
    };
    if (!json.ok) {
      maybePromptAppeal(json.error?.code ?? 'UNKNOWN');
      throw new WorldApiError(
        json.error?.code ?? 'UNKNOWN',
        json.error?.message ?? 'world api error'
      );
    }
    return json.data as T;
  }
}

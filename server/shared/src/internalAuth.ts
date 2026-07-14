// Internal service-to-service HTTP authentication (S12-1).
//
// Background: Internal ports (commercial / matchsvc / gateway internal face / meta /internal/* / analyticsvc /internal/query)
// are unreachable by players and are authenticated via a shared secret `X-Internal-Key`. This module consolidates
// the scattered `=== internalKey` checks on the callee side into a single centralized verifier, adding three things:
//   1. timing-safe comparison (avoids byte-by-byte timing side-channels);
//   2. per-caller key registry (NW_INTERNAL_KEYS) — one key per caller, localizing exposure + enabling identification + per-service rotation;
//   3. matched-caller identification (audit log / rejection alerts carry a caller hint).
//
// Decoupled from ticket HMAC (@nw/shared/ticket): tickets still use a single NW_INTERNAL_KEY for signing/verification
// (matchsvc↔gameserver must share the same key); this module only handles internal HTTP authentication.
// Player JWTs and internal keys are naturally in different namespaces — internal routes never validate JWTs,
// and a player JWT placed in the Authorization header will never match X-Internal-Key; the mismatch is structural.
//
// Design reference: SERVER_API.md "Internal Authentication Model" / META_DESIGN.md.
import { timingSafeEqual } from 'node:crypto';

/** Internal key header (lowercase — node http / fastify req.headers are always lowercased). */
export const INTERNAL_KEY_HEADER = 'x-internal-key';
/** Caller identity header (audit use only; in strict mode identity is proven by the key itself, this header is advisory). */
export const INTERNAL_CALLER_HEADER = 'x-internal-caller';

/** Registered internal callers. New processes register here and receive an independent key in NW_INTERNAL_KEYS. */
export type InternalCaller =
  | 'gateway'
  | 'gameserver'
  | 'matchsvc'
  | 'meta'
  | 'commercial'
  | 'worldsvc'
  | 'admin'
  | 'analyticsvc'
  | 'socialsvc'
  | 'auctionsvc'
  | 'botsvc';

/** Timing-safe comparison of equal-length strings (returns false immediately on length mismatch, revealing no per-byte information beyond length). */
function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Parse NW_INTERNAL_KEYS: format `gateway=k1,meta=k2,worldsvc=k3` → `{gateway:'k1', meta:'k2', worldsvc:'k3'}`.
 * Missing / empty → `{}` (→ single shared key fallback mode). Fault-tolerant: skips segments with no `=` or empty name/value.
 */
export function parseInternalKeys(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const key = part.slice(i + 1).trim();
    if (name && key) out[name] = key;
  }
  return out;
}

let envKeysCache: Record<string, string> | undefined;
/** Process-level cached parse result for NW_INTERNAL_KEYS (avoids re-splitting on every outbound request). */
export function internalKeysFromEnv(): Record<string, string> {
  if (envKeysCache === undefined) envKeysCache = parseInternalKeys(process.env.NW_INTERNAL_KEYS);
  return envKeysCache;
}

/**
 * The key an outbound caller should include: uses its own entry from the per-caller registry if present,
 * otherwise falls back to the single shared key (legacy).
 * `registry` defaults to env (tests may pass it explicitly to avoid reading env).
 */
export function outboundInternalKey(
  caller: InternalCaller,
  legacyKey: string,
  registry: Record<string, string> = internalKeysFromEnv(),
): string {
  return registry[caller] ?? legacyKey;
}

/**
 * Outbound request headers: `{x-internal-key, x-internal-caller}`. The second parameter is the single shared key
 * (legacy fallback); internally the key is automatically upgraded to the caller-specific registry entry when available.
 */
export function internalHeaders(caller: InternalCaller, legacyKey: string): Record<string, string> {
  return {
    [INTERNAL_KEY_HEADER]: outboundInternalKey(caller, legacyKey),
    [INTERNAL_CALLER_HEADER]: caller,
  };
}

export interface InternalAuthResult {
  ok: boolean;
  /** Matched caller: in strict mode = the key's owner; in fallback mode = x-internal-caller hint (untrusted, audit only). */
  caller: string | null;
}

export interface InternalAuthVerifier {
  /** Whether per-caller strict mode is enabled (registry is non-empty). */
  readonly strict: boolean;
  verify(headers: Record<string, string | string[] | undefined>): InternalAuthResult;
}

function headerVal(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Internal HTTP authentication verifier.
 * - Registry non-empty → **strict per-caller**: the presented key must timing-safe equal a registered caller's key;
 *   the matching caller is identified. The full table is always traversed (no short-circuit) to maintain constant work.
 *   The legacy fallback key is **not** accepted in strict mode (migration requires all processes to be given NW_INTERNAL_KEYS simultaneously).
 * - Registry empty → **single shared key fallback** (compatible with legacy deployments, zero behavior change):
 *   the presented key is accepted if it equals legacyKey; caller is taken from the x-internal-caller header (audit hint only).
 */
export function createInternalAuth(opts: {
  keys?: Record<string, string>;
  legacyKey: string;
}): InternalAuthVerifier {
  const entries = Object.entries(opts.keys ?? {});
  const strict = entries.length > 0;
  return {
    strict,
    verify(headers): InternalAuthResult {
      const presented = headerVal(headers, INTERNAL_KEY_HEADER);
      if (!presented) return { ok: false, caller: null };
      if (strict) {
        let matched: string | null = null;
        for (const [name, key] of entries) {
          if (timingSafeEq(presented, key)) matched = name;
        }
        return matched ? { ok: true, caller: matched } : { ok: false, caller: null };
      }
      if (timingSafeEq(presented, opts.legacyKey)) {
        return { ok: true, caller: headerVal(headers, INTERNAL_CALLER_HEADER) ?? null };
      }
      return { ok: false, caller: null };
    },
  };
}

/** Build a verifier from env: keys=NW_INTERNAL_KEYS, legacyKey=provided (typically ServerEnv.internalKey). */
export function loadInternalAuth(legacyKey: string): InternalAuthVerifier {
  return createInternalAuth({ keys: internalKeysFromEnv(), legacyKey });
}

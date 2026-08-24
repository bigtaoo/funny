// Client log → Loki forwarding (FEATURE_FLAGS_DESIGN §9.4 / observability/README.md Phase 3).
//
// Loki ingestion convention: labels are only { source="client", level=... } (low cardinality, prevents index bloat);
// publicId / tag / msg are all placed **inline** (logfmt). Use `{source="client"} | logfmt | publicId="<9-digit>"` in Grafana to fetch a single player's logs.
// If Loki is unreachable → silently discard, never affect the player (POST /client/log always returns 200).

/** A single client log entry (same shape as the client-side ring-buffer entry). */
export interface ClientLogEntry {
  level: string; // error | warn | info | debug
  msg: string;
  ts: number; // epoch ms (client clock)
  tag?: string;
}

/** Allowlist of levels accepted into Loki (prevents clients from injecting arbitrary label values that inflate cardinality). */
const ALLOWED_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

/** logfmt value escaping: wrap in quotes and escape internal quotes and backslashes when the value contains spaces, quotes, or equals signs. */
function logfmtValue(v: string): string {
  if (v === '') return '""';
  if (!/[\s"=]/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Build a logfmt line: publicId is mandatory, tag is optional, msg comes last (most visible when reading). */
function buildLine(publicId: string, e: ClientLogEntry, platform?: string): string {
  const parts = [`publicId=${logfmtValue(publicId)}`];
  if (platform) parts.push(`platform=${logfmtValue(platform)}`);
  if (e.tag) parts.push(`tag=${logfmtValue(e.tag)}`);
  parts.push(`msg=${logfmtValue(e.msg)}`);
  return parts.join(' ');
}

/**
 * Assembles a batch of client logs into a Loki push payload (split by level, low-cardinality labels).
 * Timestamps are converted to nanosecond strings (Loki requires ns precision; BigInt is used to avoid 1e6 scientific notation / precision loss).
 * Returns null when there are no sendable entries (all levels invalid or batch is empty).
 */
export function buildLokiPayload(
  publicId: string,
  logs: ClientLogEntry[],
  platform: string | undefined,
  fallbackNs: () => string,
): { streams: { stream: Record<string, string>; values: [string, string][] }[] } | null {
  const byLevel = new Map<string, [string, string][]>();
  for (const e of logs) {
    const level = ALLOWED_LEVELS.has(e.level) ? e.level : 'info';
    const ns = Number.isFinite(e.ts) && e.ts > 0 ? (BigInt(Math.floor(e.ts)) * 1_000_000n).toString() : fallbackNs();
    const line = buildLine(publicId, e, platform);
    const arr = byLevel.get(level) ?? [];
    arr.push([ns, line]);
    byLevel.set(level, arr);
  }
  if (byLevel.size === 0) return null;
  const streams = [...byLevel.entries()].map(([level, values]) => ({
    stream: { source: 'client', level },
    values,
  }));
  return { streams };
}

// ── Client anomaly events reported in full → Loki (parallel and complementary to the targeted log collection above; not subject to allowPublicIds) ──
//
// Loki ingestion convention: labels are only { source="client", kind="anomaly" } (low cardinality);
// type/publicId/platform/device/dpr/mem/buildVersion/orient/vp/sinceRot/detail/msg are all placed
// **inline** (logfmt). Grafana: `{source="client",kind="anomaly"} | logfmt | type="webgl_lost"`.
//
// The device/orient/vp/sinceRot group was added 2026-08-24. Before it, `platform` (a BUILD TARGET —
// web | wechat | crazygames) was the only reporter attribute, so a phone and a desktop browser were
// indistinguishable in Loki and "it only crashes on mobile" was an unfalsifiable claim. Rotation-time
// failures were doubly invisible, orientation never having been recorded at all. Useful queries now:
//   {source="client",kind="anomaly"} | logfmt | device="phone"                     — mobile only
//   {source="client",kind="anomaly"} | logfmt | type="crash" | sinceRot < 2000      — died just after a rotate

/** A single client anomaly event (same shape as AnomalyEvent in the client-side net/anomaly.ts). */
export interface ClientAnomalyEvent {
  type: string; // mem | cpu | webgl_lost | anr | jserror | crash
  msg: string;
  ts: number; // epoch ms (client clock)
  detail?: string;
  // Moment-level device context (client net/anomaly/deviceContext.ts). Per-event rather than per-batch
  // because they change within one batch's debounce window — a crash report describes the orientation
  // of the session that DIED, while a jserror queued alongside it describes the live one.
  orient?: string;   // portrait | landscape
  vp?: string;       // viewport as WxH in CSS px
  sinceRot?: number; // ms since the last orientation flip; absent when the session never rotated
}

/** Session-stable reporter envelope, stamped onto every line of the batch. */
export interface ClientAnomalySession {
  platform?: string;     // build target: web | wechat | crazygames
  buildVersion?: string;
  device?: string;       // phone | tablet | desktop | unknown — the hardware bucket `platform` never carried
  dpr?: number;
  mem?: number;          // approximate device RAM in GB (Chromium only)
}

/** Allowlist of anomaly types accepted into Loki (prevents clients from injecting arbitrary types that inflate inline cardinality or mislead queries). */
const ALLOWED_ANOMALY_TYPES = new Set(['mem', 'cpu', 'webgl_lost', 'anr', 'jserror', 'crash']);

/** Allowlist for the inline device bucket — same rationale as ALLOWED_ANOMALY_TYPES: this value is
 *  client-supplied and lands inline on every line, so an unbounded string would let any client inflate
 *  cardinality (and make `| logfmt | device="phone"` unreliable by seeding near-miss spellings). */
const ALLOWED_DEVICES = new Set(['phone', 'tablet', 'desktop', 'unknown']);

/** Same for orientation: exactly two real values, anything else is dropped rather than passed through. */
const ALLOWED_ORIENTS = new Set(['portrait', 'landscape']);

/** Build an anomaly logfmt line: type/publicId are mandatory, everything else is optional, msg comes last. */
function buildAnomalyLine(publicId: string, s: ClientAnomalySession, e: ClientAnomalyEvent): string {
  const type = ALLOWED_ANOMALY_TYPES.has(e.type) ? e.type : 'other';
  const parts = [`type=${logfmtValue(type)}`, `publicId=${logfmtValue(publicId)}`];
  if (s.platform) parts.push(`platform=${logfmtValue(s.platform)}`);
  if (s.device && ALLOWED_DEVICES.has(s.device)) parts.push(`device=${logfmtValue(s.device)}`);
  if (typeof s.dpr === 'number' && Number.isFinite(s.dpr)) parts.push(`dpr=${s.dpr}`);
  if (typeof s.mem === 'number' && Number.isFinite(s.mem)) parts.push(`mem=${s.mem}`);
  if (s.buildVersion) parts.push(`buildVersion=${logfmtValue(s.buildVersion)}`);
  if (e.orient && ALLOWED_ORIENTS.has(e.orient)) parts.push(`orient=${logfmtValue(e.orient)}`);
  if (e.vp) parts.push(`vp=${logfmtValue(e.vp)}`);
  if (typeof e.sinceRot === 'number' && Number.isFinite(e.sinceRot)) parts.push(`sinceRot=${Math.round(e.sinceRot)}`);
  if (e.detail) parts.push(`detail=${logfmtValue(e.detail)}`);
  parts.push(`msg=${logfmtValue(e.msg)}`);
  return parts.join(' ');
}

/**
 * Assembles a batch of client anomaly events into a Loki push payload (single stream, label={source,kind=anomaly}, low cardinality).
 * Returns null when there are no sendable entries (empty batch).
 */
export function buildAnomalyLokiPayload(
  publicId: string,
  events: ClientAnomalyEvent[],
  session: ClientAnomalySession,
  fallbackNs: () => string,
): { streams: { stream: Record<string, string>; values: [string, string][] }[] } | null {
  const values: [string, string][] = [];
  for (const e of events) {
    const ns = Number.isFinite(e.ts) && e.ts > 0 ? (BigInt(Math.floor(e.ts)) * 1_000_000n).toString() : fallbackNs();
    values.push([ns, buildAnomalyLine(publicId, session, e)]);
  }
  if (values.length === 0) return null;
  return { streams: [{ stream: { source: 'client', kind: 'anomaly' }, values }] };
}

/**
 * Forwards to the Loki push API (fire-and-forget semantics; callers need not await the result).
 * Any failure (null url / network unreachable / non-2xx) is silently swallowed — exposed via onError only when needed for debugging.
 */
export async function pushToLoki(
  url: string | null,
  payload: object,
  onError?: (err: unknown) => void,
): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) onError?.(new Error(`loki push ${res.status}`));
  } catch (e) {
    onError?.(e);
  }
}

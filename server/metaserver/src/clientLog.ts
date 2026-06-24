// 客户端日志 → Loki 转发（FEATURE_FLAGS_DESIGN §9.4 / observability/README.md Phase 3）。
//
// 入 Loki 约定：label 仅 { source="client", level=... }（低基数，防撑爆索引）；publicId / tag / msg
// 一律放**行内**（logfmt），Grafana 用 `{source="client"} | logfmt | publicId="<9位>"` 捞单个玩家。
// Loki 不可达 → 静默丢弃，绝不影响玩家（POST /client/log 永远回 200）。

/** 一条客户端日志（与客户端环形缓冲条目同形）。 */
export interface ClientLogEntry {
  level: string; // error | warn | info | debug
  msg: string;
  ts: number; // epoch ms（客户端时钟）
  tag?: string;
}

/** 允许入 Loki 的级别白名单（防客户端塞任意 label 值撑高基数）。 */
const ALLOWED_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

/** logfmt 值转义：含空格/引号/等号则加引号并转义内部引号与反斜杠。 */
function logfmtValue(v: string): string {
  if (v === '') return '""';
  if (!/[\s"=]/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 拼一行 logfmt：publicId 必带，tag 可选，msg 末尾（人读时最显眼）。 */
function buildLine(publicId: string, e: ClientLogEntry, platform?: string): string {
  const parts = [`publicId=${logfmtValue(publicId)}`];
  if (platform) parts.push(`platform=${logfmtValue(platform)}`);
  if (e.tag) parts.push(`tag=${logfmtValue(e.tag)}`);
  parts.push(`msg=${logfmtValue(e.msg)}`);
  return parts.join(' ');
}

/**
 * 把一批客户端日志组装成 Loki push payload（按 level 分流，低基数 label）。
 * 时间戳转纳秒字符串（Loki 要求 ns 精度，用 BigInt 避免 1e6 科学计数法/精度丢失）。
 * 返回 null = 无可发送条目（全部级别非法 / 空）。
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

// ── 客户端异常事件「全量」上报 → Loki（与上面的「日志定向采集」并列、互补，不受 allowPublicIds 约束）──
//
// 入 Loki 约定：label 仅 { source="client", kind="anomaly" }（低基数）；type/publicId/platform/detail/msg
// 一律放**行内**（logfmt）。Grafana：`{source="client",kind="anomaly"} | logfmt | type="webgl_lost"`。

/** 一条客户端异常事件（与客户端 net/anomaly.ts 的 AnomalyEvent 同形）。 */
export interface ClientAnomalyEvent {
  type: string; // mem | cpu | webgl_lost | anr | jserror | crash
  msg: string;
  ts: number; // epoch ms（客户端时钟）
  detail?: string;
}

/** 允许入 Loki 的异常类型白名单（防客户端塞任意 type 撑高行内基数 / 误导查询）。 */
const ALLOWED_ANOMALY_TYPES = new Set(['mem', 'cpu', 'webgl_lost', 'anr', 'jserror', 'crash']);

/** 拼一行异常 logfmt：type/publicId 必带，platform/detail 可选，msg 末尾。 */
function buildAnomalyLine(publicId: string, platform: string | undefined, e: ClientAnomalyEvent): string {
  const type = ALLOWED_ANOMALY_TYPES.has(e.type) ? e.type : 'other';
  const parts = [`type=${logfmtValue(type)}`, `publicId=${logfmtValue(publicId)}`];
  if (platform) parts.push(`platform=${logfmtValue(platform)}`);
  if (e.detail) parts.push(`detail=${logfmtValue(e.detail)}`);
  parts.push(`msg=${logfmtValue(e.msg)}`);
  return parts.join(' ');
}

/**
 * 把一批客户端异常事件组装成 Loki push payload（单 stream，label={source,kind=anomaly}，低基数）。
 * 返回 null = 无可发送条目（空）。
 */
export function buildAnomalyLokiPayload(
  publicId: string,
  events: ClientAnomalyEvent[],
  platform: string | undefined,
  fallbackNs: () => string,
): { streams: { stream: Record<string, string>; values: [string, string][] }[] } | null {
  const values: [string, string][] = [];
  for (const e of events) {
    const ns = Number.isFinite(e.ts) && e.ts > 0 ? (BigInt(Math.floor(e.ts)) * 1_000_000n).toString() : fallbackNs();
    values.push([ns, buildAnomalyLine(publicId, platform, e)]);
  }
  if (values.length === 0) return null;
  return { streams: [{ stream: { source: 'client', kind: 'anomaly' }, values }] };
}

/**
 * 转发到 Loki push API（fire-and-forget 语义；调用方不 await 结果亦可）。
 * 任何失败（url 为空 / 网络不可达 / 非 2xx）都吞掉——只在调试需要时经 onError 暴露。
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

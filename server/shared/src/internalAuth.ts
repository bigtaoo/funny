// 内部服务间 HTTP 鉴权（S12-1）。
//
// 背景：内部端口（commercial / matchsvc / gateway 内部面 / meta /internal/* / analyticsvc /internal/query）
// 玩家不可达，靠共享密钥 `X-Internal-Key` 鉴权。本模块把分散在各被调方的 `=== internalKey` 收口为
// 一个集中校验器，并补三件事：
//   1. timing-safe 比对（避免逐字节计时侧信道）；
//   2. per-caller 密钥注册表（NW_INTERNAL_KEYS）——每个调用方一把，泄露局部化 + 可识别 + 按服务轮换；
//   3. 命中调用方识别（审计日志 / 拒绝告警带 caller hint）。
//
// 与 ticket HMAC（@nw/shared/ticket）解耦：ticket 仍用单一 NW_INTERNAL_KEY 签验（matchsvc↔gameserver
// 必须同一把），本模块只管内部 HTTP 鉴权。玩家 JWT 与内部密钥天然不同命名空间——内部路由从不校验 JWT，
// 玩家 JWT 放到 Authorization 头也命不中 X-Internal-Key，结构性拒绝。
//
// 设计基准：SERVER_API.md「内部认证模型」/ META_DESIGN.md。
import { timingSafeEqual } from 'node:crypto';

/** 内部密钥请求头（小写——node http / fastify 的 req.headers 均已 lowercase）。 */
export const INTERNAL_KEY_HEADER = 'x-internal-key';
/** 调用方身份请求头（审计用；严格模式下身份由密钥本身证明，此头仅提示）。 */
export const INTERNAL_CALLER_HEADER = 'x-internal-caller';

/** 已登记的内部调用方。新增进程在此登记，并在 NW_INTERNAL_KEYS 给一把独立密钥。 */
export type InternalCaller =
  | 'gateway'
  | 'gameserver'
  | 'matchsvc'
  | 'meta'
  | 'commercial'
  | 'worldsvc'
  | 'admin'
  | 'analyticsvc'
  | 'socialsvc';

/** 字符串等长 timing-safe 比对（长度不同直接 false，不泄露长度外的逐字节信息）。 */
function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 解析 NW_INTERNAL_KEYS：形如 `gateway=k1,meta=k2,worldsvc=k3` → `{gateway:'k1', meta:'k2', worldsvc:'k3'}`。
 * 未配 / 空 → `{}`（→ 单一共享密钥回退模式）。容错：跳过无 `=` 或名/值为空的段。
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
/** 进程级缓存的 NW_INTERNAL_KEYS 解析结果（避免每次出站请求重复 split）。 */
export function internalKeysFromEnv(): Record<string, string> {
  if (envKeysCache === undefined) envKeysCache = parseInternalKeys(process.env.NW_INTERNAL_KEYS);
  return envKeysCache;
}

/**
 * 调用方出站应携带的密钥：per-caller 注册表里有自己的条目则用它，否则回退单一共享密钥（legacy）。
 * `registry` 缺省取 env（测试可显式传入避免读 env）。
 */
export function outboundInternalKey(
  caller: InternalCaller,
  legacyKey: string,
  registry: Record<string, string> = internalKeysFromEnv(),
): string {
  return registry[caller] ?? legacyKey;
}

/**
 * 出站请求头：`{x-internal-key, x-internal-caller}`。第二参为单一共享密钥（legacy 回退），
 * 内部自动按 caller 从注册表升级为专属密钥。
 */
export function internalHeaders(caller: InternalCaller, legacyKey: string): Record<string, string> {
  return {
    [INTERNAL_KEY_HEADER]: outboundInternalKey(caller, legacyKey),
    [INTERNAL_CALLER_HEADER]: caller,
  };
}

export interface InternalAuthResult {
  ok: boolean;
  /** 命中的调用方：严格模式 = 密钥所属方；回退模式 = x-internal-caller 提示（不可信，仅审计）。 */
  caller: string | null;
}

export interface InternalAuthVerifier {
  /** 是否启用 per-caller 严格模式（注册表非空）。 */
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
 * 内部 HTTP 鉴权校验器。
 * - 注册表非空 → **严格 per-caller**：presented key 须 timing-safe 等于某登记 caller 的密钥，命中即识别该 caller；
 *   遍历全表（不短路）保持常量工作量。回退密钥在严格模式下**不**接受（迁移须同时给所有进程配 NW_INTERNAL_KEYS）。
 * - 注册表为空 → **单一共享密钥回退**（兼容旧部署，零行为变化）：presented key 等于 legacyKey 即放行，
 *   caller 取 x-internal-caller 头（仅审计提示）。
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

/** 从 env 构建校验器：keys=NW_INTERNAL_KEYS，legacyKey=传入（通常 ServerEnv.internalKey）。 */
export function loadInternalAuth(legacyKey: string): InternalAuthVerifier {
  return createInternalAuth({ keys: internalKeysFromEnv(), legacyKey });
}

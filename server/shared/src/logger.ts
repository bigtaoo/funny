// 轻量结构化日志（S1 联调）。所有服务端进程（meta/gateway/matchsvc/game/commercial）共用。
//
// 双 sink：
//   • 控制台：可读单行 `12:03:45.678 INFO  [gateway] msg key=val`（开发时直接看窗口）；
//   • 文件（可选）：每条一行 JSON `{"t":ISO,"level","svc","msg",...data}`，便于后期接 Loki/Grafana。
//     仅当环境变量 NW_LOG_DIR 设置时启用，按「根服务名」分文件：${NW_LOG_DIR}/<svc>.log
//     （根服务名 = tag 第一个冒号之前，故 gateway / gateway:internal / gateway:matchsvc 写同一文件）。
//
// 设计取舍：不引 pino/winston——零依赖、CJS/ESM 通吃（shared 被 ESM 的 meta 和 CJS 的其余进程同时引）。
// 级别由 NW_LOG_LEVEL 控制（debug|info|warn|error，缺省 debug），低于阈值的丢弃。

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const raw = (typeof process !== 'undefined' ? process.env.NW_LOG_LEVEL : '') ?? '';
  const v = raw.toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return 'debug';
}

const threshold = LEVEL_ORDER[envLevel()];

// ── 文件 sink（NW_LOG_DIR 设置时启用，按根服务名分文件，进程内复用 stream）─────────
const LOG_DIR = (typeof process !== 'undefined' ? process.env.NW_LOG_DIR : '') || '';
const streams = new Map<string, WriteStream | null>(); // svc → stream（null = 该服务建流失败，停写）
let dirReady = false;

function ensureDir(): boolean {
  if (dirReady) return true;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
    return true;
  } catch {
    return false;
  }
}

/** 取（或惰性建）某根服务的 append 写流；NW_LOG_DIR 未配 / 建流失败 → null（仅控制台）。 */
function fileStream(svc: string): WriteStream | null {
  if (!LOG_DIR) return null;
  if (streams.has(svc)) return streams.get(svc)!;
  if (!ensureDir()) {
    streams.set(svc, null);
    return null;
  }
  try {
    // append：保留跨重启历史（node --watch 重启会重新打开同名文件续写）。
    const s = createWriteStream(join(LOG_DIR, `${svc}.log`), { flags: 'a' });
    s.on('error', () => {
      /* 写盘失败不影响进程；后续仍走控制台 */
    });
    streams.set(svc, s);
    return s;
  } catch {
    streams.set(svc, null);
    return null;
  }
}

function isoTs(): string {
  return new Date().toISOString();
}

function ts(): string {
  // HH:MM:SS.mmm（本地时间，控制台可读够用）。
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 把 data 里的 Error 摊平成字符串（JSON 序列化时 Error 默认变成 {}）。 */
function normData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k] = v instanceof Error ? v.message : v;
  }
  return out;
}

function fmtData(data?: Record<string, unknown>): string {
  if (!data) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    let s: string;
    if (v instanceof Error) s = v.message;
    else if (typeof v === 'object') {
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
      }
    } else s = String(v);
    // 单行化，避免换行打乱日志。
    parts.push(`${k}=${s.replace(/\s+/g, ' ')}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** 派生带子标签的 logger，如 `[gateway:judge]`。 */
  child(sub: string): Logger;
}

function makeLogger(tag: string): Logger {
  const root = tag.split(':')[0] || tag; // 文件按根服务名分组
  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    // 控制台（可读）。
    const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}${fmtData(data)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    // 文件（JSON 行，Loki-ready）。
    const stream = fileStream(root);
    if (stream) {
      const rec = { t: isoTs(), level, svc: tag, msg, ...normData(data) };
      try {
        stream.write(JSON.stringify(rec) + '\n');
      } catch {
        /* 控制台已记录，写盘失败忽略 */
      }
    }
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (sub) => makeLogger(`${tag}:${sub}`),
  };
}

export function createLogger(service: string): Logger {
  return makeLogger(service);
}

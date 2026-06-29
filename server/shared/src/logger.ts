// Lightweight structured logger (S1 integration). Shared by all server processes (meta/gateway/matchsvc/game/commercial).
//
// Dual sink:
//   • Console: human-readable single line `12:03:45.678 INFO  [gateway] msg key=val` (easy to read in dev windows);
//   • File (optional): one JSON line per entry `{"t":ISO,"level","svc","msg",...data}`, ready for Loki/Grafana ingestion.
//     Enabled only when env var NW_LOG_DIR is set; one file per root service name: ${NW_LOG_DIR}/<svc>.log
//     (root service name = everything before the first colon in the tag, so gateway / gateway:internal / gateway:matchsvc all write to the same file).
//
// Design trade-off: no pino/winston — zero dependencies, works with both CJS and ESM
// (shared is imported by the ESM meta process and all other CJS processes simultaneously).
// Log level controlled by NW_LOG_LEVEL (debug|info|warn|error, default: debug); entries below the threshold are discarded.

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

// ── File sink (enabled when NW_LOG_DIR is set; one file per root service name; stream is reused within the process) ─────────
const LOG_DIR = (typeof process !== 'undefined' ? process.env.NW_LOG_DIR : '') || '';
const streams = new Map<string, WriteStream | null>(); // svc → stream (null = stream creation failed for this service; writes suppressed)
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

/** Get (or lazily create) the append write stream for a root service; returns null if NW_LOG_DIR is unset or stream creation fails (console-only mode). */
function fileStream(svc: string): WriteStream | null {
  if (!LOG_DIR) return null;
  if (streams.has(svc)) return streams.get(svc)!;
  if (!ensureDir()) {
    streams.set(svc, null);
    return null;
  }
  try {
    // append: preserves history across restarts (node --watch reopens the same file and continues writing).
    const s = createWriteStream(join(LOG_DIR, `${svc}.log`), { flags: 'a' });
    s.on('error', () => {
      /* Write failure does not affect the process; subsequent entries still go to the console */
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
  // HH:MM:SS.mmm (local time; sufficient readability for the console).
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Flatten Error objects in data to strings (JSON.stringify produces {} for Error by default). */
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
    // Collapse to a single line to prevent newlines from breaking the log layout.
    parts.push(`${k}=${s.replace(/\s+/g, ' ')}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** Create a child logger with a sub-tag, e.g. `[gateway:judge]`. */
  child(sub: string): Logger;
}

function makeLogger(tag: string): Logger {
  const root = tag.split(':')[0] || tag; // group log files by root service name
  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    // Console (human-readable).
    const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}${fmtData(data)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    // File (JSON lines, Loki-ready).
    const stream = fileStream(root);
    if (stream) {
      const rec = { t: isoTs(), level, svc: tag, msg, ...normData(data) };
      try {
        stream.write(JSON.stringify(rec) + '\n');
      } catch {
        /* Already logged to console; disk write failure is silently ignored */
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

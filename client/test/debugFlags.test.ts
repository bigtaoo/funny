// debugFlags: the diagnostic knobs must be readable on the hosts that have no global `localStorage`.
//
// The bug this pins (found 2026-09-08 while trying to take ADR-083's missing on-device numbers):
// `nw_render_debug` / `nw_fps_warn` / `nw_mem_warn_mb` / `nw_gentex_budget` / `nw_tex_budget_mb` /
// `nw_cpu_busy_warn` / `nw_net_log` all read `globalThis.localStorage` directly, inside a
// `try {} catch {}` that fell back to the default. WeChat mini-game has no such global — it has
// `wx.getStorageSync`, reached through `platform.storage` — so on WeChat every one of these knobs was
// permanently stuck on its default AND said nothing about it. `nw_render_debug` in particular is the
// only handle on the paint rate, i.e. the one number that says whether ADR-083's demand-driven
// painting does anything on a phone, and WeChat is the host where it is the *only* one of that ADR's
// three knobs that can do anything at all (WechatPlatform.devicePixelRatio is hardcoded to 1, so the
// dpr cap is a no-op there by construction).
//
// Two gates, because the behavioural one alone cannot stop the next site from being written the old
// way: the flags honour injected storage, AND no source file reads an `nw_*` flag off the global.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { debugFlag, debugNum, setDebugFlagStorage, resetDebugFlagStorage } from '../src/debugFlags';

function fakeStorage(values: Record<string, string>) {
  return {
    getItem: (k: string) => values[k] ?? null,
    setItem: (k: string, v: string) => { values[k] = v; },
    removeItem: (k: string) => { delete values[k]; },
  };
}

describe('debugFlags: platform storage seam', () => {
  afterEach(() => {
    resetDebugFlagStorage();
    vi.unstubAllGlobals();
  });

  it('reads flags from injected platform storage when there is no global localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    setDebugFlagStorage(fakeStorage({ nw_render_debug: '1', nw_fps_warn: '40' }));
    expect(debugFlag('nw_render_debug')).toBe('1');
    expect(debugNum('nw_fps_warn', 25)).toBe(40);
  });

  it('falls back to the default for an unset / non-numeric / non-positive value', () => {
    setDebugFlagStorage(fakeStorage({ nw_fps_warn: 'abc', nw_mem_warn_mb: '0' }));
    expect(debugNum('nw_fps_warn', 25)).toBe(25);
    expect(debugNum('nw_mem_warn_mb', 400)).toBe(400);
    expect(debugNum('nw_absent', 7)).toBe(7);
    expect(debugFlag('nw_absent')).toBeNull();
  });

  it('never throws when the storage itself throws (a flag must never break the app)', () => {
    setDebugFlagStorage({ getItem: () => { throw new Error('storage disabled'); } });
    expect(debugFlag('nw_render_debug')).toBeNull();
    expect(debugNum('nw_fps_warn', 25)).toBe(25);
  });

  it('defaults to globalThis.localStorage before any injection (web, and existing tests)', () => {
    resetDebugFlagStorage();
    vi.stubGlobal('localStorage', fakeStorage({ nw_render_debug: 'on' }));
    expect(debugFlag('nw_render_debug')).toBe('on');
  });
});

// ── the mechanical half ───────────────────────────────────────────────────────
// A behavioural test only proves the flags work through the seam TODAY. The failure mode is a new
// (or reverted) call site going straight back to the global, which is exactly what this repo's
// convention says to gate mechanically rather than remember (see the `no-cjk-vcs` hook, the
// VersionedTileCache mutator override in ADR-083, `pageBakeCallSites.test.ts`).

/** The only two files allowed to touch `globalThis.localStorage`: both ARE the fallback shim. */
const SHIM_FILES = ['src/debugFlags.ts', 'src/net/anomaly/reporter.ts'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('debugFlags: no source file reads an nw_* flag off globalThis.localStorage', () => {
  it('every nw_* flag read goes through debugFlags', () => {
    const clientRoot = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of sourceFiles(join(clientRoot, 'src'))) {
      const rel = relative(clientRoot, file).split('\\').join('/');
      if (SHIM_FILES.includes(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        // A comment explaining the history is fine; a call is not.
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        if (/localStorage\s*\??\.\s*getItem\s*\(\s*['"`]nw_/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

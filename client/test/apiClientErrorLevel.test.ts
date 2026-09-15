// What level an ApiClient failure gets logged at, and why it is load-bearing.
//
// The client log ring is not just console decoration: `crashSentinel` stores the most recent
// level==='error' entry as the crash report's `lastError`, which is the first field anyone reads when
// triaging a death in Loki. While every non-ok response logged at error, that field showed whatever
// the player had most recently been refused — a 2026-09-14 report from a 5.4-hour tablet session
// carried `POST /pve/enter -> 402 INSUFFICIENT_STAMINA` as the "last error before the crash".
//
// So: 4xx (the server deliberately refusing a well-formed request) is a warn; 5xx and the network path
// stay errors. These cases assert through `recentClientLogs`, the same reader the sentinel uses, rather
// than through a console spy — the console is not what made the field wrong.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from '../src/net/ApiClient';
import { ApiClientCore } from '../src/net/ApiClient/core';
import { recentClientLogs, type ClientLogEntry } from '../src/net/log';

function installFetch(status: number, json: unknown): void {
  globalThis.fetch = (async () => ({ status, json: async () => json })) as unknown as typeof fetch;
}

function refusal(code: string, message: string): unknown {
  return { ok: false, error: { code, message } };
}

/** Entries logged since a marker, newest last — the ring is module state shared across cases. */
function since(marker: number): ClientLogEntry[] {
  return recentClientLogs(200).filter((e) => e.seq > marker);
}
function mark(): number {
  const all = recentClientLogs(200);
  return all.length > 0 ? all[all.length - 1]!.seq : 0;
}

/** Exactly what crashSentinel.ts does on its heartbeat to pick `lastError`. */
function sentinelLastError(): string | undefined {
  const errs = recentClientLogs(40).filter((e) => e.level === 'error');
  return errs.length ? errs[errs.length - 1]!.msg : undefined;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ApiClient failure log level', () => {
  it('a business refusal (402) is a warn, not an error', async () => {
    installFetch(402, refusal('INSUFFICIENT_STAMINA', 'not enough stamina'));
    const m = mark();

    await expect(new ApiClientCore('https://h/api').post('/pve/enter', { levelId: 'ch3_lv2' })).rejects.toBeInstanceOf(ApiError);

    const logged = since(m).filter((e) => e.msg.includes('INSUFFICIENT_STAMINA'));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('warn');
  });

  it('an expired session (401) is a warn too — the client re-auths, nothing broke', async () => {
    installFetch(401, refusal('UNAUTHENTICATED', 'invalid token'));
    const m = mark();

    await expect(new ApiClientCore('https://h/api').post('/save', {})).rejects.toBeInstanceOf(ApiError);

    expect(since(m).filter((e) => e.msg.includes('UNAUTHENTICATED'))[0]!.level).toBe('warn');
  });

  it('a server fault (500) is still an error', async () => {
    installFetch(500, refusal('INTERNAL', 'boom'));
    const m = mark();

    await expect(new ApiClientCore('https://h/api').post('/save', {})).rejects.toBeInstanceOf(ApiError);

    expect(since(m).filter((e) => e.msg.includes('INTERNAL'))[0]!.level).toBe('error');
  });

  it('a transport failure is still an error (nothing refused it — it never arrived)', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Load failed'); }) as unknown as typeof fetch;
    const m = mark();

    await expect(new ApiClientCore('https://h/api').post('/bootstrap', {})).rejects.toBeInstanceOf(TypeError);

    const logged = since(m).filter((e) => e.msg.includes('network failure'));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('error');
  });

  it("a run of business refusals leaves the crash sentinel's lastError untouched", async () => {
    // The whole point, stated as the property rather than as a level: the field must still describe the
    // last thing that actually broke, however many times the player was told "not enough stamina" after.
    globalThis.fetch = (async () => { throw new TypeError('Load failed'); }) as unknown as typeof fetch;
    await expect(new ApiClientCore('https://h/api').post('/bootstrap', {})).rejects.toBeInstanceOf(TypeError);
    const realFailure = sentinelLastError();
    expect(realFailure).toContain('network failure');

    installFetch(402, refusal('INSUFFICIENT_STAMINA', 'not enough stamina'));
    const api = new ApiClientCore('https://h/api');
    for (let i = 0; i < 5; i++) {
      await expect(api.post('/pve/enter', { levelId: 'ch3_lv2' })).rejects.toBeInstanceOf(ApiError);
    }

    expect(sentinelLastError()).toBe(realFailure);
  });
});

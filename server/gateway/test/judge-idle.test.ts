// pickJudge only drafts idle players (2026-09-27): a player in an online match — per matchsvc's
// activeMatch record in Redis — is never handed a recompute, even if their client still advertises
// canJudge (an old build, or the caps update racing the match start).
import { describe, it, expect } from 'vitest';
import { activeMatchKey, type RedisLike } from '@nw/shared';
import { PeerJudgeService } from '../src/gateway/peerJudge';
import type { ConnLookup, GwConn } from '../src/gateway/types';

const OPEN = 1;

function fakeConn(accountId: string, sent: string[]): GwConn {
  return {
    accountId,
    canJudge: true,
    alive: true,
    connSeq: 1,
    ws: { OPEN, readyState: OPEN, send: () => sent.push(accountId) },
  } as unknown as GwConn;
}

function lookup(conns: GwConn[]): ConnLookup {
  const m = new Map(conns.map((c) => [c.accountId, c]));
  return { get: (id) => m.get(id), has: (id) => m.has(id), values: () => m.values() };
}

function fakeRedis(inMatch: string[], fail = false): RedisLike {
  const keys = new Set(inMatch.map(activeMatchKey));
  return {
    mget: async (...ks: string[]) => {
      if (fail) throw new Error('redis down');
      return ks.map((k) => (keys.has(k) ? '{"roomId":"r"}' : null));
    },
  } as unknown as RedisLike;
}

/** Fires a judge call and reports who got the request; the pending promise is left to time out unobserved. */
async function drafted(svc: PeerJudgeService): Promise<void> {
  void svc.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: ['p'] });
  await new Promise((r) => setTimeout(r, 0));
}

describe('PeerJudgeService idle check', () => {
  it('skips a candidate with an activeMatch record and picks the idle one', async () => {
    for (let i = 0; i < 20; i++) {
      const sent: string[] = [];
      const svc = new PeerJudgeService({ conns: lookup([fakeConn('busy', sent), fakeConn('idle', sent)]) });
      svc.setActiveMatchStore(fakeRedis(['busy']));
      await drafted(svc);
      expect(sent).toEqual(['idle']);
    }
  });

  it('everyone in a match → no judge, voided immediately', async () => {
    const sent: string[] = [];
    const svc = new PeerJudgeService({ conns: lookup([fakeConn('busy', sent)]) });
    svc.setActiveMatchStore(fakeRedis(['busy']));
    const verdict = await svc.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: [] });
    expect(verdict).toEqual({ ok: false });
    expect(sent).toEqual([]);
  });

  it('Redis failing → falls back to the canJudge flag instead of refusing to judge', async () => {
    const sent: string[] = [];
    const svc = new PeerJudgeService({ conns: lookup([fakeConn('c', sent)]) });
    svc.setActiveMatchStore(fakeRedis([], true));
    await drafted(svc);
    expect(sent).toEqual(['c']);
  });

  it('a client that withdrew canJudge (battle on screen) is not drafted', async () => {
    const sent: string[] = [];
    const c = fakeConn('c', sent);
    c.canJudge = false;
    const svc = new PeerJudgeService({ conns: lookup([c]) });
    const verdict = await svc.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: [] });
    expect(verdict).toEqual({ ok: false });
    expect(sent).toEqual([]);
  });

  it('the drafted player disconnecting while the lookup is in flight → nothing sent, voided', async () => {
    const sent: string[] = [];
    const c = fakeConn('c', sent);
    const svc = new PeerJudgeService({ conns: lookup([c]) });
    svc.setActiveMatchStore({
      mget: async (...ks: string[]) => {
        (c.ws as { readyState: number }).readyState = 3; // CLOSED before the reply lands
        return ks.map(() => null);
      },
    } as unknown as RedisLike);
    const verdict = await svc.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: [] });
    expect(verdict).toEqual({ ok: false });
    expect(sent).toEqual([]);
  });

  it('never drafts one of the players being judged, even when they are idle', async () => {
    const sent: string[] = [];
    const svc = new PeerJudgeService({ conns: lookup([fakeConn('p', sent)]) });
    svc.setActiveMatchStore(fakeRedis([]));
    const verdict = await svc.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: ['p'] });
    expect(verdict).toEqual({ ok: false });
    expect(sent).toEqual([]);
  });
});

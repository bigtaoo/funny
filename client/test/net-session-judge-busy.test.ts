// NetSession wiring for "judges are idle players" (SERVER_API_INTERNAL §8.1): the control plane
// withdraws judge capability while a battle is on screen and restores it afterwards, and a
// judge_request that races in mid-battle is declined without ever starting a recompute.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeJudge = vi.fn();
vi.mock('../src/net/judgeExecutor', () => ({ executeJudge: (...a: unknown[]) => executeJudge(...a) }));

import { NetSession } from '../src/net/NetSession';
import { acquireBattleBusy } from '../src/net/battleBusy';
import type { IPlatform, IGameSocket, SocketHandlers } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import type { JudgeRequest } from '../src/net/proto/transport';

class FakeSocket implements IGameSocket {
  constructor(readonly h: SocketHandlers) {}
  send(): void {}
  close(): void {}
  open(): void { this.h.onOpen(); }
}

function makeSession(): { session: NetSession; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const platform = {
    connectSocket(_url: string, h: SocketHandlers): IGameSocket {
      const s = new FakeSocket(h);
      sockets.push(s);
      return s;
    },
  } as unknown as IPlatform;
  const api = { getToken: () => 'tok' } as unknown as ApiClient;
  const session = new NetSession(platform, 'ws://x/gw', api, async () => ({ kind: 'device', deviceId: 'dev-1' }));
  return { session, sockets };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const REQ = { requestId: 'req-1' } as JudgeRequest;

type Routable = { routeControl(msg: { judgeRequest: JudgeRequest }): void };

describe('NetSession — peer judge only while idle', () => {
  let session: NetSession;
  let sockets: FakeSocket[];
  let caps: ReturnType<typeof vi.spyOn>;
  let verdict: ReturnType<typeof vi.spyOn>;
  const releases: (() => void)[] = [];

  beforeEach(() => {
    // canJudge gates on core count; pin a capable host so only battle state decides.
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    ({ session, sockets } = makeSession());
    caps = vi.spyOn(session.gateway, 'sendClientCaps').mockImplementation(() => {});
    verdict = vi.spyOn(session.gateway, 'sendJudgeVerdict').mockImplementation(() => {});
    executeJudge.mockReset();
  });

  afterEach(() => {
    for (const r of releases.splice(0)) r();
    session.close();
    vi.unstubAllGlobals();
  });

  const battle = (): (() => void) => {
    const r = acquireBattleBusy();
    releases.push(r);
    return r;
  };

  it('advertises can_judge on open, withdraws it for the battle, restores it after', async () => {
    session.connect();
    await tick();
    sockets[0]!.open();
    expect(caps.mock.calls).toEqual([[true]]);

    const release = battle();
    expect(caps).toHaveBeenLastCalledWith(false);
    release();
    expect(caps.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('a (re)connect during a battle advertises can_judge:false', async () => {
    battle();
    session.connect();
    await tick();
    sockets[0]!.open();
    expect(caps.mock.calls).toEqual([[false]]);
  });

  it('battle transitions while the control plane is down send nothing', () => {
    const release = battle();
    release();
    expect(caps).not.toHaveBeenCalled();
  });

  it('stops following battle transitions once the session is closed', async () => {
    session.connect();
    await tick();
    sockets[0]!.open();
    session.close();
    caps.mockClear();
    battle();
    expect(caps).not.toHaveBeenCalled();
  });

  it('declines a judge_request that arrives mid-battle without starting a recompute', () => {
    battle();
    (session as unknown as Routable).routeControl({ judgeRequest: REQ });
    expect(executeJudge).not.toHaveBeenCalled();
    expect(verdict.mock.calls).toEqual([['req-1', '', 0, false]]);
  });

  it('runs an idle judge_request through the executor and reports its verdict', async () => {
    executeJudge.mockResolvedValue({ ok: true, stateHash: 'h', winnerSide: 1, stars: 3, statsJson: '{}' });
    (session as unknown as Routable).routeControl({ judgeRequest: REQ });
    expect(executeJudge).toHaveBeenCalledWith(REQ);
    await tick();
    expect(verdict.mock.calls).toEqual([['req-1', 'h', 1, true, 3, '{}']]);
  });
});

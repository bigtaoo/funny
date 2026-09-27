// Peer-judge work stays away from a live battle (PEER_JUDGE: judges are idle players):
// battleBusy tracks whether a GameScene is on screen, and the default (main-thread) judge
// executor parks between slices while it is.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireBattleBusy, isBattleBusy, onBattleBusyChange } from '../src/net/battleBusy';
import { executeJudge } from '../src/net/judgeExecutor';
import type { JudgeRequest } from '../src/net/proto/transport';

describe('battleBusy', () => {
  it('overlapping scenes: busy until the last one releases; each release counts once', () => {
    const seen: boolean[] = [];
    const off = onBattleBusyChange((b) => seen.push(b));
    const a = acquireBattleBusy();
    const b = acquireBattleBusy();
    a();
    a();
    expect(isBattleBusy()).toBe(true);
    b();
    expect(isBattleBusy()).toBe(false);
    expect(seen).toEqual([true, false]);
    off();
  });
});

describe('main-thread judge executor', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('does not step while a battle is on screen, and finishes once it ends', async () => {
    vi.useFakeTimers();
    // A PvP request with no frames never reaches GameOver: it runs until the frame budget ends it.
    const req = { requestId: 'r', seed: 1, mode: 0, endFrame: 30, frames: [], levelId: '', defenseJson: '',
      cardInstancesJson: '', equipmentInvJson: '', topDeck: [], bottomDeck: [] } as unknown as JudgeRequest;
    const release = acquireBattleBusy();
    let done = false;
    const p = executeJudge(req).then((out) => { done = true; return out; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(true);
    // 30 frames + 600 slack without a winner: not a GameOver → ok:false, but it did finish.
    expect((await p).ok).toBe(false);
  });

  it('gives up at the deadline instead of holding the CPU for a verdict nobody waits for', async () => {
    vi.useFakeTimers();
    const req = { requestId: 'r', seed: 1, mode: 0, endFrame: 30, frames: [], levelId: '', defenseJson: '',
      cardInstancesJson: '', equipmentInvJson: '', topDeck: [], bottomDeck: [] } as unknown as JudgeRequest;
    const release = acquireBattleBusy();
    const p = executeJudge(req);
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await p).ok).toBe(false);
    release();
  });
});

// CrazyGames room presence (platform/crazygames/crazyGamesRooms.ts; CRAZYGAMES_LAUNCH.md §4.2).
// The SDK rejects updateRoom/leftRoom calls closer than 250 ms, and a room changes several times a
// second while it fills — so what matters is that the portal ends up told the LATEST state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CrazyGamesRooms, type CrazyGamesRoomSdk } from '../src/platform/crazygames/crazyGamesRooms';
import { WebPlatform } from '../src/platform/web/WebPlatform';
import { WechatPlatform } from '../src/platform/wechat/WechatPlatform';
import { CrazyGamesPlatform } from '../src/platform/crazygames/CrazyGamesPlatform';

function fakeSdk() {
  let joinCb: ((p: Record<string, string> | null | undefined) => void) | null = null;
  const game = {
    inviteLink: vi.fn((p: Record<string, string>) => `https://www.crazygames.com/game/nw?czy_invite=true&room=${p.room}`),
    showInviteButton: vi.fn(() => ''),
    hideInviteButton: vi.fn(),
    updateRoom: vi.fn(),
    leftRoom: vi.fn(),
    addJoinRoomListener: vi.fn((cb: (p: Record<string, string> | null | undefined) => void) => { joinCb = cb; }),
  };
  return { game: game as typeof game & CrazyGamesRoomSdk, join: (p: Record<string, string> | null) => joinCb?.(p) };
}

const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await vi.runAllTimersAsync(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('CrazyGamesRooms — presence', () => {
  it('a burst of room changes reaches the portal as its final state', async () => {
    const { game } = fakeSdk();
    const rooms = new CrazyGamesRooms(() => game, Promise.resolve());
    rooms.update('123456', true);
    rooms.update('123456', true);
    rooms.update('123456', false);
    await settle();
    expect(game.updateRoom).toHaveBeenCalledTimes(1);
    expect(game.updateRoom).toHaveBeenCalledWith({ roomId: '123456', isJoinable: false });
    expect(game.hideInviteButton).toHaveBeenCalled();
  });

  it('a joinable room carries the room code as its invite parameter and shows the invite button', async () => {
    const { game } = fakeSdk();
    const rooms = new CrazyGamesRooms(() => game, Promise.resolve());
    rooms.update('123456', true);
    await settle();
    expect(game.updateRoom).toHaveBeenCalledWith({ roomId: '123456', isJoinable: true, inviteParams: { room: '123456' } });
    expect(game.showInviteButton).toHaveBeenCalledWith({ room: '123456' });
  });

  it('leaving sends leftRoom once, and never when the portal was never told about a room', async () => {
    const { game } = fakeSdk();
    const rooms = new CrazyGamesRooms(() => game, Promise.resolve());
    rooms.left();
    await settle();
    expect(game.leftRoom).not.toHaveBeenCalled();
    rooms.update('123456', true);
    await settle();
    rooms.left();
    rooms.left();
    await settle();
    expect(game.leftRoom).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: a throttled call is retried, so the portal is not left on a stale room', async () => {
    const { game } = fakeSdk();
    game.updateRoom.mockImplementationOnce(() => { throw new Error('throttled'); });
    const rooms = new CrazyGamesRooms(() => game, Promise.resolve());
    rooms.update('123456', true);
    await settle();
    expect(game.updateRoom).toHaveBeenCalledTimes(2);
  });

  it('calls are spaced at least 250 ms apart (the SDK throws otherwise)', async () => {
    const { game } = fakeSdk();
    const rooms = new CrazyGamesRooms(() => game, Promise.resolve());
    rooms.update('123456', true);
    await settle();
    const t0 = Date.now();
    rooms.update('123456', false);
    await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(game.updateRoom).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(game.updateRoom).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('no portal (our own dev server): nothing is sent and nothing throws', async () => {
    const rooms = new CrazyGamesRooms(() => null, Promise.resolve());
    rooms.update('123456', true);
    rooms.left();
    await settle();
    expect(rooms.inviteLink('123456')).toBeNull();
  });
});

describe('CrazyGamesRooms — invites', () => {
  it('the invite link carries the room code', () => {
    const { game } = fakeSdk();
    const rooms = new CrazyGamesRooms(() => game, Promise.resolve());
    expect(rooms.inviteLink('123456')).toContain('room=123456');
    expect(game.inviteLink).toHaveBeenCalledWith({ room: '123456' });
  });

  it.each([
    ['an invite link', '?czy_invite=true&room=123456', { kind: 'join', code: '123456' }],
    ['"play with friends"', '?instantJoin=true', { kind: 'create' }],
    ['an invite link that also says instantJoin', '?instantJoin=true&room=123456', { kind: 'join', code: '123456' }],
    ['a plain launch', '', null],
    ['a replay share link', '?r=abc', null],
  ])('launch intent from %s', (_label, search, want) => {
    const rooms = new CrazyGamesRooms(() => null, Promise.resolve(), () => search);
    expect(rooms.launchIntent()).toEqual(want);
  });

  it('the launch intent is handed out once', () => {
    const rooms = new CrazyGamesRooms(() => null, Promise.resolve(), () => '?room=123456');
    expect(rooms.launchIntent()).not.toBeNull();
    expect(rooms.launchIntent()).toBeNull();
  });

  it('an invite accepted mid-session reaches the game as its room code', async () => {
    const sdk = fakeSdk();
    const rooms = new CrazyGamesRooms(() => sdk.game, Promise.resolve());
    const got: string[] = [];
    rooms.onJoinRequest((code) => got.push(code));
    await settle();
    sdk.join({ room: '654321' });
    sdk.join(null);
    sdk.join({ other: 'x' });
    expect(got).toEqual(['654321']);
  });
});

describe('the chat setting is CrazyGames-only', () => {
  it('Web and WeChat never follow a platform "chat off" (chat is always on there)', () => {
    expect('watchChatDisabled' in CrazyGamesPlatform.prototype).toBe(true);
    expect('watchChatDisabled' in WebPlatform.prototype).toBe(false);
    expect('watchChatDisabled' in WechatPlatform.prototype).toBe(false);
  });
});

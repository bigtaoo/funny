// Regression tests for "PvP/SLG 里皮肤没生效" (2026-08-01): equipped character skins
// (game/meta/skinDefs.ts allEquippedSkins) reached the renderer only for local PvP-vs-AI and
// campaign matches. Two other paths silently dropped them:
//   - online netplay (goGameNet → views.showGameNet): the options object simply never included
//     equippedSkins, so the live match always fell back to the default look.
//   - replay playback (goReplay / goSiegeReplay → views.showReplay → ReplayScene): ReplayScene
//     used to hardcode an empty skin list regardless of what the viewer has equipped. SLG siege
//     battles are server-authoritative and are ONLY ever shown client-side through this replay
//     path (goSiegeReplay), so this alone made skins invisible for the entire SLG mode.
//
// These tests pin the nav-factory boundary (hand-built AppCtx, no PIXI/no real engine tick — same
// style as test/result-nav-onback.test.ts / test/world-hub-account-id.test.ts): each entry point
// must forward allEquippedSkins(saveManager.get().equipped) into the view layer.
import { describe, it, expect } from 'vitest';
import { createResultNav } from '../src/app/nav/result';
import { createWorldNav } from '../src/app/nav/world';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews, NetGameView } from '../src/app/AppViews';
import type { GameSceneOptions, GameSceneCallbacks } from '../src/scenes/GameScene';
import type { ReplaySceneCallbacks } from '../src/scenes/ReplayScene';
import type { MatchStartInfo, Replay, LevelDefinition, OwnerId } from '../src/game';
import { MatchMode } from '../src/net/proto/transport';
import { WorldApiClient } from '../src/net/WorldApiClient';

// Two characters' worth of equipped skins + an unrelated `title` slot (must be ignored, same
// as the skinDefs.test.ts fixture) — the exact expected output is spelled out by hand rather than
// recomputed via allEquippedSkins(), so the test doesn't just check the helper against itself.
const EQUIPPED = { title: 'champion', 'skin:archer': 'skin_shop_r1', 'skin:max': 'skin_l1' };
const EXPECTED_SKINS = ['skin_shop_r1', 'skin_l1'];

function baseCtx(overrides: Partial<AppCtx> = {}): AppCtx {
  return {
    platform: {
      onGameplayStart: () => {},
      onGameplayStop: () => {},
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    } as unknown as AppCtx['platform'],
    views: {} as unknown as AppViews,
    api: undefined,
    baseUrl: null,
    saveManager: { get: () => ({ equipped: EQUIPPED, pvp: { elo: 1000, rank: 'bronze' } }) } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true } as unknown as AppState,
    nav: {} as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
    ...overrides,
  };
}

describe('nav/result — goGameNet forwards equippedSkins to showGameNet', () => {
  it('includes the viewer\'s currently-equipped skins in the netplay GameSceneOptions', () => {
    let capturedOpts: GameSceneOptions | null = null;
    const fakeInput = { submit: () => {}, take: () => [] };
    const ctx = baseCtx({
      views: {
        showGameNet: (_localSide: OwnerId, _cb: GameSceneCallbacks, opts: GameSceneOptions): NetGameView => {
          capturedOpts = opts;
          return { applyNetState() {}, applyPeerDc() {}, applyMatchOver() {} };
        },
      } as unknown as AppViews,
      state: { inLobby: true, netSession: { input: fakeInput } } as unknown as AppState,
    });

    const info: MatchStartInfo = {
      roomId: 'room1', mode: MatchMode.FRIENDLY, seed: 1, startFrame: 0,
      localSide: 0, opponentName: 'foe', opponentPublicId: '', opponentTitle: '', opponentAvatarId: '',
      opponentSkins: ['skin_shop_e1'],
    };
    createResultNav(ctx).goGameNet(info);

    if (!capturedOpts) throw new Error('views.showGameNet was not called');
    expect((capturedOpts as GameSceneOptions).equippedSkins).toEqual(EXPECTED_SKINS);
    // Opponent skin bleed fix (2026-08-01): the opponent's OWN equipped skins (from the ticket, real
    // PvP only — never populated for AI/bot) forward separately, so UnitView can side-scope each list
    // to its actual owner instead of applying the viewer's skins to both sides (S3-4 follow-up).
    expect((capturedOpts as GameSceneOptions).opponentSkins).toEqual(['skin_shop_e1']);
  });
});

describe('nav/result — goReplay forwards equippedSkins to showReplay', () => {
  it('passes allEquippedSkins(save.equipped) as the 4th showReplay argument', () => {
    let capturedSkins: readonly string[] | undefined;
    const ctx = baseCtx({
      views: {
        showReplay: (_replay: Replay, _cb: ReplaySceneCallbacks, _level?: LevelDefinition, equippedSkins?: readonly string[]) => {
          capturedSkins = equippedSkins;
        },
      } as unknown as AppViews,
    });

    const replay = { engineVersion: 1, mode: 'pvp_ai', seed: 1, frames: [], endFrame: 10 } as unknown as Replay;
    createResultNav(ctx).goReplay(replay, () => {});

    expect(capturedSkins).toEqual(EXPECTED_SKINS);
  });
});

describe('nav/world — goSiegeReplay forwards equippedSkins to showReplay', () => {
  it('passes the viewer\'s equipped skins when presenting a settled SLG siege replay', async () => {
    let capturedSkins: readonly string[] | undefined;
    const ctx = baseCtx({
      views: {
        showReplay: (_replay: Replay, _cb: ReplaySceneCallbacks, _level?: LevelDefinition, equippedSkins?: readonly string[]) => {
          capturedSkins = equippedSkins;
        },
      } as unknown as AppViews,
      nav: { goWorldMap: () => {} } as unknown as Nav,
    });

    const worldApi = {
      getSiegeReplay: async () => ({
        siegeId: 'siege1', seed: 1, outcome: 'attacker_win', level: {}, attackerName: 'a', defenderName: 'd',
      }),
    } as unknown as WorldApiClient;

    await createWorldNav(ctx).goSiegeReplay(worldApi, 'world:1:0', 'siege1');

    expect(capturedSkins).toEqual(EXPECTED_SKINS);
  });
});

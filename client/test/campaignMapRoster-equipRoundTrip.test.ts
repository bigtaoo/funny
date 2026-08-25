// Regression coverage for a genuine cross-call the form① split of app/nav/game.ts into
// game/{campaignRoster,career}.ts surfaced (2026-08-12, see claudedocs/client-modules.md and
// campaignRoster.ts's own header comment): CampaignMap's onOpenEquipment() calls goEquipment()/
// goCardRoster() (roster), and goEquipment's own default `back` parameter is goCampaignMap
// (campaign) — a real two-way dependency inside the createCampaignRosterNav closure that's why
// campaign+roster were kept in ONE factory instead of being split further.
//
// This specific round trip (CampaignMap -> Equipment -> Roster -> back to CampaignMap, skipping
// any lobby detour) had NO existing test: careerNav-backNavigation.test.ts only covers the
// unrelated CAREER peer-tab group (Stats/Titles/Achievements); cardRoster-slg-fetch-timing.test.ts
// and cardRoster-offline.test.ts only cover goCardRoster's own SLG-fetch timing, entered directly
// (not via the campaign-map growth-hub entry).
import { describe, it, expect, vi } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { ApiClient } from '../src/net/ApiClient';
import type { CampaignMapCallbacks } from '../src/scenes/CampaignMapScene';
import type { EquipmentCallbacks } from '../src/scenes/EquipmentScene';
import type { CardCallbacks, CardRosterView } from '../src/scenes/CardScene';
import { TOKEN_KEY } from '../src/app/appConstants';

const GIVE_UP_MS = 2500; // must match CARD_ROSTER_SLG_BUDGET_MS in game/campaignRoster.ts

function buildCtx(): {
  ctx: AppCtx;
  getCampaignMap: () => CampaignMapCallbacks | null;
  getEquipment: () => EquipmentCallbacks | null;
  getCardRoster: () => CardCallbacks | null;
  showCampaignMapCallCount: () => number;
  showCardRosterCallCount: () => number;
} {
  let lastCampaignMap: CampaignMapCallbacks | null = null;
  let lastEquipment: EquipmentCallbacks | null = null;
  let lastCardRoster: CardCallbacks | null = null;
  let showCampaignMapCalls = 0;
  let showCardRosterCalls = 0;

  const views = {
    showCampaignMap: (cb: CampaignMapCallbacks) => { showCampaignMapCalls++; lastCampaignMap = cb; },
    showEquipment: (cb: EquipmentCallbacks) => { lastEquipment = cb; },
    showCardRoster: (cb: CardCallbacks): CardRosterView => {
      showCardRosterCalls++; lastCardRoster = cb;
      return { applyCardState: () => {}, showTab: () => {} };
    },
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: {
      storage: {
        getItem: (k: string): string | null => (k === TOKEN_KEY ? 'FAKE_TOKEN' : null),
        setItem: (): void => {},
        removeItem: (): void => {},
      },
    } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as ApiClient, // truthy -> equipLoggedIn branch + goCardRoster's online branch
    baseUrl: null,
    saveManager: {
      get: () => ({ progress: { stars: {}, cleared: [] } }),
      getPendingClears: () => [],
      online: () => true,
      subscribe: () => (): void => {},
    } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true, offlineMode: false, achievementClaimable: false } as unknown as AppState,
    nav: { goLobby: () => {} } as unknown as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    // Never resolves -> goCardRoster's own give-up timeout is what opens the roster (see
    // cardRoster-slg-fetch-timing.test.ts's identical "slow path" technique); this suite is only
    // about the CampaignMap<->Equipment<->Roster wiring, not the SLG-fetch race.
    resolveWorldShard: (): void => {},
  };

  return {
    ctx,
    getCampaignMap: () => lastCampaignMap,
    getEquipment: () => lastEquipment,
    getCardRoster: () => lastCardRoster,
    showCampaignMapCallCount: () => showCampaignMapCalls,
    showCardRosterCallCount: () => showCardRosterCalls,
  };
}

describe('createGameNav — CampaignMap <-> Equipment <-> Roster round trip (2026-08-12 form① split boundary)', () => {
  it('CampaignMap.onOpenEquipment opens Equipment with a roster peer tab, which opens the roster, which backs straight to CampaignMap', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, getCampaignMap, getEquipment, getCardRoster, showCampaignMapCallCount, showCardRosterCallCount } = buildCtx();
      const { goCampaignMap } = createGameNav(ctx);

      goCampaignMap();
      expect(showCampaignMapCallCount()).toBe(1);
      const campaignMap = getCampaignMap()!;

      // Logged in + online -> the E5 growth-hub entry lands directly on Equipment (not the roster).
      campaignMap.onOpenEquipment();
      const equipment = getEquipment();
      if (!equipment) throw new Error('views.showEquipment was not called by onOpenEquipment()');
      expect(equipment.peerTab).toBeDefined();
      expect(equipment.peerTab!.labelKey).toBe('roster.title');

      // Clicking the roster peer tab must open the roster (goCardRoster), not silently no-op.
      equipment.peerTab!.onSelect();
      // goCardRoster's own SLG fetch never resolves (resolveWorldShard is a no-op) -> its 2.5s
      // give-up timeout is what actually opens the roster view.
      await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
      expect(showCardRosterCallCount()).toBe(1);
      const roster = getCardRoster();
      if (!roster) throw new Error('views.showCardRoster was not called by the Equipment peer tab');

      // The roster's back must return directly to CampaignMap — not the lobby, not re-opening
      // Equipment — closing the loop this split's cross-call comment documents.
      roster.onBack();
      expect(showCampaignMapCallCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Equipment's own back button (not just the peer tab) closes the same loop back to CampaignMap via the roster", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, getCampaignMap, getEquipment, showCampaignMapCallCount, showCardRosterCallCount } = buildCtx();
      const { goCampaignMap } = createGameNav(ctx);

      goCampaignMap();
      getCampaignMap()!.onOpenEquipment();
      const equipment = getEquipment()!;

      equipment.onBack();
      await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
      expect(showCardRosterCallCount()).toBe(1); // onBack's default `back` also routes through goCardRoster(goCampaignMap)
      expect(showCampaignMapCallCount()).toBe(1); // not yet — still sitting on the roster
    } finally {
      vi.useRealTimers();
    }
  });
});

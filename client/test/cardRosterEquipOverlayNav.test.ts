// Regression coverage for the ADR-072 nav wiring: the Hero Roster's two equipment entries mount
// EquipmentScene as an OVERLAY over the still-live roster, and their back paths pop it instead of
// rebuilding the roster.
//
// The scene-level half of ADR-072 (pause/resume, deferred renders, the scroll offset and open detail
// modal surviving) is pinned by test/ui/cardRosterEquipOverlay.ui.ts. What that file cannot see is the
// wiring one layer up — and that layer is where the original bug actually lived: `openEquipment` was
// `goEquipment(() => goCardRoster(back), …)`, i.e. a full-scene swap whose *back handler built a new
// roster*. Nothing about CardScene itself was wrong. So the regression to guard is someone
// "simplifying" `returnToRoster` back into a `goCardRoster(...)` call, or dropping the
// `{ overlay: true }` argument — either one silently restores the reported bug while every
// scene-level test stays green.
//
// Hand-built AppCtx style, same as cardRoster-offline.test.ts / campaignMapRoster-equipRoundTrip.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import { TOKEN_KEY } from '../src/app/appConstants';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews, MountOpts } from '../src/app/AppViews';
import type { ApiClient } from '../src/net/ApiClient';
import type { CampaignMapCallbacks } from '../src/scenes/CampaignMapScene';
import type { CardCallbacks, CardRosterView, CardSceneTab } from '../src/scenes/CardScene';
import type { EquipmentCallbacks } from '../src/scenes/EquipmentScene';

interface Harness {
  ctx: AppCtx;
  /** Every showCardRoster call, in order — length > 1 means the roster was rebuilt. */
  rosterCalls: CardCallbacks[];
  equipmentCalls: { cb: EquipmentCallbacks; opts?: MountOpts }[];
  campaignMapCalls: CampaignMapCallbacks[];
  hideOverlay: ReturnType<typeof vi.fn>;
  /** Tabs pushed into the live roster handle via CardRosterView.showTab. */
  shownTabs: CardSceneTab[];
}

/**
 * `token`: with a login token in storage, goCardRoster takes its async "fetch SLG state first, open
 * on a 2.5s give-up timer" branch (so those tests need fake timers), and CampaignMap's growth-hub
 * button routes to Equipment rather than falling back to the roster. Default off — the roster-overlay
 * cases below don't need either, and the inline branch keeps them synchronous.
 */
function buildCtx(opts: { token?: boolean } = {}): Harness {
  const rosterCalls: CardCallbacks[] = [];
  const equipmentCalls: { cb: EquipmentCallbacks; opts?: MountOpts }[] = [];
  const campaignMapCalls: CampaignMapCallbacks[] = [];
  const shownTabs: CardSceneTab[] = [];
  const hideOverlay = vi.fn();

  const views = {
    showCardRoster: (cb: CardCallbacks): CardRosterView => {
      rosterCalls.push(cb);
      return { applyCardState: () => {}, showTab: (tab) => { shownTabs.push(tab); } };
    },
    showEquipment: (cb: EquipmentCallbacks, opts?: MountOpts) => { equipmentCalls.push({ cb, opts }); },
    showCampaignMap: (cb: CampaignMapCallbacks) => { campaignMapCalls.push(cb); },
    hideOverlay,
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: {
      storage: { getItem: (k: string) => (opts.token && k === TOKEN_KEY ? 'FAKE_TOKEN' : null) },
    } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as ApiClient, // truthy → the online branch injects openEquipment/openEquipmentBag
    baseUrl: null,
    saveManager: {
      get: () => ({ progress: { stars: {}, cleared: [] }, inventory: { skins: [] }, equipped: {}, cardInv: {} }),
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
    resolveWorldShard: () => {},
  };

  return { ctx, rosterCalls, equipmentCalls, campaignMapCalls, hideOverlay, shownTabs };
}

/** Open the roster and hand back its callbacks. */
function openRoster(h: Harness): CardCallbacks {
  createGameNav(h.ctx).goCardRoster();
  expect(h.rosterCalls).toHaveLength(1);
  return h.rosterCalls[0]!;
}

describe('goCardRoster → equipment is an overlay, and backing out pops it (ADR-072)', () => {
  it('the per-slot gear entry mounts with { overlay: true } and pre-selects that slot', () => {
    const h = buildCtx();
    const roster = openRoster(h);

    roster.openEquipment!('c1', 'armor');

    expect(h.equipmentCalls).toHaveLength(1);
    const { cb, opts } = h.equipmentCalls[0]!;
    expect(opts).toEqual({ overlay: true });
    expect(cb.activeCardInstanceId).toBe('c1');
    expect(cb.initialFilterSlot).toBe('armor');
    // The roster must NOT have been rebuilt on the way in.
    expect(h.rosterCalls).toHaveLength(1);
  });

  it('its back pops the overlay instead of building a second roster', () => {
    const h = buildCtx();
    openRoster(h).openEquipment!('c1', 'weapon');

    h.equipmentCalls[0]!.cb.onBack();

    expect(h.hideOverlay).toHaveBeenCalledTimes(1);
    // The exact regression: `back` used to be `() => goCardRoster(back)`, so this was 2.
    expect(h.rosterCalls).toHaveLength(1);
  });

  it('the sidebar equipment-bag entry is an overlay too, with no active card', () => {
    const h = buildCtx();
    openRoster(h).openEquipmentBag!();

    const { cb, opts } = h.equipmentCalls[0]!;
    expect(opts).toEqual({ overlay: true });
    expect(cb.activeCardInstanceId).toBe('');
    expect(cb.peerTab?.labelKey).toBe('roster.title');
    expect(h.rosterCalls).toHaveLength(1);
  });

  it("the overlay's Cards peer tab pops back to the live roster", () => {
    const h = buildCtx();
    openRoster(h).openEquipmentBag!();

    h.equipmentCalls[0]!.cb.peerTab!.onSelect();

    expect(h.hideOverlay).toHaveBeenCalledTimes(1);
    expect(h.rosterCalls).toHaveLength(1);
  });

  it("the overlay's Skins peer tab pops and switches the live roster's tab, rather than rebuilding it with initialTab", () => {
    const h = buildCtx();
    openRoster(h).openEquipmentBag!();

    const skins = h.equipmentCalls[0]!.cb.trailingPeers![0]!;
    expect(skins.labelKey).toBe('roster.tab.skins');
    skins.onSelect();

    expect(h.hideOverlay).toHaveBeenCalledTimes(1);
    expect(h.shownTabs).toEqual(['skins']);
    // Was `goCardRoster(back, 'skins')` — a whole new scene with initialTab set.
    expect(h.rosterCalls).toHaveLength(1);
  });
});

describe('the campaign-map equipment entry stays a full scene swap (ADR-072)', () => {
  const GIVE_UP_MS = 2500; // must match CARD_ROSTER_SLG_BUDGET_MS in app/nav/game/campaignRoster.ts

  it('mounts without overlay, and its back really does build a roster', async () => {
    // There is no roster underneath this entry to preserve, so the pop path would land on nothing —
    // this is the one caller that must keep the plain goto. (The rest of that round trip, including
    // the peer tab, is covered by campaignMapRoster-equipRoundTrip.test.ts.)
    vi.useFakeTimers();
    try {
      const h = buildCtx({ token: true });
      createGameNav(h.ctx).goCampaignMap();
      expect(h.campaignMapCalls).toHaveLength(1);

      h.campaignMapCalls[0]!.onOpenEquipment();
      expect(h.equipmentCalls).toHaveLength(1);
      expect(h.equipmentCalls[0]!.opts).toBeUndefined();
      expect(h.hideOverlay).not.toHaveBeenCalled();

      h.equipmentCalls[0]!.cb.onBack();
      // resolveWorldShard never resolves here, so the give-up timer is what opens the roster.
      await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
      expect(h.rosterCalls).toHaveLength(1);
      expect(h.hideOverlay).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

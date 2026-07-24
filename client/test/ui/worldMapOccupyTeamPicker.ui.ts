// Coverage for the occupy → team-picker wiring (SLG_DESIGN §4.2, 2026-07-16).
//
// Occupy used to send flat pool troops via showDeployDialog(...,'occupy'); the troops were consumed as
// the captured tile's garrison and never came back, so a player who "gave 2000 troops" to a grab felt
// like they were all lost after one fight. Occupy now goes through the same team picker as attack, so the
// committed troops belong to the card team (cardState.currentTroops, retained across battles). The picker
// is generalized: showTeamPicker(tx,ty,kind) + doMarchTeam(tx,ty,teamId,kind).
//
// 2026-07-17: the flat "散兵占领" fallback was removed — occupation commits a team's OWN carried troops
// (card ledger); the base-barracks reserve pool is only for distributing to teams, never for grabbing land
// directly. The picker also now shows each team's real carried strength (cardState.currentTroops for card
// entries), matching CityScene, instead of summing initialHp only (which showed "0" for card teams).
//
// These assert the button set the picker builds and that dispatch routes the right march kind — no PIXI
// rendering needed (panels.showModal is spied, mirroring worldMapBaseClick.ui.ts's harness pattern).

import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';
const ANCHOR = { x: 20, y: 20 };

function buildHarness(opts: {
  teams?: { id: string; name: string; army: { initialHp?: number; cardInstanceId?: string }[] }[];
  cardState?: Record<string, { currentTroops: number }>;
} = {}) {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const closeModal = vi.fn();
  const showDeployDialog = vi.fn();
  const renderHud = vi.fn();
  const getTeams = vi.fn().mockResolvedValue(opts.teams ?? [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }, { cardInstanceId: 'c2' }] }]);
  const startMarch = vi.fn().mockResolvedValue({ toTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}` });
  const getMarches = vi.fn().mockResolvedValue([]);
  // Mirror the real getMe: it returns the FULL player view (with mainBaseTile + cardState), not a bare stub —
  // doMarchTeam reassigns ctx.me from it, and a later showTeamPicker needs mainBaseTile to not early-return.
  const getMe = vi.fn().mockResolvedValue({
    joined: true,
    mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`,
    cardState: opts.cardState ?? { c1: { currentTroops: 60 }, c2: { currentTroops: 60 } },
  } as PlayerWorldView);

  const ctx = {
    destroyed: false,
    marches: [],
    occupations: [],
    stationed: [],
    myAttackTiles: new Set<string>(),
    myOccupyTiles: new Set<string>(),
    me: { joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`, cardState: opts.cardState ?? { c1: { currentTroops: 60 }, c2: { currentTroops: 60 } } } as PlayerWorldView,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: vi.fn() },
    cb: {
      worldId: WORLD_ID,
      worldApi: { getTeams, startMarch, getMarches, getMe },
    },
    panels: { showModal, showToast, closeModal, showDeployDialog, renderHud },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  return { ctx, net, showModal, showToast, showDeployDialog, startMarch, getMarches };
}

/** A promise whose resolution is controlled from the test — lets us freeze startMarch mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('WorldMapNet.showTeamPicker — occupy uses the team picker (§4.2)', () => {
  it('occupy picker lists the team and close — no "manage teams" and NO flat-pool fallback (2026-07-17: only battle-ready teams shown)', async () => {
    const { net, showModal, showDeployDialog } = buildHarness();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    expect(showModal).toHaveBeenCalledTimes(1);
    const buttons = showModal.mock.calls[0][1] as { label: string; action: () => void }[];
    const labels = buttons.map((b) => b.label);
    expect(labels.some((l) => l.startsWith('Alpha'))).toBe(true);
    expect(labels).toContain('✕');
    // No occupy path opens the flat pool-troop deploy dialog any more.
    for (const b of buttons) b.action();
    expect(showDeployDialog).not.toHaveBeenCalled();
  });

  it('occupy picker shows a card team\'s real carried troops (cardState.currentTroops), not 0', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Cards', army: [{ cardInstanceId: 'c1' }, { cardInstanceId: 'c2' }] }],
      cardState: { c1: { currentTroops: 1200 }, c2: { currentTroops: 960 } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    const teamLabel = labels.find((l) => l.startsWith('Cards'))!;
    expect(teamLabel).toContain(t('world.team.committed').replace('{n}', '2160'));
  });

  it('picking a team for occupy dispatches startMarch with kind="occupy" + teamId', async () => {
    const { net, showModal, startMarch } = buildHarness();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const buttons = showModal.mock.calls[0][1] as { label: string; action: () => void }[];
    buttons.find((b) => b.label.startsWith('Alpha'))!.action();
    // doMarchTeam is async but fire-and-forget from the button; flush microtasks.
    await Promise.resolve(); await Promise.resolve();
    expect(startMarch).toHaveBeenCalledWith(WORLD_ID, ANCHOR.x, ANCHOR.y, ANCHOR.x, ANCHOR.y, 'occupy', 1, 't1');
  });

  it('a busy team is omitted from the occupy picker entirely (TEAM_BUSY mirror; 2026-07-17: not shown at all, not just disabled)', async () => {
    const { ctx, net, showModal } = buildHarness();
    (ctx.occupations as { teamId: string }[]).push({ teamId: 't1' });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.some((b) => b.label.startsWith('Alpha'))).toBe(false);
  });

  it('a legacy unit-type team (pre-2026-07-17 migration, no cards) is omitted — it carries 0 and can never be dispatched', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Legacy', army: [{ initialHp: 240 }, { initialHp: 240 }] }],
      cardState: {},
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.some((b) => b.label.startsWith('Legacy'))).toBe(false);
    const head = showModal.mock.calls[0][0] as string[];
    expect(head).toContain(t('world.team.noTeamsOccupy'));
  });

  it('a team with zero committed troops (e.g. its cards were wiped) is omitted — it would just die on contact', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Wiped', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 0 } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.some((b) => b.label.startsWith('Wiped'))).toBe(false);
    const head = showModal.mock.calls[0][0] as string[];
    expect(head).toContain(t('world.team.noTeamsOccupy'));
  });
});

// In-flight dispatch gate (2026-07-22 §32): the reported bug had a team marched twice. The realistic client
// trigger is a double-dispatch WINDOW: after picking a team, startMarch is in flight and ctx.marches has not
// refreshed yet, so a second picker (on another tile) still saw the team as idle and sent it again. pendingTeamIds
// marks a team busy from the tap until the response lands, so both the picker gate and doMarchTeam's own guard
// treat it as busy meanwhile. (The server's partial-unique index is the authoritative backstop; tested there.)
describe('WorldMapNet — in-flight dispatch gate (no double-send before ctx.marches refreshes)', () => {
  it('a team with a dispatch still in flight is omitted from a second picker', async () => {
    const { net, showModal, startMarch } = buildHarness();
    const d = deferred<{ toTile: string }>();
    startMarch.mockReturnValueOnce(d.promise); // freeze the first dispatch mid-flight

    // First dispatch: pick the team; startMarch fires but never resolves yet.
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'attack');
    const buttons1 = showModal.mock.calls[0][1] as { label: string; action: () => void }[];
    buttons1.find((b) => b.label.startsWith('Alpha'))!.action();
    await Promise.resolve(); await Promise.resolve();
    expect(startMarch).toHaveBeenCalledTimes(1);

    // Second picker while the first is still in flight → team is gone (ctx.marches has not refreshed).
    showModal.mockClear();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'attack');
    const buttons2 = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons2.some((b) => b.label.startsWith('Alpha'))).toBe(false);

    // Once the first dispatch resolves, the team frees up and reappears.
    d.resolve({ toTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}` });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    showModal.mockClear();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'attack');
    const buttons3 = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons3.some((b) => b.label.startsWith('Alpha'))).toBe(true);
  });

  it('doMarchTeam refuses a second order for the same in-flight team (busy toast, startMarch fired only once)', async () => {
    const { net, showToast, startMarch } = buildHarness();
    const d = deferred<{ toTile: string }>();
    startMarch.mockReturnValueOnce(d.promise);

    // Two direct dispatches of t1 back-to-back, second before the first resolves.
    void net.doMarchTeam(ANCHOR.x, ANCHOR.y, 't1', 'attack');
    await Promise.resolve();
    await net.doMarchTeam(5, 10, 't1', 'attack'); // different tile, same team, still in flight

    expect(startMarch).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('world.team.busy'), expect.anything());

    d.resolve({ toTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}` });
  });

  it('a failed dispatch releases the pending hold (finally), so the team can be retried', async () => {
    const { net, startMarch } = buildHarness();
    startMarch.mockRejectedValueOnce(new Error('offline')); // first attempt fails; default resolve for the retry

    await net.doMarchTeam(ANCHOR.x, ANCHOR.y, 't1', 'attack'); // errors, but finally clears pending
    // Team is no longer pending → a retry actually reaches startMarch again.
    await net.doMarchTeam(ANCHOR.x, ANCHOR.y, 't1', 'attack');
    expect(startMarch).toHaveBeenCalledTimes(2);
  });
});

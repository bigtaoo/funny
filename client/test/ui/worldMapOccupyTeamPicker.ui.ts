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
  const getMe = vi.fn().mockResolvedValue({ joined: true } as PlayerWorldView);

  const ctx = {
    destroyed: false,
    marches: [],
    occupations: [],
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
  return { ctx, net, showModal, showDeployDialog, startMarch };
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

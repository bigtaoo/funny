// Coverage for the occupy → team-picker wiring (SLG_DESIGN §4.2, 2026-07-16).
//
// Occupy used to send flat pool troops via showDeployDialog(...,'occupy'); the troops were consumed as
// the captured tile's garrison and never came back, so a player who "gave 2000 troops" to a grab felt
// like they were all lost after one fight. Occupy now goes through the same team picker as attack, so the
// committed troops belong to the card team (cardState.currentTroops, retained across battles). The picker
// is generalized: showTeamPicker(tx,ty,kind) + doMarchTeam(tx,ty,teamId,kind). A flat "散兵占领" fallback
// button is kept inside the occupy picker for players with no card team.
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

function buildHarness(opts: { teams?: { id: string; name: string; army: { initialHp?: number }[] }[] } = {}) {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const closeModal = vi.fn();
  const showDeployDialog = vi.fn();
  const renderHud = vi.fn();
  const getTeams = vi.fn().mockResolvedValue(opts.teams ?? [{ id: 't1', name: 'Alpha', army: [{ initialHp: 60 }, { initialHp: 60 }] }]);
  const startMarch = vi.fn().mockResolvedValue({ toTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}` });
  const getMarches = vi.fn().mockResolvedValue([]);
  const getMe = vi.fn().mockResolvedValue({ joined: true } as PlayerWorldView);

  const ctx = {
    destroyed: false,
    marches: [],
    occupations: [],
    myAttackTiles: new Set<string>(),
    me: { joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}` } as PlayerWorldView,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: vi.fn() },
    cb: {
      worldId: WORLD_ID,
      onOpenTeams: vi.fn(),
      worldApi: { getTeams, startMarch, getMarches, getMe },
    },
    panels: { showModal, showToast, closeModal, showDeployDialog, renderHud },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  return { ctx, net, showModal, showDeployDialog, startMarch };
}

describe('WorldMapNet.showTeamPicker — occupy uses the team picker (§4.2)', () => {
  it('occupy picker lists the team, a flat "散兵占领" fallback, manage, and close', async () => {
    const { net, showModal } = buildHarness();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    expect(showModal).toHaveBeenCalledTimes(1);
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    const labels = buttons.map((b) => b.label);
    expect(labels.some((l) => l.startsWith('Alpha'))).toBe(true);
    expect(labels).toContain(t('world.team.flatOccupy'));
    expect(labels).toContain(t('world.team.manage'));
    expect(labels).toContain('✕');
  });

  it('the flat-occupy fallback opens the old pool-troop deploy dialog', async () => {
    const { net, showModal, showDeployDialog } = buildHarness();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const buttons = showModal.mock.calls[0][1] as { label: string; action: () => void }[];
    buttons.find((b) => b.label === t('world.team.flatOccupy'))!.action();
    expect(showDeployDialog).toHaveBeenCalledWith(ANCHOR.x, ANCHOR.y, 'occupy');
  });

  it('the attack picker has NO flat-occupy fallback (attack always needs a team)', async () => {
    const { net, showModal } = buildHarness();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'attack');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    expect(labels).not.toContain(t('world.team.flatOccupy'));
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

  it('a busy team is disabled in the occupy picker (TEAM_BUSY mirror)', async () => {
    const { ctx, net, showModal } = buildHarness();
    (ctx.occupations as { teamId: string }[]).push({ teamId: 't1' });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const buttons = showModal.mock.calls[0][1] as { label: string; disabled?: boolean }[];
    const teamBtn = buttons.find((b) => b.label.startsWith('Alpha'))!;
    expect(teamBtn.disabled).toBe(true);
  });
});

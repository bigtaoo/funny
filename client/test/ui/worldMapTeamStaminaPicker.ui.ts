// The team picker's stamina gate (SLG_DESIGN §4.6, 2026-09-04).
//
// The server refuses an order from a team under SLG_TEAM_STAMINA_COST with TEAM_EXHAUSTED, so the picker
// must not offer that team at all — a row whose only possible outcome is an error toast is worse than no
// row plus a head line that says why. That mirrors how a busy team is handled (omitted outright, not
// greyed out, per the 2026-07-17 decision in worldMapOccupyTeamPicker.ui.ts).
//
// Two things can only be checked at this seam and are what these cases pin:
//   1. an exhausted team drops out of the button list, and the empty-picker head names STAMINA rather
//      than falling through to "go distribute troops" — advice that would not unblock the player;
//   2. the figure shown on a usable row is the REGENERATED one, folded in from the checkpoint pair at
//      open time, so reopening the picker a few minutes later already reflects the refill.
//
// Same harness shape as worldMapOccupyTeamPicker.ui.ts (panels.showModal spied, no PIXI rendering),
// plus a `teamState` seed that harness has no reason to carry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SLG_TEAM_STAMINA_COST, SLG_TEAM_STAMINA_MAX } from '@nw/shared';
import { initI18n, t } from '../../src/i18n';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { PlayerWorldView } from '../../src/net/WorldApiClient';
import { modalLineText, type ModalLine } from '../../src/scenes/worldmap/WorldMapPanels/modalLine';

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
/** The picker reads the wall clock (Date.now()) for the refill, so the tests pin it. */
const NOW = 1_700_000_000_000;

type TeamState = Record<string, { stamina?: number; staminaAt?: number; injuredUntil?: number }>;

function buildHarness(opts: {
  teams?: { id: string; name: string; army: { cardInstanceId?: string }[] }[];
  cardState?: Record<string, { currentTroops: number }>;
  teamState?: TeamState;
} = {}) {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const closeModal = vi.fn();
  const renderHud = vi.fn();
  const teams = opts.teams ?? [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }];
  const cardState = opts.cardState ?? { c1: { currentTroops: 600 }, c2: { currentTroops: 600 } };
  const getTeams = vi.fn().mockResolvedValue(teams);
  const startMarch = vi.fn().mockResolvedValue({ toTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}` });
  const me = {
    joined: true,
    mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`,
    cardState,
    ...(opts.teamState ? { teamState: opts.teamState } : {}),
  } as unknown as PlayerWorldView;

  const ctx = {
    destroyed: false,
    marches: [],
    occupations: [],
    stationed: [],
    me,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: vi.fn() },
    cb: {
      worldId: WORLD_ID,
      worldApi: {
        getTeams,
        startMarch,
        getMarches: vi.fn(() => Promise.resolve([])),
        getOccupations: vi.fn(() => Promise.resolve([])),
        getStationed: vi.fn(() => Promise.resolve([])),
        getMe: vi.fn().mockResolvedValue(me),
      },
    },
    panels: { showModal, showToast, closeModal, renderHud },
  } as unknown as WorldMapContext;

  return { ctx, net: new WorldMapNet(ctx), showModal, startMarch };
}

const labelsOf = (showModal: ReturnType<typeof vi.fn>): string[] =>
  (showModal.mock.calls[0]![1] as { label: string }[]).map((b) => b.label);
const headOf = (showModal: ReturnType<typeof vi.fn>): string[] =>
  (showModal.mock.calls[0]![0] as ModalLine[]).map(modalLineText);

describe('showTeamPicker — team stamina gate (§4.6)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('a team with no stamina state reads as FULL and is offered with the full figure', async () => {
    const { net, showModal } = buildHarness();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const row = labelsOf(showModal).find((l) => l.startsWith('Alpha'))!;
    expect(row).toContain(t('world.team.stamina').replace('{n}', String(SLG_TEAM_STAMINA_MAX)));
  });

  it('an exhausted team is omitted entirely, and the head names stamina — not "go distribute troops"', async () => {
    const { net, showModal } = buildHarness({
      teamState: { t1: { stamina: SLG_TEAM_STAMINA_COST - 1, staminaAt: NOW } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    expect(labelsOf(showModal).some((l) => l.startsWith('Alpha'))).toBe(false);
    const head = headOf(showModal);
    expect(head).toContain(t('world.team.allExhausted'));
    // The two wrong answers this replaces: the team exists (so not "build one"), and it carries
    // troops (so not "distribute troops") — only waiting resolves it.
    expect(head).not.toContain(t('world.team.noTeamsOccupy'));
    expect(head).not.toContain(t('world.team.allNoTroops'));
  });

  it('exactly one order\'s worth is still offered (the gate is >=, so the last order is affordable)', async () => {
    const { net, showModal } = buildHarness({
      teamState: { t1: { stamina: SLG_TEAM_STAMINA_COST, staminaAt: NOW } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    expect(labelsOf(showModal).some((l) => l.startsWith('Alpha'))).toBe(true);
  });

  it('the refill is folded in at open time: a team stored empty long enough is offered again', async () => {
    const { net, showModal } = buildHarness({
      // Stored 0, twenty minutes ago → 20 back at 1/min, above the 15 an order costs.
      teamState: { t1: { stamina: 0, staminaAt: NOW - 20 * 60_000 } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const row = labelsOf(showModal).find((l) => l.startsWith('Alpha'));
    expect(row).toBeTruthy();
    expect(row).toContain(t('world.team.stamina').replace('{n}', '20'));
  });

  it('a rested team is still offered alongside a tired one, and only the tired one drops out', async () => {
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'Tired', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Fresh', army: [{ cardInstanceId: 'c2' }] },
      ],
      teamState: { t1: { stamina: 0, staminaAt: NOW }, t2: { stamina: SLG_TEAM_STAMINA_MAX, staminaAt: NOW } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = labelsOf(showModal);
    expect(labels.some((l) => l.startsWith('Fresh'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Tired'))).toBe(false);
    // A picker with something to offer keeps its normal title, not an empty-state reason line.
    expect(headOf(showModal)).toContain(t('world.team.pickTitleOccupy'));
  });

  it('the same team both tired AND empty is told to wait, not to go distribute troops', async () => {
    // Ordering inside emptyPickerHead: exhausted is checked before "no troops", so a team that is both
    // gets the answer that resolves on its own. Sending the player to 分兵 here would not unblock the
    // order — the team would fill up and still be too tired to go.
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Spent', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 0 } },
      teamState: { t1: { stamina: 0, staminaAt: NOW } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    expect(labelsOf(showModal).filter((l) => l !== t('common.close'))).toHaveLength(0);
    expect(headOf(showModal)).toContain(t('world.team.allExhausted'));
  });

  it('but a rested-yet-empty team keeps the "distribute troops" head — that one IS actionable', async () => {
    // Tired t1 + rested-but-empty t2. Neither can go, and the two blockers have different answers;
    // the head must pick the one the player can act on now, which is filling t2. This is why the
    // exhausted branch requires EVERY usable team to be tired rather than just one of them.
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'Tired', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Empty', army: [{ cardInstanceId: 'c2' }] },
      ],
      cardState: { c1: { currentTroops: 600 }, c2: { currentTroops: 0 } },
      teamState: { t1: { stamina: 0, staminaAt: NOW } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    expect(labelsOf(showModal).filter((l) => l !== t('common.close'))).toHaveLength(0);
    expect(headOf(showModal)).toContain(t('world.team.allNoTroops'));
  });
});

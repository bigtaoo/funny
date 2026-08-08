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
  stationed?: { x: number; y: number; teamId: string; mine?: boolean; mode?: string }[];
  getSave?: () => { cardInv: Record<string, unknown>; equipmentInv: Record<string, unknown> };
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
    stationed: opts.stationed ?? [],
    me: { joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`, cardState: opts.cardState ?? { c1: { currentTroops: 60 }, c2: { currentTroops: 60 } } } as PlayerWorldView,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: vi.fn() },
    cb: {
      worldId: WORLD_ID,
      worldApi: { getTeams, startMarch, getMarches, getMe },
      getSave: opts.getSave,
    },
    panels: { showModal, showToast, closeModal, showDeployDialog, renderHud },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  return { ctx, net, showModal, showToast, showDeployDialog, startMarch, getMarches, getMe };
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

  // Regression (2026-08-01): persistTeam() always saves name: '' (v1 has no custom-naming UI — see
  // DefenseEditorScene/data.ts), so the picker must fall back to the live slot name derived from the
  // team's `t{n}` id instead of rendering a blank name (label collapsing to just "· Troops NNNN").
  it('a team with an empty (unnamed) slot falls back to its live "Team {n}" slot name', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't3', name: '', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 500 } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    expect(labels.some((l) => l.startsWith(t('world.team.slot').replace('{n}', '3')))).toBe(true);
  });

  it('picking a team for occupy dispatches startMarch with kind="occupy" + teamId', async () => {
    const { net, showModal, startMarch } = buildHarness();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const buttons = showModal.mock.calls[0][1] as { label: string; action: () => void }[];
    buttons.find((b) => b.label.startsWith('Alpha'))!.action();
    // doMarchTeam is async but fire-and-forget from the button; flush microtasks.
    await Promise.resolve(); await Promise.resolve();
    expect(startMarch).toHaveBeenCalledWith(WORLD_ID, ANCHOR.x, ANCHOR.y, ANCHOR.x, ANCHOR.y, 'occupy', 1, 't1', undefined);
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

// Picker ordering (2026-08-02, user request): nearer teams first, then more-troops, then higher combat
// power — a player scanning the list top-to-bottom should see the cheapest/strongest-available option
// first instead of whatever order getTeams happened to return in. Idle-only is already covered by the
// busy-team-gate tests above; these pin the NEW ordering layered on top of that existing filter.
describe('WorldMapNet.showTeamPicker — sort order (nearest, then troops, then power)', () => {
  it('orders by distance to the target tile — an idle field team closer to (tx,ty) beats a farther one, regardless of troop count', async () => {
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'Far', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Near', army: [{ cardInstanceId: 'c2' }] },
      ],
      cardState: { c1: { currentTroops: 999 }, c2: { currentTroops: 1 } },
      // Target tile is ANCHOR (20,20). Near sits right next to it; Far sits much further away.
      stationed: [
        { x: 5, y: 5, teamId: 't1', mine: true, mode: 'idle' },
        { x: 21, y: 20, teamId: 't2', mine: true, mode: 'idle' },
      ],
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    const order = labels.filter((l) => l !== '✕').map((l) => l.split(' ·')[0]);
    expect(order).toEqual(['Near', 'Far']);
  });

  it('ties on distance break on carried troops — the heavier team lists first', async () => {
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'Light', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Heavy', army: [{ cardInstanceId: 'c2' }] },
      ],
      // Neither is stationed in the field, so both resolve to the same position (mainBaseTile) — a true distance tie.
      cardState: { c1: { currentTroops: 100 }, c2: { currentTroops: 500 } },
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    const order = labels.filter((l) => l !== '✕').map((l) => l.split(' ·')[0]);
    expect(order).toEqual(['Heavy', 'Light']);
  });

  it('ties on distance AND troops break on combat power (cardPower via getSave) — the higher-level card lists first', async () => {
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'Weak', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Strong', army: [{ cardInstanceId: 'c2' }] },
      ],
      cardState: { c1: { currentTroops: 200 }, c2: { currentTroops: 200 } }, // troop-tied too
      getSave: () => ({
        cardInv: {
          c1: { id: 'c1', defId: 'lichuang', level: 1, gear: {}, locked: false },
          c2: { id: 'c2', defId: 'lichuang', level: 9, gear: {}, locked: false }, // higher level → higher cardPower
        },
        equipmentInv: {},
      }),
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    const order = labels.filter((l) => l !== '✕').map((l) => l.split(' ·')[0]);
    expect(order).toEqual(['Strong', 'Weak']);
  });

  it('a garrison-stationed (busy) team is excluded from the sort entirely — still filtered before ranking', async () => {
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'Garrisoned', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'Free', army: [{ cardInstanceId: 'c2' }] },
      ],
      cardState: { c1: { currentTroops: 9999 }, c2: { currentTroops: 1 } },
      stationed: [{ x: 21, y: 20, teamId: 't1', mine: true, mode: 'garrison' }],
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    expect(labels.some((l) => l.startsWith('Garrisoned'))).toBe(false);
    expect(labels.some((l) => l.startsWith('Free'))).toBe(true);
  });

  // ADR-051 (P4) has ctx.stationed carry ENEMY entries too (vision rendering) — and enemy slot ids are the
  // same 't1'..'t5' naming as everyone else's, so an enemy's own 't1' can share the string with MY 't1'.
  // positionOf must filter on `mine !== false`, or a same-tile enemy decoy could hijack the distance for
  // one of my teams. Here the decoy sits right next to the target (would read as "closest" if the guard
  // were dropped); my team's real position (no own stationed entry) is the main base, which the harness
  // places well away from the target — so an unguarded lookup would wrongly rank it ahead of a genuinely
  // closer team.
  it('an enemy stationed entry sharing the same team-slot id does not hijack my team\'s distance', async () => {
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'Mine', army: [{ cardInstanceId: 'c1' }] },
        { id: 't2', name: 'ActuallyCloser', army: [{ cardInstanceId: 'c2' }] },
      ],
      cardState: { c1: { currentTroops: 100 }, c2: { currentTroops: 100 } },
      stationed: [
        { x: 501, y: 500, teamId: 't1', mine: false, mode: 'idle' }, // enemy's own t1, right beside the target — must be ignored for MY t1
        { x: 450, y: 450, teamId: 't2', mine: true, mode: 'idle' }, // my genuinely closer team (dist 50 vs Mine's true dist 480 from its base)
      ],
    });
    // Target far from ANCHOR (my base, (20,20)): "Mine" has no own stationed entry so it falls back to base
    // — a true distance of 480. If the mine!==false guard were dropped, it would instead pick up the enemy
    // decoy sitting right next to (500,500) and wrongly read as distance ~1, beating "ActuallyCloser".
    await net.showTeamPicker(500, 500, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    const order = labels.filter((l) => l !== '✕').map((l) => l.split(' ·')[0]);
    expect(order).toEqual(['ActuallyCloser', 'Mine']);
  });

  it('a card missing from the roster (sold/removed, dangling cardInstanceId) contributes 0 power instead of throwing', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Solo', army: [{ cardInstanceId: 'gone' }] }],
      cardState: { gone: { currentTroops: 50 } }, // still has a live troop ledger entry...
      getSave: () => ({ cardInv: {}, equipmentInv: {} }), // ...but the roster itself no longer has the card
    });
    await expect(net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy')).resolves.not.toThrow();
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    expect(labels.some((l) => l.startsWith('Solo'))).toBe(true);
  });

  // End-to-end shape check mirroring the reported scenario (screenshot: 4 teams, mixed distance/troops).
  // Team A: far (stationed away from target). Team B & C: tied at the same near distance as each other,
  // split by troops. Team D: same near distance as B/C AND same troops as the winner of that pair — only
  // combat power breaks it, and it beats B/C on both distance and troops so it must lead the whole list.
  it('full ranking with 4 teams — distance first, then troops, then power, all in one list', async () => {
    const { net, showModal } = buildHarness({
      teams: [
        { id: 't1', name: 'A_Far', army: [{ cardInstanceId: 'ca' }] },
        { id: 't2', name: 'B_NearLight', army: [{ cardInstanceId: 'cb' }] },
        { id: 't3', name: 'C_NearHeavy', army: [{ cardInstanceId: 'cc' }] },
        { id: 't4', name: 'D_NearHeaviestStrong', army: [{ cardInstanceId: 'cd' }] },
      ],
      cardState: {
        ca: { currentTroops: 10000 }, // most troops, but it's the farthest — must still lose to every near team
        cb: { currentTroops: 100 },
        cc: { currentTroops: 200 },
        cd: { currentTroops: 200 }, // ties C on troops too — power is the only thing left to break it
      },
      stationed: [
        { x: 100, y: 100, teamId: 't1', mine: true, mode: 'idle' },
        { x: 21, y: 20, teamId: 't2', mine: true, mode: 'idle' },
        { x: 21, y: 20, teamId: 't3', mine: true, mode: 'idle' },
        { x: 21, y: 20, teamId: 't4', mine: true, mode: 'idle' },
      ],
      getSave: () => ({
        cardInv: {
          cd: { id: 'cd', defId: 'lichuang', level: 9, gear: {}, locked: false },
          cc: { id: 'cc', defId: 'lichuang', level: 1, gear: {}, locked: false },
        },
        equipmentInv: {},
      }),
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    const labels = (showModal.mock.calls[0][1] as { label: string }[]).map((b) => b.label);
    const order = labels.filter((l) => l !== '✕').map((l) => l.split(' ·')[0]);
    expect(order).toEqual(['D_NearHeaviestStrong', 'C_NearHeavy', 'B_NearLight', 'A_Far']);
  });
});

// Idle-stationed attack parity (2026-08-08): reported bug (account tao) — a team stood idle in the field
// (停留, not 驻扎/garrison) after a successful occupy, so the attack picker listed it as pickable
// (busyTeamIds only ever excluded `mode==='garrison'`), the player picked it, and the server rejected the
// order with TEAM_BUSY — at the time, combatMarch/command.ts's idleRedispatch bypass only whitelisted kind
// 'occupy'/'move', never 'attack'. The user's desired behavior (confirmed): attack should have the SAME
// forward-staging parity as occupy — a team parked out in the field should be attackable-in-place too, no
// round trip home required. Fixed server-side (idleRedispatch now also covers 'attack') rather than
// tightening the client — the client filter was already correct for the target design, the server was the
// one lagging behind it.
describe('WorldMapNet.showTeamPicker — idle-stationed team has attack parity with occupy/move (2026-08-08)', () => {
  it('an idle (停留) stationed team is usable in the ATTACK picker too — parity with occupy/move', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 500 } },
      stationed: [{ x: 33, y: 289, teamId: 't1', mine: true, mode: 'idle' }],
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'attack');
    const buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.some((b) => b.label.startsWith('Alpha'))).toBe(true);
  });

  it('the same idle-stationed team remains usable for occupy/move', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 500 } },
      stationed: [{ x: 33, y: 289, teamId: 't1', mine: true, mode: 'idle' }],
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    expect((showModal.mock.calls[0][1] as { label: string }[]).some((b) => b.label.startsWith('Alpha'))).toBe(true);

    showModal.mockClear();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'move');
    expect((showModal.mock.calls[0][1] as { label: string }[]).some((b) => b.label.startsWith('Alpha'))).toBe(true);
  });

  it('a garrison-stationed (驻扎) team stays excluded from every kind, including attack', async () => {
    const { net, showModal } = buildHarness({
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 500 } },
      stationed: [{ x: 33, y: 289, teamId: 't1', mine: true, mode: 'garrison' }],
    });
    for (const kind of ['attack', 'occupy', 'move'] as const) {
      showModal.mockClear();
      await net.showTeamPicker(ANCHOR.x, ANCHOR.y, kind);
      expect((showModal.mock.calls[0][1] as { label: string }[]).some((b) => b.label.startsWith('Alpha'))).toBe(false);
    }
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

// Regression for the FIFTH "team has troops but occupy says No teams yet" bug (account tao, 2026-07-29,
// see slg-worldmap-me-stale-after-overlay-return memory). Root cause was one layer above showTeamPicker
// itself — WorldMapScene's cached ctx.me was never refetched when the City overlay (where Fill-troops
// actually runs) popped back to the still-alive map — but the actual mechanism these two tests pin is
// the one this file already exercises: showTeamPicker reads whatever cardState currently sits on ctx.me,
// and refreshMe() is what replaces a stale copy with a fresh one. Without refreshMe() actually updating
// ctx.me (or without showTeamPicker re-reading it live rather than snapshotting it once), the nav-level
// fix in app/nav/world.ts (world-map-return-refreshes-me.test.ts) would be calling the right function at
// the right time for nothing.
describe('WorldMapNet.refreshMe() — a team fully re-armed elsewhere becomes usable without a scene rebuild (2026-07-29)', () => {
  it('team is hidden from the occupy picker while ctx.me is stale (0 troops), then appears once refreshMe() re-fetches the real count', async () => {
    const { ctx, net, showModal, getMe } = buildHarness({
      teams: [{ id: 't1', name: 'Cards', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 0 } }, // as if ctx.me was fetched before Fill-troops ran in City
    });

    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    let buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.some((b) => b.label.startsWith('Cards'))).toBe(false);
    let head = showModal.mock.calls[0][0] as string[];
    expect(head).toContain(t('world.team.noTeamsOccupy'));

    // Server-side truth changed in the meantime (e.g. City's formation editor filled the team's troops
    // via distributeTroops) — a fresh getMe() now reports the real count. Nothing else touches ctx.me here.
    getMe.mockResolvedValueOnce({
      joined: true,
      mainBaseTile: ctx.me!.mainBaseTile,
      cardState: { c1: { currentTroops: 1300 } },
    } as PlayerWorldView);
    await net.refreshMe();

    showModal.mockClear();
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y, 'occupy');
    buttons = showModal.mock.calls[0][1] as { label: string }[];
    expect(buttons.some((b) => b.label.startsWith('Cards'))).toBe(true);
    head = showModal.mock.calls[0][0] as string[];
    expect(head).not.toContain(t('world.team.noTeamsOccupy'));
  });

  it('refreshMe() is a no-op once the scene is destroyed — a slow response landing after teardown must not resurrect ctx.me', async () => {
    const { ctx, net, getMe } = buildHarness({
      teams: [{ id: 't1', name: 'Cards', army: [{ cardInstanceId: 'c1' }] }],
      cardState: { c1: { currentTroops: 0 } },
    });
    const before = ctx.me;
    ctx.destroyed = true;
    getMe.mockResolvedValueOnce({ joined: true, mainBaseTile: ctx.me!.mainBaseTile, cardState: { c1: { currentTroops: 1300 } } } as PlayerWorldView);
    await net.refreshMe();
    expect(ctx.me).toBe(before); // untouched — refreshMe bailed out on ctx.destroyed
  });
});

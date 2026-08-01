// Coverage for ADR-058's busy-lock + button-greying extension to SectScene: a mutating action
// (leave/dissolve here, representative of create/join/vote/ally/unally which share the exact same
// `if (this.bt.busy) return; ... withTimeout(...) ... finally { this.bt.stop(); render() }`
// wrapper) must not fire twice while the first request is in flight, the bottom-bar button must
// grey out (no hit rect) during that window, and a hung request must time out and recover.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { SectScene } from '../../src/scenes/SectScene';
import type { WorldApiClient, SectDetailView } from '../../src/net/WorldApiClient';
import { TimeoutError } from '../../src/ui/busyTracker';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1280, 800];
const WORLD_ID = 'world:1:0';

function makeSectDetail(overrides: Partial<SectDetailView> = {}): SectDetailView {
  return {
    sectId: 'sect_1', worldId: WORLD_ID, name: 'Sky Sect', tag: 'SKY',
    leaderId: 'boss', leaderFamilyId: 'fam_1', memberFamilyCount: 1, prosperity: 0,
    memberFamilies: [], allySectIds: [],
    ...overrides,
  } as unknown as SectDetailView;
}

function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return { ...overrides } as unknown as WorldApiClient;
}

/** Builds the scene already parked in 'mySect' mode — bypasses loadData()'s network round-trip
 *  entirely, same reasoning as SectScene/sectCreateCost.ui.ts's buildNoSectScene. */
function buildMySectScene(worldApi: WorldApiClient, sect: SectDetailView, myAccountId = 'other'): any {
  const scene: any = new SectScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onNavTab() {},
    worldApi, worldId: WORLD_ID, myAccountId, playerName: 'Tester',
    getCoins: () => 0, refreshWallet: async () => {},
  });
  scene.inFamily = true;
  scene.myFamilyRole = 'leader'; // isFamilyLeader — shows the "Leave" bottom-bar button when not sect leader
  scene.sect = sect;
  scene.messages = [];
  scene.mode = 'mySect';
  scene.render();
  return scene;
}

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: node.x, y: node.y }; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };
function hitUnder(hits: Hit[], pos: { x: number; y: number }): Hit | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

describe('SectScene — busy lock prevents duplicate requests', () => {
  it('doLeave: a second call while the first is in flight does not re-issue the request', async () => {
    const leaveSect = vi.fn(() => new Promise<{ ok: true }>(() => {})); // never resolves
    const scene = buildMySectScene(stubWorldApi({ leaveSect }), makeSectDetail());

    void scene.doLeave();
    void scene.doLeave(); // busy — must short-circuit before touching worldApi
    await Promise.resolve();

    expect(leaveSect).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(true);
  });

  it('doDissolve: unlocks and re-renders once the request resolves', async () => {
    const dissolveSect = vi.fn(async () => ({ ok: true as const }));
    const sect = makeSectDetail({ leaderId: 'me' });
    const scene = buildMySectScene(stubWorldApi({ dissolveSect }), sect, 'me'); // cb.myAccountId === leaderId → isSectLeader

    await scene.doDissolve();

    expect(dissolveSect).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(false);
    expect(scene.mode).toBe('noSect'); // doDissolve's success path
  });
});

describe('SectScene — bottom-bar button greys out while busy', () => {
  it('Leave has a hit rect when idle, none while a request is pending, and one again once it settles', async () => {
    let resolveLeave!: (v: { ok: true }) => void;
    const leaveSect = vi.fn(() => new Promise<{ ok: true }>((r) => { resolveLeave = r; }));
    const scene = buildMySectScene(stubWorldApi({ leaveSect }), makeSectDetail());

    const pos = findLabelPos(scene.container, t('sect.leave'));
    expect(pos).not.toBeNull();
    expect(hitUnder(scene.hitRects, pos!)).toBeDefined(); // idle: clickable

    const pending = scene.doLeave();
    expect(hitUnder(scene.hitRects, pos!)).toBeUndefined(); // busy: greyed out, no hit rect

    resolveLeave({ ok: true });
    await pending;
    expect(hitUnder(scene.hitRects, pos!)).toBeUndefined(); // doLeave succeeded → mode flips to 'noSect', bar is gone
  });

  it('a second tap on the greyed button is a genuine no-op (hitRects has nothing to route it to)', async () => {
    const leaveSect = vi.fn(() => new Promise<{ ok: true }>(() => {}));
    const scene = buildMySectScene(stubWorldApi({ leaveSect }), makeSectDetail());
    const pos = findLabelPos(scene.container, t('sect.leave'))!;

    void scene.doLeave();
    // Simulate the input layer's hit-test during the busy window — same lookup handleDown performs.
    const hit = hitUnder(scene.hitRects, pos);
    expect(hit).toBeUndefined();
    expect(leaveSect).toHaveBeenCalledTimes(1);
  });
});

describe('SectScene — network timeout recovers cleanly', () => {
  it('a hung leaveSect() times out after 10s, toasts common.networkTimeout, and unlocks', async () => {
    vi.useFakeTimers();
    try {
      const leaveSect = vi.fn(() => new Promise<{ ok: true }>(() => {})); // never resolves
      const scene = buildMySectScene(stubWorldApi({ leaveSect }), makeSectDetail());
      const showToast = vi.spyOn(scene, 'showToast');

      const pending = scene.doLeave();
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;

      expect(showToast).toHaveBeenCalledWith(t('common.networkTimeout'), expect.anything());
      expect(scene.bt.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SectScene — errorMsg() classifies TimeoutError', () => {
  it('maps TimeoutError to the common.networkTimeout i18n key instead of falling through to String(e)', () => {
    const scene = buildMySectScene(stubWorldApi({}), makeSectDetail());
    expect(scene.errorMsg(new TimeoutError())).toBe(t('common.networkTimeout'));
  });
});

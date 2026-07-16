// Coverage for the sect-creation coin cost added alongside SLG_CITY_DESIGN's "帮会" flow: the
// no-sect screen must show SECT_CREATE_COST, gray out the Create button (no hit rect, so a stray
// tap can't fire the request) once the player can't afford it, and doCreate() must pull the
// server-side commercial spend back into the local wallet cache so the HUD balance stays correct.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { SECT_CREATE_COST } from '@nw/shared';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { SectScene } from '../../src/scenes/SectScene';
import type { WorldApiClient, SectDetailView } from '../../src/net/WorldApiClient';

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

function makeSectDetail(): SectDetailView {
  return {
    sectId: 'sect_1', worldId: WORLD_ID, name: 'Sky Sect', tag: 'SKY',
    leaderId: 'acc_test', leaderFamilyId: 'fam_1', memberFamilyCount: 1, prosperity: 0,
    memberFamilies: [], allySectIds: [],
  } as unknown as SectDetailView;
}

function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    getMyFamily: never,
    createSect: vi.fn(async () => makeSectDetail()),
    ...overrides,
  } as unknown as WorldApiClient;
}

/** Builds the scene already parked in 'noSect' mode as a family leader — the loadData() fetch
 *  that would normally get it there hangs forever (see stubWorldApi), so tests set it directly. */
function buildNoSectScene(coins: number, cb: Record<string, unknown> = {}): any {
  const scene: any = new SectScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onNavTab() {},
    worldApi: stubWorldApi(),
    worldId: WORLD_ID,
    myAccountId: 'acc_test',
    playerName: 'Tester',
    getCoins: () => coins,
    refreshWallet: async () => {},
    ...cb,
  });
  scene.inFamily = true;
  scene.myFamilyRole = 'leader';
  scene.mode = 'noSect';
  scene.render();
  return scene;
}

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
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

function hitUnder(hits: Hit[], pos: { x: number; y: number }): Hit | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

describe('SectScene — no-sect screen shows the create cost', () => {
  it('renders the SECT_CREATE_COST hint text', () => {
    const scene = buildNoSectScene(SECT_CREATE_COST);
    expect(collectTexts(scene.container)).toContain(t('sect.createHint', { n: SECT_CREATE_COST }));
    scene.destroy();
  });
});

describe('SectScene — Create Sect button afford-gating', () => {
  it('is clickable when the player can afford SECT_CREATE_COST', () => {
    const scene = buildNoSectScene(SECT_CREATE_COST);
    const pos = findLabelPos(scene.container, t('sect.create'));
    expect(pos).not.toBeNull();
    expect(hitUnder(scene.hitRects, pos!)).toBeDefined();
    scene.destroy();
  });

  it('has no hit rect when the player is short on coins — a stray tap cannot fire the request', () => {
    const scene = buildNoSectScene(SECT_CREATE_COST - 1);
    const pos = findLabelPos(scene.container, t('sect.create'));
    expect(pos).not.toBeNull();
    expect(hitUnder(scene.hitRects, pos!)).toBeUndefined();
    scene.destroy();
  });
});

describe('SectScene — doCreate() deducts the coin cost', () => {
  it('creates the sect then pulls the server-side spend back into the local wallet cache', async () => {
    const createSect = vi.fn(async () => makeSectDetail());
    const refreshWallet = vi.fn(async () => {});
    const scene = buildNoSectScene(SECT_CREATE_COST, {
      worldApi: stubWorldApi({ createSect }),
      refreshWallet,
    });
    scene.createName = 'Sky Sect';
    scene.createTag = 'SKY';

    await scene.doCreate();

    expect(createSect).toHaveBeenCalledWith(WORLD_ID, 'Sky Sect', 'SKY');
    expect(refreshWallet).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('does not spend or refresh the wallet when the create-form fields are invalid', async () => {
    const createSect = vi.fn(async () => makeSectDetail());
    const refreshWallet = vi.fn(async () => {});
    const scene = buildNoSectScene(SECT_CREATE_COST, {
      worldApi: stubWorldApi({ createSect }),
      refreshWallet,
    });
    scene.createName = '';
    scene.createTag = '';

    await scene.doCreate();

    expect(createSect).not.toHaveBeenCalled();
    expect(refreshWallet).not.toHaveBeenCalled();
    scene.destroy();
  });
});

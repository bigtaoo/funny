// Regression coverage for the "stuck Processing..." overlay bug (reported 2026-07-26): claiming
// a battle-pass reward left the loading overlay drawn forever once the request settled, because
// BattlePassScene.update() only re-renders while BusyTracker.busy is true (bt.tick short-circuits
// once stopped) — so clearing the overlay requires an explicit render() right after bt.stop(), on
// EVERY settle path. doClaim's success branch called render() only when the reward wasn't coins,
// and neither its catch branch nor onBuy's catch branch called render() at all. A player claiming
// a coin reward (the common case — see battlepassDefs.ts) or hitting a claim/buy error would see
// the overlay hang indefinitely even though the claim had already gone through server-side.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { BattlePassScene, type BattlePassCallbacks } from '../../src/scenes/BattlePassScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// drawLoadingOverlay's label is t('common.processing') + a run of dots — match the stable prefix.
const PROCESSING = t('common.processing');

function hasProcessingOverlay(container: PIXI.Container): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text.startsWith(PROCESSING)) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

/** Flush the microtask queue past withTimeout's Promise.race/.finally hops. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildBattlePass(cb: Partial<BattlePassCallbacks> = {}): BattlePassScene {
  return new BattlePassScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    // Lv.9 exactly (xp = 9*600): matches the reported repro (paid-track Lv.9, coins(30) —
    // see battlepassDefs.ts REWARD_ROWS).
    getBattlePass: () => ({ seasonNo: 1, xp: 5400, level: 9, hasPass: true, claimedFree: [], claimedPaid: [] }),
    ...cb,
  });
}

type Internals = { bt: { busy: boolean; loadingVisible: boolean }; doClaim(track: 'free' | 'paid', level: number): void; update(dt: number): void };

describe('BattlePassScene — claim loading overlay always clears', () => {
  it('clears the overlay once a coin-reward claim resolves (the reported repro: paid Lv.9, ×30 coins)', async () => {
    let resolveClaim!: (coins: number) => void;
    const scene = buildBattlePass({
      onClaim: () => new Promise<number>((res) => { resolveClaim = res; }),
    });
    const s = scene as unknown as Internals;

    s.doClaim('paid', 9);
    expect(s.bt.busy).toBe(true);

    // Cross the 1 s threshold so the overlay actually gets drawn (update() re-renders while busy).
    s.update(1.1);
    expect(s.bt.loadingVisible).toBe(true);
    expect(hasProcessingOverlay(scene.container)).toBe(true);

    resolveClaim(30);
    await flush();

    expect(s.bt.busy).toBe(false);
    expect(hasProcessingOverlay(scene.container)).toBe(false);
    scene.destroy();
  });

  it('clears the overlay when a claim fails (timeout / server error)', async () => {
    let rejectClaim!: (e: Error) => void;
    const scene = buildBattlePass({
      onClaim: () => new Promise<number>((_res, rej) => { rejectClaim = rej; }),
    });
    const s = scene as unknown as Internals;

    s.doClaim('paid', 9);
    s.update(1.1);
    expect(hasProcessingOverlay(scene.container)).toBe(true);

    rejectClaim(new Error('boom'));
    await flush();

    expect(s.bt.busy).toBe(false);
    expect(hasProcessingOverlay(scene.container)).toBe(false);
    scene.destroy();
  });

  it('clears the overlay when a non-coin reward claim resolves (unaffected branch, guards against regressing it)', async () => {
    let resolveClaim!: (coins: number) => void;
    const scene = buildBattlePass({
      // Lv.9 free = lead(2) — not a coins reward, so onClaim resolves 0 (BattlePassScene.onClaim
      // callback convention: reward.kind === 'coins' ? reward.count : 0, see app/nav/shop.ts).
      onClaim: () => new Promise<number>((res) => { resolveClaim = res; }),
    });
    const s = scene as unknown as Internals;

    s.doClaim('free', 9);
    s.update(1.1);
    expect(hasProcessingOverlay(scene.container)).toBe(true);

    resolveClaim(0);
    await flush();

    expect(s.bt.busy).toBe(false);
    expect(hasProcessingOverlay(scene.container)).toBe(false);
    scene.destroy();
  });
});

describe('BattlePassScene — buy loading overlay always clears', () => {
  function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
    let found: { x: number; y: number } | null = null;
    const walk = (node: PIXI.Container, px: number, py: number): void => {
      if (found) return;
      const gx = px + node.x;
      const gy = py + node.y;
      if (node instanceof PIXI.Text && node.text === label) { found = { x: gx, y: gy }; return; }
      for (const c of node.children) walk(c as PIXI.Container, gx, gy);
    };
    walk(container, 0, 0);
    return found;
  }

  it('clears the overlay when buying the pass fails', async () => {
    let rejectBuy!: (e: Error) => void;
    const scene = buildBattlePass({
      // hasPass: false so the Buy button renders.
      getBattlePass: () => ({ seasonNo: 1, xp: 5400, level: 9, hasPass: false, claimedFree: [], claimedPaid: [] }),
      onBuy: () => new Promise<void>((_res, rej) => { rejectBuy = rej; }),
    });
    const s = scene as unknown as { hits: Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>; bt: { busy: boolean; loadingVisible: boolean }; update(dt: number): void };

    const buyLabel = t('battlepass.buy', { coins: '600' });
    const pos = findLabelPos(scene.container, buyLabel);
    expect(pos, `label "${buyLabel}" not found`).not.toBeNull();
    const hit = s.hits.find(({ rect: r }) =>
      pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
    expect(hit, 'no hit rect under the Buy label').toBeDefined();
    hit!.fn();

    expect(s.bt.busy).toBe(true);
    s.update(1.1);
    expect(hasProcessingOverlay(scene.container)).toBe(true);

    rejectBuy(new Error('boom'));
    await flush();

    expect(s.bt.busy).toBe(false);
    expect(hasProcessingOverlay(scene.container)).toBe(false);
    scene.destroy();
  });
});

// Regression coverage for the "stuck Processing..." overlay bug (2026-07-26, same root cause as
// BattlePassScene/RechargeScene — see battlePassClaimOverlay.ui.ts): EventScene.update() only
// re-renders while BusyTracker.busy is true, so once doClaim's try/catch settles and `finally`
// flips bt.stop(), clearing the drawn overlay requires an explicit render() call right there. The
// success path already reloads via `await this.load()` (which itself renders), but the catch path
// (claim failure / network timeout) only stopped the tracker and toasted — never re-rendering —
// leaving the overlay hanging on error.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { EventScene, type EventCallbacks } from '../../src/scenes/EventScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildEvent(cb: Partial<EventCallbacks> = {}): EventScene {
  return new EventScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    ...cb,
  });
}

type Internals = {
  bt: { busy: boolean; loadingVisible: boolean };
  doClaim(eventId: string, rewardId: string): Promise<void>;
  update(dt: number): void;
};

function hasText(container: PIXI.Container, text: string): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === text) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

// Regression coverage (2026-08-03 fix): the Points Shop only translated 'coins' rewards — any
// material/skin reward fell back to the bare internal id or kind string with no i18n lookup at all
// (e.g. 'scrap', 'skin_e1'), unlike mail.ts's equivalent attMaterial/attSkin handling.
describe('EventScene — reward labels are localized, not raw ids', () => {
  it('a material reward shows the translated "Material {id} ×{n}" label, not the bare id', async () => {
    const scene = buildEvent({
      getEvents: async () => [{
        eventId: 'ev1', title: 'Test Event', windowStart: 0, windowEnd: 1, myPoints: 1000,
        tasks: [],
        rewards: [{ rewardId: 'r1', cost: 100, kind: 'material', id: 'scrap', count: 5, claimedCount: 0 }],
      }],
    });
    await flush();
    expect(hasText(scene.container, 'Material scrap ×5')).toBe(true);
    expect(hasText(scene.container, 'scrap')).toBe(false); // the old bare-id fallback
    scene.destroy();
  });

  it('a skin reward shows the translated "Skin {id}" label, not the bare kind/id', async () => {
    const scene = buildEvent({
      getEvents: async () => [{
        eventId: 'ev1', title: 'Test Event', windowStart: 0, windowEnd: 1, myPoints: 1000,
        tasks: [],
        rewards: [{ rewardId: 'r2', cost: 200, kind: 'skin', id: 'skin_e1', claimedCount: 0 }],
      }],
    });
    await flush();
    expect(hasText(scene.container, 'Skin skin_e1')).toBe(true);
    expect(hasText(scene.container, 'skin')).toBe(false); // the old bare-kind fallback
    scene.destroy();
  });
});

describe('EventScene — claim loading overlay always clears', () => {
  it('clears the overlay when a reward claim fails (timeout / server error)', async () => {
    const scene = buildEvent({
      onClaimReward: () => Promise.reject(new Error('boom')),
    });
    const s = scene as unknown as Internals;

    const claimPromise = s.doClaim('ev1', 'rw1');
    expect(s.bt.busy).toBe(true);
    s.update(1.1);
    expect(s.bt.loadingVisible).toBe(true);
    expect(hasProcessingOverlay(scene.container)).toBe(true);

    await claimPromise;
    await flush();

    expect(s.bt.busy).toBe(false);
    expect(hasProcessingOverlay(scene.container)).toBe(false);
    scene.destroy();
  });

  it('clears the overlay when a reward claim resolves', async () => {
    let resolveClaim!: (r: { pointsLeft: number }) => void;
    const scene = buildEvent({
      onClaimReward: () => new Promise((res) => { resolveClaim = res; }),
    });
    const s = scene as unknown as Internals;

    const claimPromise = s.doClaim('ev1', 'rw1');
    s.update(1.1);
    expect(hasProcessingOverlay(scene.container)).toBe(true);

    resolveClaim({ pointsLeft: 10 });
    await claimPromise;
    await flush();

    expect(s.bt.busy).toBe(false);
    expect(hasProcessingOverlay(scene.container)).toBe(false);
    scene.destroy();
  });
});

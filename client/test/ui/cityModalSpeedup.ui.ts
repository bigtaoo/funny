// Regression coverage for the build-detail modal's own speed-up button (2026-08-27).
//
// Why: the only speed-up control used to live in the build-queue bar (render.ts's
// renderBuildQueue), and CityScene.render() resets `hits` to `[backHit]` the moment a modal opens —
// so while the detail modal was up, that button was literally unreachable. A player watching
// "建造中" in the modal had to close it, hunt the queue bar, tap speed-up, and reopen. The button
// now sits on the same row as the "building…" label; these tests pin that it appears only for the
// queue HEAD with time left, that tapping it fires speedupBuild once at the queue bar's own price,
// and that it is the only speed-up reachable while the modal is up.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
//
// Layout caveat: the harness's measureText is a flat 7px/char, so the geometry assertions below
// pin the *rules* (same row, no overlap, hit covers its label) — not real-font widths. Those were
// checked against the real renderer in zh + de (the longest label) via the Playwright
// stub-mount recipe, see design/game/SLG_CITY_DESIGN.md §8.10.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { BUILD_SPEEDUP_SECS_PER_COIN } from '@nw/shared';
import type { WorldApiClient, PlayerWorldView, BuildingKey } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];

type Rect = { x: number; y: number; w: number; h: number };
type Hit = { rect: Rect; fn: () => void };
type CitySceneInternals = {
  w: number; h: number;
  hits: Hit[];
  selectedBuilding: BuildingKey | null;
  contentX: number;
  render(): void;
};

function internals(scene: CityScene): CitySceneInternals {
  return (scene as unknown as { core: CitySceneInternals }).core;
}

function textNodes(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function collectTexts(root: PIXI.Container): string[] {
  return textNodes(root).map((n) => n.text);
}

/**
 * A text node's on-screen rect — the modal lays out in a local frame that panelRoot scales up.
 *
 * `getGlobalPosition` returns the node's transform origin, which is its top-left only for the
 * default anchor (0,0); button labels are anchor(0.5,0.5)-centred since the 2026-08-30 widget
 * pass, so back the anchor out to get a real top-left either way.
 */
function screenRect(n: PIXI.Text): Rect {
  const p = n.getGlobalPosition(new PIXI.Point(), false);
  const s = n.worldTransform.a;
  const w = n.width * s;
  const h = n.height * s;
  return { x: p.x - n.anchor.x * w, y: p.y - n.anchor.y * h, w, h };
}

type QueueEntry = { key: BuildingKey; toLevel: number; secsLeft: number };
type Fixture = { levels?: Partial<Record<BuildingKey, number>>; queue: QueueEntry[] };

async function buildLoaded(
  fx: Fixture
): Promise<{ scene: CityScene; inner: CitySceneInternals; calls: Array<{ key: BuildingKey; coins: number }> }> {
  const calls: Array<{ key: BuildingKey; coins: number }> = [];
  const me = {
    // desk Lv.10 clears the desk-level gate, so the modal reaches its upgrade / speed-up row
    // rather than the "needs a bigger desk" line.
    resources: {}, buildings: { desk: 10, ...fx.levels }, cardState: {}, teamState: {},
    buildQueue: fx.queue.map((q) => ({
      key: q.key, toLevel: q.toLevel, completeAt: Date.now() + q.secsLeft * 1000,
    })),
  } as unknown as PlayerWorldView;
  const worldApi = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    // Never resolves: `bt.busy` therefore stays set, which is exactly what the double-tap test needs.
    speedupBuild: (_worldId: string, key: BuildingKey, coins: number) => {
      calls.push({ key, coins });
      return new Promise<PlayerWorldView>(() => {});
    },
  } as unknown as WorldApiClient;
  const cb: CitySceneCallbacks = {
    onBack: () => {},
    worldApi,
    worldId: 'world:1:0',
    // Keep the SLG opening guide chain's skip glyph out of the hit set.
    getFlag: () => true,
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  await new Promise((r) => setTimeout(r, 0));
  return { scene, inner: internals(scene), calls };
}

/** Opens the detail modal for `key`. Set directly rather than hunting the right grid card: which
 *  card sits where is cityScene.ui.ts's business, not this file's. */
function openModal(inner: CitySceneInternals, key: BuildingKey): void {
  inner.selectedBuilding = key;
  inner.render();
}

/** Every speed-up hit currently registered, identified by the closure it was pushed with. */
function speedupHits(inner: CitySceneInternals): Hit[] {
  return inner.hits.filter((h) => h.fn.toString().includes('doSpeedup'));
}

const INK_QUEUED: Fixture = {
  levels: { inkPot: 2, paperTray: 2 },
  queue: [{ key: 'inkPot', toLevel: 3, secsLeft: 24 * 3600 }],
};
const COINS_24H = Math.ceil((24 * 3600) / BUILD_SPEEDUP_SECS_PER_COIN);

describe('CityScene build-detail modal speed-up button', () => {
  it('shows the speed-up button beside "building…" and charges the remaining-time price for that building', async () => {
    const { scene, inner, calls } = await buildLoaded(INK_QUEUED);
    openModal(inner, 'inkPot');

    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.upgrading'));
    expect(texts).toContain(t('city.speedup').replace('{coins}', String(COINS_24H)));
    // The queued building offers no upgrade button — speed-up replaces it, it doesn't join it.
    expect(texts).not.toContain(t('city.upgrade'));

    const hits = speedupHits(inner);
    expect(hits.length).toBe(1);
    hits[0]!.fn();
    expect(calls).toEqual([{ key: 'inkPot', coins: COINS_24H }]);
    scene.destroy();
  });

  it('prices identically to the build-queue bar (same coin count, one shared rate constant)', async () => {
    const { scene, inner } = await buildLoaded(INK_QUEUED);
    openModal(inner, 'inkPot');
    // The dimmed queue bar underneath still renders its own label — both must read the same, or the
    // player sees two prices for one action depending on where they tap.
    const label = t('city.speedup').replace('{coins}', String(COINS_24H));
    expect(collectTexts(scene.container).filter((s) => s === label).length).toBe(2);
    scene.destroy();
  });

  it('is the ONLY speed-up reachable while the modal is up (the queue bar underneath is dropped)', async () => {
    const { scene, inner, calls } = await buildLoaded(INK_QUEUED);
    const beforeOpen = speedupHits(inner);
    expect(beforeOpen.length).toBe(1); // the queue bar's own button

    openModal(inner, 'inkPot');
    const hits = speedupHits(inner);
    expect(hits.length).toBe(1);
    // The surviving one is the modal's: it sits over the panel, not over the queue-bar strip, which
    // is where the pre-fix hit was — a tap at the old spot must now do nothing but close the modal.
    expect(hits[0]!.rect.y).toBeGreaterThan(beforeOpen[0]!.rect.y + beforeOpen[0]!.rect.h);
    expect(calls).toEqual([]);
    scene.destroy();
  });

  it('places the button on the "building…" row, clear of the label, wrapping its own text', async () => {
    const { scene, inner } = await buildLoaded(INK_QUEUED);
    openModal(inner, 'inkPot');
    const nodes = textNodes(scene.container);
    const label = t('city.speedup').replace('{coins}', String(COINS_24H));
    // Last match of each: the modal renders after (and over) the dimmed queue bar.
    const statusR = screenRect(nodes.filter((n) => n.text === t('city.upgrading')).pop()!);
    const btnLblR = screenRect(nodes.filter((n) => n.text === label).pop()!);
    const hit = speedupHits(inner)[0]!;

    // Same row, no overlap — the two share the 36px the upgrade button would have had.
    expect(btnLblR.x).toBeGreaterThan(statusR.x + statusR.w);
    expect(Math.abs((btnLblR.y + btnLblR.h / 2) - (statusR.y + statusR.h / 2))).toBeLessThan(16);
    // The hit rect actually covers the label it was sized from (a right-aligned button whose text
    // spilled outside its own border would read as "the button doesn't work" where it spilled).
    expect(hit.rect.x).toBeLessThanOrEqual(btnLblR.x + 1);
    expect(hit.rect.x + hit.rect.w).toBeGreaterThanOrEqual(btnLblR.x + btnLblR.w - 1);
    expect(hit.rect.y).toBeLessThanOrEqual(btnLblR.y + 1);
    expect(hit.rect.y + hit.rect.h).toBeGreaterThanOrEqual(btnLblR.y + btnLblR.h - 1);
    scene.destroy();
  });

  it('charges once when tapped twice in a row (in-flight guard — coins are real money)', async () => {
    const { scene, inner, calls } = await buildLoaded(INK_QUEUED);
    openModal(inner, 'inkPot');
    const hit = speedupHits(inner)[0]!;
    hit.fn();
    hit.fn(); // the stale rect from before the busy re-render — an impatient double-tap hits this
    expect(calls.length).toBe(1);
    scene.destroy();
  });

  it('rounds a sub-minute remainder up to 1 coin rather than offering a free finish', async () => {
    const { scene, inner, calls } = await buildLoaded({
      levels: { inkPot: 2 },
      queue: [{ key: 'inkPot', toLevel: 3, secsLeft: 30 }],
    });
    openModal(inner, 'inkPot');
    expect(collectTexts(scene.container)).toContain(t('city.speedup').replace('{coins}', '1'));
    speedupHits(inner)[0]!.fn();
    expect(calls).toEqual([{ key: 'inkPot', coins: 1 }]);
    scene.destroy();
  });

  it('drops the button once the queued build has no time left (the queue entry is about to clear)', async () => {
    const { scene, inner } = await buildLoaded({
      levels: { inkPot: 2 },
      queue: [{ key: 'inkPot', toLevel: 3, secsLeft: 0 }],
    });
    openModal(inner, 'inkPot');
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.upgrading'));
    expect(texts.some((s) => s.startsWith(t('city.speedup').split('{')[0]!))).toBe(false);
    expect(speedupHits(inner)).toEqual([]);
    scene.destroy();
  });

  it('leaves a NOT-queued building on its normal upgrade button (no speed-up leaks into it)', async () => {
    const { scene, inner } = await buildLoaded(INK_QUEUED);
    openModal(inner, 'paperTray');
    expect(collectTexts(scene.container)).toContain(t('city.upgrade'));
    expect(speedupHits(inner)).toEqual([]);
    scene.destroy();
  });

  // BUILD_QUEUE_SLOTS is 1 today, so this state is unreachable in production — the fixture fakes a
  // 2-entry queue to pin the rule for whenever the paid 2nd slot (§6) ships. `POST
  // /world/build/speedup` ignores `key` and burns coins off the queue FROM THE FRONT, so offering a
  // tail entry its own price would charge for shortening a different build.
  it('offers speed-up only for the queue HEAD, never a tail entry (server burns coins front-first)', async () => {
    const { scene, inner } = await buildLoaded({
      levels: { inkPot: 2, paperTray: 2 },
      queue: [
        { key: 'inkPot', toLevel: 3, secsLeft: 3600 },
        { key: 'paperTray', toLevel: 3, secsLeft: 7200 },
      ],
    });
    openModal(inner, 'paperTray');
    const texts = collectTexts(scene.container);
    // Still reads as queued — it just can't be bought forward on its own.
    expect(texts).toContain(t('city.upgrading'));
    expect(texts).not.toContain(t('city.upgrade'));
    expect(speedupHits(inner)).toEqual([]);
    scene.destroy();
  });
});

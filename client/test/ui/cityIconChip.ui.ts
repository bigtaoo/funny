// Coverage for the 2026-08-27 "主城图标太淡" fix (design/game/SLG_CITY_DESIGN.md §8.11).
//
// Two of the three parts of that fix live here; the third is in the atlas itself and is pinned by
// worldMapResMotifLevelRead.ui.ts ("every generic motif frame clears the UI ink floor").
//
//   · WHICH cards get a chip. Chips go behind resource motifs only — the resource bar and the five
//     producer cards — because those are open outlines with a transparent middle and nothing to
//     catch the eye on paper. Behind the dense hand-drawn bld_* art a chip actively hurts: it crops
//     the drawing's corners on its own rounded edge and lays a tint under fine hatching (screenshotted
//     both ways; wall came out a salmon blob). That split is the entire design decision, it is one
//     `producerResource()` call away from silently becoming "all of them" or "none of them", and
//     neither direction fails anything.
//   · The Lv.0 dim. 0.4 was set in the 2026-08-01 card redesign when every glyph read strongly;
//     multiplied into the faintest motifs it rendered an unbuilt 石墨坊 as a blank card. Anyone
//     "restoring" it to 0.4 would undo half the fix for the exact cards the report was about.
//
// What this file does NOT cover: the res_atlas never decodes under the headless adapter, so
// resIcon()/bldIcon() fall through to their emoji/line-art branch here and these assertions see chip
// STRUCTURE, not final art. That is the right split — which cards get a chip and how big the motif
// sits inside it are decisions, and decisions are what a test can hold; whether the result reads on
// screen was settled by screenshotting the running client, and would be a pixel-diff suite to keep.
// It does mean a mutation confined to the  branch of resIcon() is invisible to this file.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { CHIP_NODE_NAME, chipped, chipTint, producerResource, RES_COLORS } from '../../src/scenes/CityScene/icons';
import { BUILDING_KEYS } from '@nw/shared';
import type { BuildingKey, WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const LANDSCAPE: [number, number] = [1280, 800];
const PRODUCERS: BuildingKey[] = ['inkPot', 'paperTray', 'graphiteMill', 'metalForge', 'stickerShop'];

function chips(root: PIXI.Container): PIXI.Container[] {
  const found: PIXI.Container[] = [];
  const walk = (n: PIXI.DisplayObject): void => {
    if (n.name === CHIP_NODE_NAME) found.push(n as PIXI.Container);
    for (const c of (n as PIXI.Container).children ?? []) walk(c);
  };
  walk(root);
  return found;
}

type Internals = { selectedBuilding: string | null; render(): void };
const internals = (scene: CityScene): Internals => (scene as unknown as { core: Internals }).core;

/** A city with `levels` applied over an otherwise Lv.0 base, rendered and settled. */
async function city(levels: Partial<Record<BuildingKey, number>>): Promise<CityScene> {
  const buildings = Object.fromEntries(BUILDING_KEYS.map((k) => [k, levels[k] ?? 0]));
  const me = {
    resources: {}, buildings, buildQueue: [], trainingQueue: [],
    troops: 0, cardState: {}, teamState: {},
  } as unknown as PlayerWorldView;
  const api = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
  } as unknown as WorldApiClient;
  const cb: CitySceneCallbacks = {
    onBack: () => {}, worldApi: api, worldId: 'world:1:0',
    getFlag: () => true, setFlag: () => {},   // guide chain already seen — it mounts an overlay otherwise
  };
  const scene = new CityScene(createLayout(...LANDSCAPE), new InputManager(), cb);
  await new Promise((r) => { setTimeout(r, 0); });
  return scene;
}

describe('CityScene icon chips (2026-08-27 §8.11)', () => {
  it('producerResource() splits the grid exactly along "does this card produce a resource"', () => {
    expect(PRODUCERS.map(producerResource)).toEqual(['ink', 'paper', 'graphite', 'metal', 'sticker']);
    const rest = BUILDING_KEYS.filter((k) => !PRODUCERS.includes(k));
    expect(rest.map(producerResource)).toEqual(rest.map(() => undefined));
    // Guards the split itself rather than a hand-copied list: if a producer is ever added, this says so.
    expect(rest).toEqual(['desk', 'cabinet', 'drillYard', 'wall', 'academy', 'satchel']);
  });

  it('chipped() keeps the caller\'s box and centres the motif inside it', () => {
    // The chip has to be layout-neutral — call sites swap `bldIcon(k, 60, …)` for `chipped(60, …)`
    // and do not touch their own x/y. A chip that grew the box would push every card's glyph off
    // centre, which is exactly the kind of thing that looks "slightly wrong" and gets blamed on art.
    let asked = -1;
    const box = chipped(60, RES_COLORS.ink, (n) => { asked = n; return new PIXI.Container(); });
    expect(box.children).toHaveLength(2);
    expect(box.children[0]!.constructor).toBe(PIXI.Graphics);
    expect(asked).toBe(52);                        // 0.86 inset
    expect(box.children[1]!.x).toBe(4);            // (60 - 52) / 2, both axes
    expect(box.children[1]!.y).toBe(4);
    expect(box.getLocalBounds().width).toBe(60);
    expect(box.getLocalBounds().height).toBe(60);
  });

  it('darkens the graphite tint for the chip only, and passes every other accent through', () => {
    // Graphite's accent is a near-neutral pencil grey that lands within a couple of percent of the
    // paper under it at chip alpha — i.e. no chip at all. The bar and level stripe draw it as a solid
    // band where its lightness is fine, so the darkening must NOT reach RES_COLORS itself.
    expect(chipTint(RES_COLORS.graphite)).not.toBe(RES_COLORS.graphite);
    expect(RES_COLORS.graphite).toBe(0xb0b0a8);
    for (const rt of ['ink', 'paper', 'metal', 'sticker'] as const) {
      expect(chipTint(RES_COLORS[rt])).toBe(RES_COLORS[rt]);
    }
  });

  it('chips the resource bar and the five producer cards — and nothing else on the page', async () => {
    const scene = await city({ desk: 10, inkPot: 6, paperTray: 10, cabinet: 9, drillYard: 10, wall: 9, academy: 9, satchel: 9 });
    // 5 resource-bar cells + 5 producer cards. The other 6 buildings and the synthetic train tile
    // draw their glyph bare; all 12 grid tiles fit on screen in landscape at this size, so a chip
    // creeping onto one of them would land in this count rather than scrolling out of the assertion.
    expect(chips(scene.container)).toHaveLength(10);
  });

  it('leaves the upgrade modal and the header wall glyph bare', async () => {
    // resIcon/bldIcon deliberately do NOT chip themselves — the same two functions draw the 15px cost
    // icons inside the upgrade modal and the wall glyph in the header bar, and a tinted square behind
    // every inline number is noise, not legibility. That is a comment in icons.ts and nothing else,
    // so folding the chip down into those two functions (the "obvious" simplification of the two
    // call sites) would ship it into both places with nothing failing.
    //
    // Counted rather than asserted absent: the page still legitimately holds its 10 chips while a
    // modal is open, so "no chips anywhere" would be wrong. What must not move is the number.
    const scene = await city({ desk: 10, inkPot: 6, paperTray: 10, cabinet: 9, drillYard: 10, wall: 9, academy: 9, satchel: 9 });
    const closed = chips(scene.container).length;
    const inner = internals(scene);
    // paperTray, so the modal's own header glyph is a resource motif too — the case most likely to
    // pick up a chip by accident, and its cost rows carry several more resource icons besides.
    inner.selectedBuilding = 'paperTray';
    inner.render();
    expect(chips(scene.container)).toHaveLength(closed);
  });

  it('dims an unbuilt producer card to 0.65, not the old 0.4', async () => {
    // Lv.0 graphiteMill/metalForge/stickerShop; every other building built.
    const built = Object.fromEntries(BUILDING_KEYS.map((k) => [k, 9])) as Record<BuildingKey, number>;
    const scene = await city({ ...built, graphiteMill: 0, metalForge: 0, stickerShop: 0 });
    const dimmed = chips(scene.container).filter((c) => c.alpha !== 1);
    expect(dimmed).toHaveLength(3);
    expect(dimmed.map((c) => c.alpha)).toEqual([0.65, 0.65, 0.65]);
  });
});

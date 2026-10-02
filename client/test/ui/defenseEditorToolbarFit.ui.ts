// The attack-team editor's toolbar and header on a 360-wide German portrait screen (2026-09-29).
// Before: the hint shared the toggle row and was squeezed to 0.25 of its size (5 design px against a
// floor of 20), the 自动回城 / 领队 pills scaled their labels into fixed 116 / 76 boxes, the troop
// readout was squeezed into the ~190 px between the back pill and the title, and roster cells printed
// "<name> Lv.N" on one line scaled to fit. Now: pills sized from their labels, the hint on its own
// wrapped line(s) under them, the readout on a row of its own under the header, the level on its own
// line — and nothing on the screen drawn under the floor.
//
// Runs under the headless PIXI adapter (7px per character at any size). Run: npm run test:ui
import { describe, it, expect, vi, afterEach } from 'vitest';

// At the headless adapter's 7px per character the real German readout fits beside the title at the
// floor (it only fails at the real font's 11px), so the pool label is padded to force the other path.
const LONG_POOL = 'Truppenpool {n} (verfügbar für alle Teams dieses Spielers)';
// Likewise one hero name, long enough (at 7px) not to fit a three-column portrait roster cell.
const LONG_NAME = 'Chen Shou Chen';
vi.mock('../../src/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n')>();
  return {
    ...actual,
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'world.team.pool' ? LONG_POOL
        : key === 'card.chenshou.name' ? LONG_NAME
          : actual.t(key as never, params),
  };
});

import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { setFontScale, resetFontScaleForTest, fontFloorDesignPx } from '../../src/render/fontScale';
import { DefenseEditorScene, type DefenseEditorCallbacks } from '../../src/scenes/DefenseEditorScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('de', memStore, ['zh', 'en', 'de']);

afterEach(() => resetFontScaleForTest());

function buildScene(): DefenseEditorScene {
  // What ScalingManager sets for a 360-wide portrait phone: a 720-wide design at 1/2 (ADR-105).
  setFontScale(0.5, 720);
  const save = makeNewSave('acc_test');
  const defs = ['chenshou', 'lichuang', 'lena'];
  defs.forEach((defId, i) => { save.cardInv![`c${i}`] = { id: `c${i}`, defId, level: 9, gear: {}, locked: false }; });
  const worldApi = {
    getTeams: vi.fn().mockResolvedValue([{ id: 't1', name: 'Team 1', army: [] }]),
    setTeams: vi.fn().mockResolvedValue(undefined),
    getMe: vi.fn().mockResolvedValue({ cardState: {} } as PlayerWorldView),
  } as unknown as WorldApiClient;
  const cb: DefenseEditorCallbacks = {
    onBack: vi.fn(), getSave: () => save, worldApi, worldId: 'world:1:0',
    target: { mode: 'attack', teamId: 't1', teamName: 'Team 1' },
  };
  return new DefenseEditorScene(createLayout(360, 640), new InputManager(), cb);
}

function texts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Text) out.push(n);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

/** Font size × every scale between the label and the scene container. */
function drawnSize(l: PIXI.Text, root: PIXI.Container): number {
  let s = l.style.fontSize as number;
  for (let n: PIXI.Container | null = l; n && n !== root; n = n.parent) s *= n.scale.x;
  return s;
}

describe('DefenseEditorScene attack mode — 360x640, German', () => {
  it('draws no label under the legibility floor', () => {
    const scene = buildScene();
    const all = texts(scene.container).filter((l) => l.text.trim().length > 0 && l.visible);
    expect(all.length).toBeGreaterThan(10);
    // The floor at 0.5 (a 720-wide design on a 360-wide phone, ADR-105).
    for (const l of all) expect(drawnSize(l, scene.container), `"${l.text}"`).toBeGreaterThanOrEqual(fontFloorDesignPx(0.5) - 1e-6);
    scene.destroy();
  });

  it('puts the hint on its own wrapped line(s) under the toggles, inside the grid half', () => {
    const scene = buildScene();
    const all = texts(scene.container);
    const hint = all.find((l) => l.text === t('world.team.hint'))!;
    expect(hint).toBeDefined();
    expect(hint.style.wordWrap, 'wraps').toBe(true);
    const pills = [t('world.defense.erase'), `★ ${t('world.team.leader')}`]
      .map((s) => all.find((l) => l.text === s)!);
    const hb = hint.getBounds();
    for (const p of pills) {
      expect(p).toBeDefined();
      expect(hb.top).toBeGreaterThanOrEqual(p.getBounds().bottom);
    }
    // Inside the left (grid) half.
    const core = (scene as unknown as { core: { w: number; gridY: number } }).core;
    expect(hb.right).toBeLessThanOrEqual(core.w / 2 + 1);
    // The grid starts below the hint.
    expect(core.gridY).toBeGreaterThanOrEqual(hb.bottom);
    scene.destroy();
  });

  it('moves a readout too wide for the header gap onto its own row under the header', () => {
    const scene = buildScene();
    const all = texts(scene.container);
    const readout = all.find((l) => l.text.includes(LONG_POOL.slice(0, 12)))!;
    expect(readout).toBeDefined();
    const titleText = (scene as unknown as { core: { titleText(): string } }).core.titleText();
    const title = all.find((l) => l.text === titleText)!;
    expect(title, `title "${titleText}"`).toBeDefined();
    const rb = readout.getBounds();
    expect(rb.top).toBeGreaterThanOrEqual(title.getBounds().bottom);
    // ...and the toolbar and grid moved down to make room for it.
    const erase = all.find((l) => l.text === t('world.defense.erase'))!;
    expect(erase.getBounds().top).toBeGreaterThanOrEqual(rb.bottom);
    scene.destroy();
  });

  it('prints the hero level on its own line in roster cells', () => {
    const scene = buildScene();
    const all = texts(scene.container);
    expect(all.some((l) => l.text === t('card.chenshou.name'))).toBe(true);
    expect(all.some((l) => /\S Lv\.\d/.test(l.text))).toBe(false);
    expect(all.filter((l) => l.text === 'Lv.9').length).toBe(3);
    scene.destroy();
  });

  it('drops to fewer roster columns rather than squeezing or cutting a name', () => {
    const scene = buildScene();
    const names = [LONG_NAME, t('card.lichuang.name'), t('card.lena.name')]
      .map((n) => texts(scene.container).find((l) => l.text === n));
    for (const n of names) expect(n, 'name drawn in full').toBeDefined();
    // Three cards, fewer columns than three. Two in a real Chrome (sweep 2026-10-01, 720-wide design);
    // this harness's flat 7-px-per-character measure makes the long name wider still and lands on
    // one — either way the third card wraps rather than the names being squeezed.
    expect(new Set(names.map((n) => Math.round(n!.getGlobalPosition().x))).size).toBeLessThanOrEqual(2);
    scene.destroy();
  });

  it('keeps the Fill / Clear / Save buttons off the title (they move under the header in portrait)', () => {
    const scene = buildScene();
    const all = texts(scene.container);
    const titleText = (scene as unknown as { core: { titleText(): string } }).core.titleText();
    const tb = all.find((l) => l.text === titleText)!.getBounds();
    const buttons = [t('world.team.fill'), t('world.defense.clear'), t('world.defense.save')]
      .map((s) => all.find((l) => l.text === s));
    for (const b of buttons) {
      expect(b, 'button label drawn').toBeDefined();
      const bb = b!.getBounds();
      const overlaps = bb.left < tb.right && bb.right > tb.left && bb.top < tb.bottom && bb.bottom > tb.top;
      expect(overlaps, `"${b!.text}" covers the title`).toBe(false);
    }
    scene.destroy();
  });
});

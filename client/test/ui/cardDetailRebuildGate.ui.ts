// Regression coverage for the 2026-08-24 detail-modal rebuild gate (design/game/CHARACTER_CARDS_DESIGN_IMPL.md
// §10.5). CardScene.render() runs for reasons that have nothing to do with the modal — a busy-dot
// tick, a save-changed ping, a portrait texture finishing its load — and it used to call
// DetailPanel.openDetail() on every one of them, re-minting ~15 PIXI.Text whose resolution is
// `dpr × modalScale` (2–2.3x). Those are the most expensive text nodes in the scene: ~4.3 ms per
// pass, measured in Chrome at dpr 1.
//
// render() now goes through ensureDetail(), which rebuilds only when the panel's signature moved.
// The risk that buys is the opposite failure — a modal that never updates — so both directions are
// pinned here, plus the modal-hit list surviving a skip (it is only repopulated by a rebuild).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import type { CardInstance } from '../../src/game/meta/SaveData';
import type { CardSLGState } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

interface SceneInternals {
  core: {
    detailId: string | null;
    modalLayer: PIXI.Container;
    modalHits: { rect: unknown; action: () => void }[];
    skinPickerOpen: boolean;
  };
  detail: { openDetail(id: string): void };
  render(): void;
}

function buildScene(): {
  scene: CardScene;
  save: SaveData;
  card: CardInstance;
  setCardState(next: Record<string, CardSLGState> | undefined): void;
} {
  const card: CardInstance = { id: 'a', defId: 'max', level: 3, gear: {}, locked: false };
  const save = makeNewSave();
  save.cardInv = { a: card, b: { id: 'b', defId: 'max', level: 3, gear: {}, locked: false } };
  let cardState: Record<string, CardSLGState> | undefined;
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    getCardState: () => cardState,
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb);
  return { scene, save, card, setCardState: (next) => { cardState = next; } };
}

/** Every node in the modal layer, in scene-graph order — the identity set a rebuild would replace. */
function modalNodes(core: SceneInternals['core']): PIXI.DisplayObject[] {
  const out: PIXI.DisplayObject[] = [];
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) { out.push(c); walk(c as PIXI.Container); }
  };
  walk(core.modalLayer);
  return out;
}

describe('CardScene detail modal — render() does not rebuild an unchanged panel (2026-08-24)', () => {
  it('leaves every node (and the modal hit list) alone across repeated renders', () => {
    const { scene } = buildScene();
    const internals = scene as unknown as SceneInternals;
    internals.detail.openDetail('a');

    const before = modalNodes(internals.core);
    expect(before.length).toBeGreaterThan(10);   // sanity: the panel really is drawn
    const hitsBefore = internals.core.modalHits.length;
    expect(hitsBefore).toBeGreaterThan(0);

    internals.render();
    internals.render();

    const after = modalNodes(internals.core);
    expect(after.length).toBe(before.length);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    // modalHits is only ever repopulated by a rebuild, so a skip that dropped it would leave the
    // panel drawn but dead to taps.
    expect(internals.core.modalHits.length).toBe(hitsBefore);

    scene.destroy();
  });

  it('still rebuilds when the card itself changed (a fuse levelled it up)', () => {
    const { scene, save } = buildScene();
    const internals = scene as unknown as SceneInternals;
    internals.detail.openDetail('a');
    const before = modalNodes(internals.core);

    save.cardInv!['a']!.level = 5;
    internals.render();

    const after = modalNodes(internals.core);
    expect(after.some((n, i) => n !== before[i])).toBe(true);

    scene.destroy();
  });

  it('still rebuilds when late SLG state arrives (troop count / deployed tag)', () => {
    const { scene, setCardState } = buildScene();
    const internals = scene as unknown as SceneInternals;
    internals.detail.openDetail('a');
    const before = modalNodes(internals.core);

    setCardState({ a: { currentTroops: 12, injuredUntil: 0, teamId: 't1' } as CardSLGState });
    internals.render();

    const after = modalNodes(internals.core);
    expect(after.some((n, i) => n !== before[i])).toBe(true);

    scene.destroy();
  });

  it('still rebuilds when only modal-local state changed (skin picker opened)', () => {
    const { scene } = buildScene();
    const internals = scene as unknown as SceneInternals;
    internals.detail.openDetail('a');
    const before = modalNodes(internals.core);

    internals.core.skinPickerOpen = true;
    internals.render();

    const after = modalNodes(internals.core);
    expect(after.some((n, i) => n !== before[i])).toBe(true);

    scene.destroy();
  });

  it('rebuilds when the modal was closed and reopened for a different card', () => {
    const { scene } = buildScene();
    const internals = scene as unknown as SceneInternals;
    internals.detail.openDetail('a');
    const before = modalNodes(internals.core);

    internals.core.detailId = 'b';
    internals.render();

    const after = modalNodes(internals.core);
    expect(after.some((n, i) => n !== before[i])).toBe(true);

    scene.destroy();
  });
});

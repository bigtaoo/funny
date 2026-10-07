// Drag ghost + landing preview (render/GameRenderer/dragGhost.ts, art-direction-map-ui.md §7.2.2): the
// dragged card is the hand card's own art with its cost badge, and over a drop that would be
// accepted a translucent unit / building sits on the cell it would land on, sized like the real
// thing, while the ghost fades. Over a drop that would be rejected there is no preview.
//
// Same headless setup and deterministic ch1_lv1 opening hand as gameRendererInput.ui.ts. The headless
// adapter never decodes PNGs, so hand-card art is stubbed with Texture.WHITE where a test needs it,
// and the building sprite's own texture is checked through landingSpot() rather than the sprite.
// Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';
import { BASE_COLS } from '@nw/engine/config';
import { UnitType } from '@nw/engine/types';
import { targetScreenHeight } from '../../src/render/unitSize';
import { BUILDING_SPRITE_SIZE } from '../../src/render/BuildingView';
import {
  landingSpot, GHOST_ALPHA, GHOST_ALPHA_OVER_LANDING, LANDING_ALPHA,
} from '../../src/render/GameRenderer/dragGhost';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Hand-slot indices in the deterministic ch1_lv1 opening hand (see gameRendererInput.ui.ts). */
const SLOT_UNIT_SHIELDBEARER = 2;
const SLOT_BUILDING_TOWER_A  = 0;

function buildRenderer() {
  const { engine } = createLocalMatch({ level: getLevel('ch1_lv1')! });
  const layout = createLayout(800, 1280);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  for (let i = 0; i < 5; i++) renderer.update(1 / 30);
  const core = (renderer as any).core;
  return { engine, layout, input, renderer, core, panel: (renderer as any).input };
}

describe('drag ghost', () => {
  it('shows the hand card art and cost badge instead of the name when the art is loaded', () => {
    const { renderer, core } = buildRenderer();
    vi.spyOn(core.handView, 'artTextureAt').mockReturnValue(PIXI.Texture.WHITE);
    const ghost = core.input.buildCardGhost(SLOT_UNIT_SHIELDBEARER) as PIXI.Container;
    const sprites = ghost.children.filter((c) => c instanceof PIXI.Sprite && !(c instanceof PIXI.Text));
    const texts = ghost.children.filter((c): c is PIXI.Text => c instanceof PIXI.Text);
    expect(sprites).toHaveLength(1);
    expect((sprites[0] as PIXI.Sprite).texture).toBe(PIXI.Texture.WHITE);
    // The only text left is the cost digit.
    expect(texts.map((t) => t.text)).toEqual(['6']);
    ghost.destroy({ children: true });
    renderer.destroy();
  });

  it('falls back to the card name when the art has not decoded', () => {
    const { renderer, core } = buildRenderer();
    vi.spyOn(core.handView, 'artTextureAt').mockReturnValue(null);
    const ghost = core.input.buildCardGhost(SLOT_UNIT_SHIELDBEARER) as PIXI.Container;
    const texts = ghost.children.filter((c): c is PIXI.Text => c instanceof PIXI.Text).map((t) => t.text);
    expect(texts).toContain('Shield Bearer');
    ghost.destroy({ children: true });
    renderer.destroy();
  });
});

describe('landing preview', () => {
  it('a unit over a free attack lane previews at its spawn cell, at its real height, and fades the ghost', () => {
    const { layout, input, renderer, core, panel } = buildRenderer();
    vi.spyOn(core.handView, 'artTextureAt').mockReturnValue(PIXI.Texture.WHITE);
    const from = core.handView.slotCenter(SLOT_UNIT_SHIELDBEARER);
    // Pointer anywhere in lane 1 — the unit still lands on the spawn row.
    const to = layout.gridToScreen(1, 5);
    input._emitDown(from.x, from.y);
    input._emitMove(to.x, to.y);

    const sprite = panel.drag.landing.sprite as PIXI.Sprite;
    const spawn = layout.gridToScreen(1, core.localSpawnRow);
    expect(sprite.visible).toBe(true);
    expect(sprite.alpha).toBe(LANDING_ALPHA);
    expect(sprite.x).toBeCloseTo(spawn.x);
    expect(sprite.y).toBeCloseTo(spawn.y);
    expect(sprite.height).toBeCloseTo(targetScreenHeight(UnitType.ShieldBearer));
    expect(panel.drag.ghost.alpha).toBe(GHOST_ALPHA_OVER_LANDING);

    // Off the lanes (a base column): no preview, the ghost is opaque again.
    const base = layout.gridToScreen(BASE_COLS[0], 5);
    input._emitMove(base.x, base.y);
    expect(sprite.visible).toBe(false);
    expect(panel.drag.ghost.alpha).toBe(GHOST_ALPHA);

    // Dropping frees the preview along with the ghost.
    input._emitMove(to.x, to.y);
    input._emitUp(to.x, to.y);
    expect(panel.drag).toBeNull();
    expect(sprite.destroyed).toBe(true);
    renderer.destroy();
  });

  it('a unit over a lane whose spawn cell is occupied has no preview', () => {
    const { engine, renderer, core } = buildRenderer();
    vi.spyOn(engine.state.board, 'isCellOccupiedByUnit').mockReturnValue(true);
    const card = core.localPlayer(engine.state).hand.slots[SLOT_UNIT_SHIELDBEARER].card;
    expect(landingSpot(core, card, PIXI.Texture.WHITE, 1, 5)).toBeNull();
    renderer.destroy();
  });

  it('a building previews on its build cell at its board size, and not on a cell already built on', () => {
    const { engine, layout, renderer, core } = buildRenderer();
    const card = core.localPlayer(engine.state).hand.slots[SLOT_BUILDING_TOWER_A].card;
    const spot = landingSpot(core, card, null, 3, 6)!;
    const cell = layout.gridToScreen(3, core.localBuildRow);
    expect(spot).not.toBeNull();
    expect([spot.x, spot.y]).toEqual([cell.x, cell.y]);
    expect([spot.w, spot.h]).toEqual([BUILDING_SPRITE_SIZE, BUILDING_SPRITE_SIZE]);

    vi.spyOn(engine.state.board, 'hasBuildingAt').mockReturnValue(true);
    expect(landingSpot(core, card, null, 3, 6)).toBeNull();
    expect(landingSpot(core, card, null, BASE_COLS[0], 6)).toBeNull();
    renderer.destroy();
  });
});

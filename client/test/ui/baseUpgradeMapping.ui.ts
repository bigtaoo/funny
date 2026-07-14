// Battle base-upgrade rendering: owner→sprite mapping + texture-swap re-fit.
//
// Guards two things a player would misread as "the wrong base changed":
//   1. Owner→sprite mapping — upgrading a player's base swaps *that* player's base
//      sprite, never the opponent's. Verified for the host (localSide Bottom, local =
//      owner 0) and the netplay joiner (localSide Top, local = owner 1), plus the
//      AI-enemy-upgrades case (the enemy base legitimately changes on its own).
//   2. Texture-swap re-fit — the upgrade-tier frames (256×256) have a different native
//      size than game_base.png (324×256). setBaseUpgradeLevel must re-apply the base
//      footprint after the swap, or the retained scale renders the upgraded base at
//      ~79% width (squished), and must preserve the enemy base's mirror flip.
//
// Headless GameRenderer via the pixiHeadless adapter (same approach as
// gameRendererInput.ui.ts). The upgrade atlas can't decode in Node, so it's mocked to
// hand back distinct dummy textures per tier.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';

const TEX1 = PIXI.Texture.WHITE;
const TEX2 = PIXI.Texture.EMPTY;
vi.mock('../../src/render/baseUpgradeAtlasLoader', () => ({
  loadBaseUpgradeAtlas: () => Promise.resolve(),
  isBaseUpgradeAtlasReady: () => true,
  getBaseUpgradeTexture: (tier: 1 | 2) => (tier === 1 ? TEX1 : TEX2),
}));

import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel, Side } from '../../src/game';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function probe(localSide: Side, whoUpgrades: 'bottom' | 'top') {
  const level = getLevel('ch1_lv1')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(800, 1280, localSide);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  for (let i = 0; i < 5; i++) renderer.update(1 / 30);

  // Simulate the engine having applied a confirmed upgrade for the given player
  // (bottom = owner 0, top = owner 1); the renderer swaps the matching base sprite.
  engine.state[whoUpgrades === 'bottom' ? 'bottomPlayer' : 'topPlayer'].upgradeLevel = 1;
  for (let i = 0; i < 3; i++) renderer.update(1 / 30);

  const bv: any = (renderer as any).boardView;
  // The base whose owner just upgraded, in this client's local frame.
  const upgraded = (whoUpgrades === 'bottom') === (localSide === Side.Bottom) ? bv.playerBase : bv.enemyBase;
  const r = {
    playerBaseHasNewTex: bv.playerBase.sprite.texture === TEX1,
    enemyBaseHasNewTex: bv.enemyBase.sprite.texture === TEX1,
    upgradedDisplayW: Math.abs(upgraded.sprite.width), // abs() drops the mirror sign
    upgradedRectW: upgraded.rect.w,
    enemyMirrored: bv.enemyBase.sprite.scale.x < 0,
  };
  renderer.destroy();
  return r;
}

describe('battle base upgrade — owner→sprite mapping', () => {
  it('host (localSide Bottom): upgrading the LOCAL base changes playerBase, not enemyBase', () => {
    const r = probe(Side.Bottom, 'bottom');
    expect(r.playerBaseHasNewTex).toBe(true);
    expect(r.enemyBaseHasNewTex).toBe(false);
  });

  it('joiner (localSide Top): upgrading the LOCAL base changes playerBase, not enemyBase', () => {
    const r = probe(Side.Top, 'top');
    expect(r.playerBaseHasNewTex).toBe(true);
    expect(r.enemyBaseHasNewTex).toBe(false);
  });

  it('host: when the AI enemy upgrades its own base, only enemyBase changes', () => {
    const r = probe(Side.Bottom, 'top');
    expect(r.enemyBaseHasNewTex).toBe(true);
    expect(r.playerBaseHasNewTex).toBe(false);
  });
});

describe('battle base upgrade — texture swap re-fits the footprint', () => {
  it('upgraded base keeps its footprint width (no 324→256 squish)', () => {
    const r = probe(Side.Bottom, 'bottom');
    expect(r.upgradedDisplayW).toBeCloseTo(r.upgradedRectW, 3);
  });

  it('upgrading the enemy base keeps its footprint width and its mirror flip', () => {
    const r = probe(Side.Bottom, 'top');
    expect(r.upgradedDisplayW).toBeCloseTo(r.upgradedRectW, 3);
    expect(r.enemyMirrored).toBe(true);
  });
});

describe('battle base upgrade — one-shot level-up effect routing', () => {
  // The transient flash must land on the SAME base as the tier swap: routed via
  // owner===sideToOwner(localSide). It adds a ring Graphics under that base's
  // container (base.sprite.parent) — assert the ring lands on the local player's
  // base and NOT the enemy's, for both host and joiner.
  function effectProbe(localSide: Side, owner: 0 | 1) {
    const level = getLevel('ch1_lv1')!;
    const { engine } = createLocalMatch({ level });
    const layout = createLayout(800, 1280, localSide);
    const input = new InputManager();
    const renderer = new GameRenderer(engine, layout, input);
    renderer.init();
    for (let i = 0; i < 5; i++) renderer.update(1 / 30);

    const bv: any = (renderer as any).boardView;
    const kids = (b: any) => (b.sprite.parent?.children.length ?? 0);
    const before = { player: kids(bv.playerBase), enemy: kids(bv.enemyBase) };
    bv.playBaseUpgradeEffect(owner);
    const after = { player: kids(bv.playerBase), enemy: kids(bv.enemyBase) };
    renderer.destroy();
    return { before, after };
  }

  it('host: local upgrade (owner 0) adds the effect ring to playerBase only', () => {
    const { before, after } = effectProbe(Side.Bottom, 0);
    expect(after.player).toBe(before.player + 1);
    expect(after.enemy).toBe(before.enemy);
  });

  it('joiner: local upgrade (owner 1) adds the effect ring to playerBase only', () => {
    const { before, after } = effectProbe(Side.Top, 1);
    expect(after.player).toBe(before.player + 1);
    expect(after.enemy).toBe(before.enemy);
  });
});

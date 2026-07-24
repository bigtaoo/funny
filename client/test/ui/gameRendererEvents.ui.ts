// GameRenderer EventMixin coverage — GameEvent dispatch, the projectile/escort sprite pools, and the
// base-damage vignette. Added alongside the GameRenderer.ts → GameRenderer/{base,input,events}.ts
// mixin split.
//
// These call `(renderer as any).handleEvent(event, state)` directly with hand-built GameEvents
// instead of driving the real engine into producing them (e.g. waiting for an archer to draw and
// fire): handleEvent's `state` param is unused by every branch (confirmed by reading events.ts), so
// synthetic events exercise exactly the same dispatch code the engine would drive, without depending
// on RNG-drawn card types or attack timing.
//
// Same headless approach as gameScenes.ui.ts — pixiHeadless (vitest.ui.config.ts setupFiles) builds
// the real PIXI tree in plain Node.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';
import { SpellType } from '../../src/game';
import { toFp } from '@nw/engine/math/fixed';
import { factionInk } from '../../src/render/theme';

// In-memory storage so initI18n (which persists the locale) has somewhere to write.
const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function buildRenderer() {
  const level = getLevel('ch1_lv1')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(800, 1280);
  const input = new InputManager();
  const renderer = new GameRenderer(engine, layout, input);
  renderer.init();
  return { engine, layout, renderer };
}

describe('GameRenderer EventMixin — projectile pool', () => {
  it('fired → hit removes the sprite and recycles it into the pool for the next fire', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;

    r.handleEvent(
      { type: 'projectile_fired', projectileId: 1, attackerId: 1, from: { col: 2, y_fp: toFp(3) }, kind: 'arrow' },
      engine.state,
    );
    expect(r.projectileSprites.has(1)).toBe(true);
    const firstSprite = r.projectileSprites.get(1);
    expect(r.projectileLayer.children).toContain(firstSprite);

    r.handleEvent({ type: 'projectile_hit', projectileId: 1 }, engine.state);
    expect(r.projectileSprites.has(1)).toBe(false);
    expect(r.projectilePool).toContain(firstSprite);

    r.handleEvent(
      { type: 'projectile_fired', projectileId: 2, attackerId: 1, from: { col: 4, y_fp: toFp(5) }, kind: 'arrow' },
      engine.state,
    );
    // Pool reuse: the second fire must reclaim the exact same container, not allocate a new one.
    expect(r.projectileSprites.get(2)).toBe(firstSprite);
    expect(r.projectilePool).not.toContain(firstSprite);
    renderer.destroy();
  });

  it('an expired (fizzled) projectile is also removed and recycled', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;

    r.handleEvent(
      { type: 'projectile_fired', projectileId: 9, attackerId: 1, from: { col: 0, y_fp: toFp(0) }, kind: 'arrow' },
      engine.state,
    );
    r.handleEvent({ type: 'projectile_expired', projectileId: 9 }, engine.state);
    expect(r.projectileSprites.has(9)).toBe(false);
    expect(r.projectilePool.length).toBe(1);
    renderer.destroy();
  });

  it('projectile_moved updates the tracked sprite position to the authoritative coords', () => {
    const { engine, layout, renderer } = buildRenderer();
    const r = renderer as any;

    r.handleEvent(
      { type: 'projectile_fired', projectileId: 3, attackerId: 1, from: { col: 0, y_fp: toFp(0) }, kind: 'arrow' },
      engine.state,
    );
    r.handleEvent({ type: 'projectile_moved', projectileId: 3, col_fp: toFp(2), y_fp: toFp(4) }, engine.state);

    const sprite = r.projectileSprites.get(3);
    const expected = layout.gridToScreen(2, 4);
    expect(sprite.x).toBeCloseTo(expected.x);
    expect(sprite.y).toBeCloseTo(expected.y);
    renderer.destroy();
  });
});

describe('GameRenderer EventMixin — escort sprite lifecycle', () => {
  it('spawned → moved tracks position; died and arrived both remove the sprite immediately', () => {
    const { engine, layout, renderer } = buildRenderer();
    const r = renderer as any;

    r.handleEvent(
      { type: 'escort_spawned', escortId: 'e1', col_fp: toFp(2), row_fp: toFp(3), hp: 100, maxHp: 100 },
      engine.state,
    );
    expect(r.escortSprites.has('e1')).toBe(true);
    const sprite = r.escortSprites.get('e1');
    expect(r.escortLayer.children).toContain(sprite);
    const spawnPos = layout.gridToScreen(2, 3);
    expect(sprite.x).toBeCloseTo(spawnPos.x);
    expect(sprite.y).toBeCloseTo(spawnPos.y);

    r.handleEvent({ type: 'escort_moved', escortId: 'e1', col_fp: toFp(4), row_fp: toFp(5) }, engine.state);
    const movedPos = layout.gridToScreen(4, 5);
    expect(sprite.x).toBeCloseTo(movedPos.x);
    expect(sprite.y).toBeCloseTo(movedPos.y);

    // escort_hp_changed must not throw and must not remove the sprite from tracking.
    r.handleEvent({ type: 'escort_hp_changed', escortId: 'e1', hp: 40, maxHp: 100 }, engine.state);
    expect(r.escortSprites.has('e1')).toBe(true);

    r.handleEvent({ type: 'escort_died', escortId: 'e1' }, engine.state);
    // The map entry is removed synchronously; the fade-out itself runs on PIXI.Ticker
    // (not asserted here — see BoardView/UnitView destroy-contract tests for ticker cleanup).
    expect(r.escortSprites.has('e1')).toBe(false);
    renderer.destroy();
  });

  it('escort_arrived also removes the sprite from tracking', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;

    r.handleEvent(
      { type: 'escort_spawned', escortId: 'e2', col_fp: toFp(1), row_fp: toFp(1), hp: 50, maxHp: 50 },
      engine.state,
    );
    expect(r.escortSprites.has('e2')).toBe(true);
    r.handleEvent({ type: 'escort_arrived', escortId: 'e2' }, engine.state);
    expect(r.escortSprites.has('e2')).toBe(false);
    renderer.destroy();
  });

  it('an hp/moved/died event for an unknown escortId is a no-op, not a throw', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;
    expect(() => {
      r.handleEvent({ type: 'escort_moved', escortId: 'ghost', col_fp: toFp(0), row_fp: toFp(0) }, engine.state);
      r.handleEvent({ type: 'escort_hp_changed', escortId: 'ghost', hp: 1, maxHp: 1 }, engine.state);
      r.handleEvent({ type: 'escort_died', escortId: 'ghost' }, engine.state);
      r.handleEvent({ type: 'escort_arrived', escortId: 'ghost' }, engine.state);
    }).not.toThrow();
    renderer.destroy();
  });
});

describe('GameRenderer EventMixin — base-damage vignette', () => {
  it('base_hp_changed for the LOCAL owner flashes the vignette to full and it decays over time', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;
    expect(r.vignetteAlpha).toBe(0);

    r.handleEvent({ type: 'base_hp_changed', owner: 0, hp: 50, maxHp: 100 }, engine.state); // localOwner defaults to 0 (Bottom)
    expect(r.vignetteAlpha).toBe(1);

    renderer.update(1 / 30);
    expect(r.vignetteAlpha).toBeLessThan(1);
    expect(r.vignetteAlpha).toBeGreaterThan(0);
    renderer.destroy();
  });

  it('base_hp_changed for the OPPONENT does not flash the local vignette', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;

    r.handleEvent({ type: 'base_hp_changed', owner: 1, hp: 50, maxHp: 100 }, engine.state);
    expect(r.vignetteAlpha).toBe(0);
    renderer.destroy();
  });
});

describe('GameRenderer EventMixin — spell VFX color follows faction, not the caster', () => {
  it('a local-owner Meteor cast plays the VFX in the friend color', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;
    const play = vi.spyOn(r.vfxSystem, 'play');

    r.handleEvent(
      { type: 'spell_cast', spellType: SpellType.Meteor, owner: 0, center: { col: 3, y_fp: toFp(2) } },
      engine.state,
    );

    expect(play).toHaveBeenCalledWith('meteor', expect.any(Number), expect.any(Number), factionInk.friend);
    renderer.destroy();
  });

  it('an opponent-owner Meteor cast plays the VFX in the enemy color', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;
    const play = vi.spyOn(r.vfxSystem, 'play');

    r.handleEvent(
      { type: 'spell_cast', spellType: SpellType.Meteor, owner: 1, center: { col: 3, y_fp: toFp(2) } },
      engine.state,
    );

    expect(play).toHaveBeenCalledWith('meteor', expect.any(Number), expect.any(Number), factionInk.enemy);
    renderer.destroy();
  });

  it('a Haste cast (no SPELL_VFX entry) does not play any one-shot VFX', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;
    const play = vi.spyOn(r.vfxSystem, 'play');

    r.handleEvent(
      { type: 'spell_cast', spellType: SpellType.Haste, owner: 0, center: { col: 3, y_fp: toFp(2) } },
      engine.state,
    );

    expect(play).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it('a Rockslide cast is routed to the board sweep, not the generic one-shot VFX', () => {
    const { engine, renderer } = buildRenderer();
    const r = renderer as any;
    const play  = vi.spyOn(r.vfxSystem, 'play');
    const sweep = vi.spyOn(r.boardView, 'playRockslideEffect');

    r.handleEvent(
      { type: 'spell_cast', spellType: SpellType.Rockslide, owner: 0, center: { col: 4, y_fp: toFp(0) } },
      engine.state,
    );

    // The single center VFX read as a localized poof; Rockslide now sweeps the whole lane.
    expect(sweep).toHaveBeenCalledWith(4);
    expect(play).not.toHaveBeenCalled();
    renderer.destroy();
  });
});

describe('GameRenderer EventMixin — settlement gate (render-side)', () => {
  it('game_over fires onGameEnd exactly once even if a second game_over event arrives', () => {
    vi.useFakeTimers();
    try {
      const { engine, renderer } = buildRenderer();
      const r = renderer as any;
      const onGameEnd = vi.fn();
      renderer.onGameEnd = onGameEnd;

      const stats = engine.state.snapshotStats();
      const summary = engine.state.snapshotSummary();
      r.handleEvent({ type: 'game_stats', stats, summary }, engine.state);
      r.handleEvent({ type: 'game_over', winner: 0 }, engine.state);
      vi.advanceTimersByTime(2000);
      expect(onGameEnd).toHaveBeenCalledTimes(1);
      expect(onGameEnd).toHaveBeenCalledWith(0, stats, summary);

      // A lingering/duplicate game_over on a later frame (the exact hazard game-over-once.test.ts
      // documents at the engine level) must not fire onGameEnd a second time.
      r.handleEvent({ type: 'game_over', winner: 0 }, engine.state);
      vi.advanceTimersByTime(2000);
      expect(onGameEnd).toHaveBeenCalledTimes(1);
      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

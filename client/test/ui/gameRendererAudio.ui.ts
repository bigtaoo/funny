// Battle audio triggers (AUDIO_DESIGN §7 step 3): the engine-event → cue table wired in
// `render/GameRenderer/events.ts`'s `collectCue`, the same-frame merge, and the one-shot gate that
// keeps the result stinger from machine-gunning after game over.
//
// These assert against a fake `AudioBus` installed through `setAudioBus` — the same seam the web
// backend uses — so no `AudioContext` is involved and nothing here can hear anything. That is the
// point of the split: *which cue, how many times* is unit-testable; *how loud it actually comes out*
// is not (see AUDIO_DESIGN §0's "授权峰值 ≠ 交付峰值" note) and is measured in a real browser instead.
//
// Same headless harness as gameRendererEvents.ui.ts — synthetic GameEvents through `handleEvent`,
// which is exactly what GameRendererCore.update() drains `state.events` into.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel, SpellType } from '../../src/game';
import { toFp } from '@nw/engine/math/fixed';
import { setAudioBus, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus, AudioCue } from '../../src/audio/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Records every `play(cue, count)` the trigger layer emits. */
class RecordingBus implements AudioBus {
  readonly calls: [AudioCue, number][] = [];
  async preload(): Promise<void> {}
  play(cue: AudioCue, count = 1): void { this.calls.push([cue, count]); }
  setSfxVolume(): void {}
  setMusicVolume(): void {}
  resume(): void {}
}

let bus: RecordingBus;

beforeEach(() => { bus = new RecordingBus(); setAudioBus(bus); });
afterEach(() => { setAudioBus(new NullAudioBus()); });

function buildRenderer() {
  const level = getLevel('ch1_lv1')!;
  const { engine } = createLocalMatch({ level });
  const layout = createLayout(800, 1280);
  const renderer = new GameRenderer(engine, layout, new InputManager());
  renderer.init();
  return { engine, renderer, r: renderer as any };
}

/** Drive one frame's worth of events through the same path GameRendererCore.update() uses. */
function frame(r: any, engine: any, events: any[]): void {
  for (const e of events) r.events.handleEvent(e, engine.state);
  r.events.flushAudio();
}

describe('battle audio — engine event → cue table', () => {
  it('maps each battle event onto the cue AUDIO_DESIGN §2.1 assigns it', () => {
    const { engine, renderer, r } = buildRenderer();
    const cases: [any, AudioCue][] = [
      [{ type: 'card_played', owner: 0, handIndex: 0 }, 'sfx.card.play'],
      [{ type: 'unit_attack_start', unitId: 1, targetId: 2 }, 'sfx.unit.attack'],
      [{ type: 'projectile_fired', projectileId: 1, attackerId: 1, from: { col: 2, y_fp: toFp(3) }, kind: 'arrow' }, 'sfx.unit.attack'],
      [{ type: 'unit_attack_hit', unitId: 1, targetId: 2, damage_fp: toFp(5), targetHpRemaining_fp: toFp(10) }, 'sfx.unit.hit'],
      [{ type: 'base_hp_changed', owner: 1, hp_fp: toFp(50), maxHp_fp: toFp(100) }, 'sfx.base.hit'],
      [{ type: 'spell_cast', spellType: SpellType.Meteor, owner: 0, center: { col: 3, y_fp: toFp(4) } }, 'sfx.spell.cast'],
      [{ type: 'unit_died', unitId: 7, pos: { col: 2, y_fp: toFp(3) } }, 'sfx.unit.death'],
      [{ type: 'building_destroyed', buildingId: 4, col: 1, row: 2 }, 'sfx.unit.death'],
      [{ type: 'escort_died', escortId: 'e1' }, 'sfx.unit.death'],
    ];
    for (const [event, cue] of cases) {
      bus.calls.length = 0;
      frame(r, engine, [event]);
      expect(bus.calls, `${event.type} → ${cue}`).toEqual([[cue, 1]]);
    }
    renderer.destroy();
  });

  it('is silent for events the vocabulary has no cue for', () => {
    const { engine, renderer, r } = buildRenderer();
    frame(r, engine, [
      { type: 'projectile_moved', projectileId: 1, col_fp: toFp(2), y_fp: toFp(3) },
      { type: 'building_hp_changed', buildingId: 4, hp_fp: toFp(5), maxHp_fp: toFp(10) },
      { type: 'base_upgraded', owner: 0, level: 1 },
      { type: 'game_countdown_start' },
      { type: 'escort_moved', escortId: 'e1', col_fp: toFp(1), row_fp: toFp(2) },
    ]);
    expect(bus.calls).toEqual([]);
    renderer.destroy();
  });
});

describe('battle audio — same-frame merge (AUDIO_DESIGN §4)', () => {
  it('collapses repeats of one cue into a single call carrying the count', () => {
    const { engine, renderer, r } = buildRenderer();
    // A splash hit lands on four units in the same tick.
    frame(r, engine, [1, 2, 3, 4].map((id) => (
      { type: 'unit_attack_hit', unitId: 9, targetId: id, damage_fp: toFp(5), targetHpRemaining_fp: toFp(1) }
    )));
    expect(bus.calls).toEqual([['sfx.unit.hit', 4]]);
    renderer.destroy();
  });

  it('keeps distinct cues separate and does not carry counts across frames', () => {
    const { engine, renderer, r } = buildRenderer();
    frame(r, engine, [
      { type: 'unit_attack_hit', unitId: 1, targetId: 2, damage_fp: toFp(5), targetHpRemaining_fp: toFp(1) },
      { type: 'unit_attack_hit', unitId: 1, targetId: 3, damage_fp: toFp(5), targetHpRemaining_fp: toFp(1) },
      { type: 'unit_died', unitId: 3, pos: { col: 1, y_fp: toFp(2) } },
    ]);
    expect(bus.calls).toEqual([['sfx.unit.hit', 2], ['sfx.unit.death', 1]]);

    bus.calls.length = 0;
    frame(r, engine, [{ type: 'unit_died', unitId: 4, pos: { col: 1, y_fp: toFp(2) } }]);
    expect(bus.calls).toEqual([['sfx.unit.death', 1]]);
    renderer.destroy();
  });

  it('flushes nothing on a frame with no cue-bearing events', () => {
    const { engine, renderer, r } = buildRenderer();
    frame(r, engine, []);
    frame(r, engine, [{ type: 'game_countdown_start' }]);
    expect(bus.calls).toEqual([]);
    renderer.destroy();
  });
});

describe('battle audio — sfx.ink.tick is a throttled local rising edge', () => {
  /** One `resource_changed` per whole point of ink, exactly as the engine emits them. */
  const inkTo = (r: any, engine: any, ...values: number[]) =>
    values.forEach((ink) => frame(r, engine, [{ type: 'resource_changed', owner: 0, ink }]));

  it('drips once per 10 ink of refill, not once per point', () => {
    const { engine, renderer, r } = buildRenderer();
    // Opening deal: first sighting seeds the baseline without a sound.
    inkTo(r, engine, 5);
    expect(bus.calls).toEqual([]);
    // Nine more points — still under the step, still silent. A drip per event measured 2.6 Hz in a
    // real match, which is a machine gun rather than the 背景节拍 cueCatalogue asks for.
    inkTo(r, engine, 6, 7, 8, 9, 10, 11, 12, 13, 14);
    expect(bus.calls).toEqual([]);
    // The tenth crosses the step.
    inkTo(r, engine, 15);
    expect(bus.calls).toEqual([['sfx.ink.tick', 1]]);
    // …and the counter restarts, so the next drip is another 10 away.
    bus.calls.length = 0;
    inkTo(r, engine, 16, 17, 18, 19, 20, 21, 22, 23, 24);
    expect(bus.calls).toEqual([]);
    inkTo(r, engine, 25);
    expect(bus.calls).toEqual([['sfx.ink.tick', 1]]);
    renderer.destroy();
  });

  it('never drips on a spend, and a spend does not consume accumulated refill', () => {
    const { engine, renderer, r } = buildRenderer();
    inkTo(r, engine, 20);                          // seed
    inkTo(r, engine, 21, 22, 23, 24, 25);          // +5
    inkTo(r, engine, 13);                          // played a card: -12, silent
    expect(bus.calls).toEqual([]);
    inkTo(r, engine, 14, 15, 16, 17);              // +4 more → 9 total, still under the step
    expect(bus.calls).toEqual([]);
    inkTo(r, engine, 18);                          // 10th point of refill
    expect(bus.calls).toEqual([['sfx.ink.tick', 1]]);
    renderer.destroy();
  });

  it("ignores the opponent's ink entirely", () => {
    const { engine, renderer, r } = buildRenderer();
    frame(r, engine, Array.from({ length: 40 }, (_, i) => (
      { type: 'resource_changed', owner: 1, ink: i + 1 }
    )));
    expect(bus.calls).toEqual([]);
    renderer.destroy();
  });
});

describe('battle audio — result stinger one-shot gate', () => {
  it('plays victory once, then stays silent while the same batch is re-drained', () => {
    const { engine, renderer, r } = buildRenderer();
    // localOwner defaults to 0 (Bottom).
    frame(r, engine, [
      { type: 'unit_died', unitId: 1, pos: { col: 1, y_fp: toFp(2) } },
      { type: 'game_over', winner: 0 },
    ]);
    expect(bus.calls).toEqual([['sfx.unit.death', 1], ['sfx.result.victory', 1]]);

    // The exact hazard: after game over the engine's step() returns early WITHOUT clearing
    // state.events, so a stalled driver can hand the identical batch back every frame. Nothing —
    // neither the stinger nor the death that preceded it — may fire again.
    bus.calls.length = 0;
    for (let i = 0; i < 60; i++) {
      frame(r, engine, [
        { type: 'unit_died', unitId: 1, pos: { col: 1, y_fp: toFp(2) } },
        { type: 'game_over', winner: 0 },
      ]);
    }
    expect(bus.calls).toEqual([]);
    renderer.destroy();
  });

  it('plays defeat when the winner is the other side', () => {
    const { engine, renderer, r } = buildRenderer();
    frame(r, engine, [{ type: 'game_over', winner: 1 }]);
    expect(bus.calls).toEqual([['sfx.result.defeat', 1]]);
    renderer.destroy();
  });

  it('plays the draw stinger — its own outcome, not a quieter win', () => {
    // Was asserted SILENT until 2026-08-31: the vocabulary had only victory/defeat, and either one
    // would have reported the wrong result, so a draw ended the match with no sound at all.
    const { engine, renderer, r } = buildRenderer();
    frame(r, engine, [{ type: 'game_draw' }]);
    expect(bus.calls).toEqual([['sfx.result.draw', 1]]);
    renderer.destroy();
  });

  it('a re-drained draw does not machine-gun the stinger', () => {
    // Same hazard as game_over: after the match ends the engine's step() returns early WITHOUT
    // clearing the queue, so a stalled driver hands the final frame's whole batch back every frame.
    // The draw branch's stinger therefore has to sit inside the `gameEnded` one-shot gate, not in
    // collectCue() — at 60 fps a naive trigger is 60 stingers a second.
    const { engine, renderer, r } = buildRenderer();
    for (let i = 0; i < 5; i++) frame(r, engine, [{ type: 'game_draw' }]);
    expect(bus.calls).toEqual([['sfx.result.draw', 1]]);
    renderer.destroy();
  });

  it('gates every later battle cue too, not just the stinger', () => {
    const { engine, renderer, r } = buildRenderer();
    frame(r, engine, [{ type: 'game_over', winner: 0 }]);
    bus.calls.length = 0;
    frame(r, engine, [
      { type: 'unit_attack_hit', unitId: 1, targetId: 2, damage_fp: toFp(5), targetHpRemaining_fp: toFp(1) },
      { type: 'base_hp_changed', owner: 0, hp_fp: toFp(10), maxHp_fp: toFp(100) },
      { type: 'card_played', owner: 0, handIndex: 0 },
    ]);
    expect(bus.calls).toEqual([]);
    renderer.destroy();
  });

  it('scripted tutorial victory gets the same stinger, exactly once', () => {
    const { renderer, r } = buildRenderer();
    r.core.forceTutorialVictory();
    r.core.forceTutorialVictory();
    expect(bus.calls).toEqual([['sfx.result.victory', 1]]);
    renderer.destroy();
  });
});
